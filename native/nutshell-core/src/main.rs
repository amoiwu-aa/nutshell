mod protocol;

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use bytes::Bytes;
use protocol::{
    ChmodPathParams, CoreEvent, CoreRequest, CoreResponse, DockerExecParams, DockerLogStreamParams,
    ForwardRemoveParams, ListDirParams, MkdirParams, MonitorSnapshotParams, MovePathParams, PortForwardRuleParams,
    ProjectRootParams, ReadBinaryFileParams, ReadFileParams, ReadMultipleFilesParams,
    RemovePathParams, ResizeParams, RunCommandParams, SearchParams, SessionIdParams,
    SshConnectParams, StatPathParams, WriteBinaryFileParams, WriteFileParams, WriteParams,
};
use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt as TokioAsyncReadExt, AsyncSeekExt, AsyncWriteExt as TokioAsyncWriteExt};
use serde_json::json;
use tokio::io::{self};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};

type OutputSender = mpsc::UnboundedSender<OutputMessage>;
type Sessions = Arc<Mutex<HashMap<String, RustSshSession>>>;
type SftpCache = Arc<Mutex<HashMap<String, Arc<SftpSession>>>>;
type StreamTasks = Arc<Mutex<HashMap<String, Arc<tokio::task::JoinHandle<()>>>>>;

enum OutputMessage {
    Event(CoreEvent),
    Response(CoreResponse),
}

struct RustSshSession {
    channel: Arc<Mutex<russh::ChannelWriteHalf<russh::client::Msg>>>,
    session_handle: Arc<Mutex<Handle<ClientHandler>>>,
    remote_forwards: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
    session_info: SessionInfo,
}

#[derive(Clone)]
struct PortForwardRecord {
    rule: PortForwardRuleParams,
    task: Option<Arc<tokio::task::JoinHandle<()>>>,
    remote_binding: Option<(String, u32, Arc<Mutex<Handle<ClientHandler>>>)>,
}

type Forwards = Arc<Mutex<HashMap<String, PortForwardRecord>>>;

#[derive(Clone)]
struct SessionInfo {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
}

#[derive(Clone)]
struct ClientHandler {
    remote_forwards: Arc<Mutex<HashMap<(String, u32), (String, u16)>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = {
            let guard = self.remote_forwards.lock().await;
            guard
                .get(&(connected_address.to_string(), connected_port))
                .cloned()
        };

        if let Some((local_host, local_port)) = target {
            tokio::spawn(async move {
                if let Ok(mut socket) = tokio::net::TcpStream::connect((local_host.as_str(), local_port)).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            });
        }

        Ok(())
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        let mut stdout = io::stdout();
        let _ = emit_event(
            &mut stdout,
            &CoreEvent::Log {
                level: "error".to_string(),
                message: format!("nutshell-core fatal error: {error:#}"),
            },
        )
        .await;
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let sftp_cache: SftpCache = Arc::new(Mutex::new(HashMap::new()));
    let forwards: Forwards = Arc::new(Mutex::new(HashMap::new()));
    let stream_tasks: StreamTasks = Arc::new(Mutex::new(HashMap::new()));
    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<OutputMessage>();

    output_tx
        .send(OutputMessage::Event(CoreEvent::Ready {
            version: env!("CARGO_PKG_VERSION").to_string(),
        }))
        .ok();

    let stdout_task = tokio::spawn(async move {
        let mut stdout = io::stdout();
        while let Some(message) = output_rx.recv().await {
            let result = match message {
                OutputMessage::Event(event) => emit_event(&mut stdout, &event).await,
                OutputMessage::Response(response) => write_response(&mut stdout, &response).await,
            };
            if result.is_err() {
                break;
            }
        }
    });

    let mut stdin = io::stdin();

    loop {
        let Some(line) = read_frame(&mut stdin).await? else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }

        let request: CoreRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let response = CoreResponse::error(
                    None,
                    "invalid_request",
                    format!("Failed to parse request JSON: {error}"),
                );
                output_tx.send(OutputMessage::Response(response)).ok();
                continue;
            }
        };

        let request_sessions = sessions.clone();
        let request_sftp_cache = sftp_cache.clone();
        let request_forwards = forwards.clone();
        let request_streams = stream_tasks.clone();
        let request_output = output_tx.clone();
        tokio::spawn(async move {
            let response = handle_request(request, request_sessions, request_sftp_cache, request_forwards, request_streams, request_output.clone()).await;
            request_output.send(OutputMessage::Response(response)).ok();
        });
    }

    drop(output_tx);
    let _ = stdout_task.await;
    Ok(())
}

async fn handle_request(request: CoreRequest, sessions: Sessions, sftp_cache: SftpCache, forwards: Forwards, streams: StreamTasks, output_tx: OutputSender) -> CoreResponse {
    match request.method.as_str() {
        "core.ping" => CoreResponse::success(
            request.id,
            json!({
                "pong": true,
                "version": env!("CARGO_PKG_VERSION"),
                "capabilities": {
                "sshCore": true,
                "sessionStreaming": true,
                "structuredTools": true,
                "sftp": true
                }
            }),
        ),
        "ssh.plan" => CoreResponse::success(
            request.id,
            json!({
                "status": "active",
                "message": "russh-based SSH shell core is active. Structured AI remote tools will build on top of this transport.",
            }),
        ),
        "ssh.connect" => {
            let params: SshConnectParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.connect params: {error}"),
                    )
                }
            };

            match connect_session(params, sessions, sftp_cache, output_tx).await {
                Ok(session_id) => CoreResponse::success(request.id, json!({ "sessionId": session_id })),
                Err(error) => CoreResponse::error(request.id, "ssh_connect_failed", format!("{error:#}")),
            }
        }
        "ssh.disconnect" => {
            let params: SessionIdParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.disconnect params: {error}"),
                    )
                }
            };

            match disconnect_session(&params.session_id, sessions, sftp_cache, forwards, output_tx.clone()).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "disconnected": true })),
                Err(error) => CoreResponse::error(request.id, "ssh_disconnect_failed", error.to_string()),
            }
        }
        "ssh.write" => {
            let params: WriteParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.write params: {error}"),
                    )
                }
            };

            match write_to_session(&params.session_id, &params.data, sessions).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "written": true })),
                Err(error) => CoreResponse::error(request.id, "ssh_write_failed", error.to_string()),
            }
        }
        "ssh.resize" => {
            let params: ResizeParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.resize params: {error}"),
                    )
                }
            };

            match resize_session(&params.session_id, params.cols, params.rows, sessions).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "resized": true })),
                Err(error) => CoreResponse::error(request.id, "ssh_resize_failed", error.to_string()),
            }
        }
        "ssh.portForward.create" => {
            let params: PortForwardRuleParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.portForward.create params: {error}"),
                    )
                }
            };

            match create_port_forward(params, sessions, forwards, output_tx.clone()).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "created": true })),
                Err(error) => CoreResponse::error(request.id, "ssh_port_forward_create_failed", format!("{error:#}")),
            }
        }
        "ssh.portForward.remove" => {
            let params: ForwardRemoveParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.portForward.remove params: {error}"),
                    )
                }
            };

            match remove_port_forward(&params.rule_id, sessions, forwards, output_tx.clone()).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "removed": true })),
                Err(error) => CoreResponse::error(request.id, "ssh_port_forward_remove_failed", format!("{error:#}")),
            }
        }
        "ssh.portForward.list" => {
            let params: SessionIdParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode ssh.portForward.list params: {error}"),
                    )
                }
            };

            match list_port_forwards(&params.session_id, forwards).await {
                Ok(rules) => CoreResponse::success(request.id, json!({ "rules": rules })),
                Err(error) => CoreResponse::error(request.id, "ssh_port_forward_list_failed", format!("{error:#}")),
            }
        }
        "docker.exec.start" => {
            let params: DockerExecParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode docker.exec.start params: {error}"),
                    )
                }
            };

            match start_docker_exec(params, sessions, output_tx.clone()).await {
                Ok(exec_session_id) => CoreResponse::success(request.id, json!({ "execSessionId": exec_session_id })),
                Err(error) => CoreResponse::error(request.id, "docker_exec_start_failed", format!("{error:#}")),
            }
        }
        "docker.logs.start" => {
            let params: DockerLogStreamParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode docker.logs.start params: {error}"),
                    )
                }
            };

            match start_docker_log_stream(params, sessions, streams, output_tx.clone()).await {
                Ok(stream_id) => CoreResponse::success(request.id, json!({ "streamId": stream_id })),
                Err(error) => CoreResponse::error(request.id, "docker_logs_start_failed", format!("{error:#}")),
            }
        }
        "docker.logs.stop" => {
            let params: ForwardRemoveParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode docker.logs.stop params: {error}"),
                    )
                }
            };

            match stop_stream_task(&params.rule_id, streams).await {
                Ok(()) => CoreResponse::success(request.id, json!({ "stopped": true })),
                Err(error) => CoreResponse::error(request.id, "docker_logs_stop_failed", format!("{error:#}")),
            }
        }
        "tool.runCommand" => {
            let params: RunCommandParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.runCommand params: {error}"),
                    )
                }
            };

            match run_command(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_run_command_failed", format!("{error:#}")),
            }
        }
        "tool.listDir" => {
            let params: ListDirParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.listDir params: {error}"),
                    )
                }
            };

            match list_dir(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_list_dir_failed", format!("{error:#}")),
            }
        }
        "tool.readFile" => {
            let params: ReadFileParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.readFile params: {error}"),
                    )
                }
            };

            match read_file(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_read_file_failed", format!("{error:#}")),
            }
        }
        "tool.readBinaryFile" => {
            let params: ReadBinaryFileParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.readBinaryFile params: {error}"),
                    )
                }
            };

            match read_binary_file(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_read_binary_file_failed", format!("{error:#}")),
            }
        }
        "tool.search" => {
            let params: SearchParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.search params: {error}"),
                    )
                }
            };

            match search(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_search_failed", format!("{error:#}")),
            }
        }
        "tool.writeFile" => {
            let params: WriteFileParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.writeFile params: {error}"),
                    )
                }
            };

            match write_file(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_write_file_failed", format!("{error:#}")),
            }
        }
        "tool.writeBinaryFile" => {
            let params: WriteBinaryFileParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.writeBinaryFile params: {error}"),
                    )
                }
            };

            match write_binary_file(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_write_binary_file_failed", format!("{error:#}")),
            }
        }
        "tool.statPath" => {
            let params: StatPathParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.statPath params: {error}"),
                    )
                }
            };

            match stat_path(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_stat_path_failed", format!("{error:#}")),
            }
        }
        "tool.mkdir" => {
            let params: MkdirParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.mkdir params: {error}"),
                    )
                }
            };

            match mkdir(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_mkdir_failed", format!("{error:#}")),
            }
        }
        "tool.removePath" => {
            let params: RemovePathParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.removePath params: {error}"),
                    )
                }
            };

            match remove_path(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_remove_path_failed", format!("{error:#}")),
            }
        }
        "tool.movePath" => {
            let params: MovePathParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.movePath params: {error}"),
                    )
                }
            };

            match move_path(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_move_path_failed", format!("{error:#}")),
            }
        }
        "tool.chmodPath" => {
            let params: ChmodPathParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.chmodPath params: {error}"),
                    )
                }
            };

            match chmod_path(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_chmod_path_failed", format!("{error:#}")),
            }
        }
        "tool.readMultipleFiles" => {
            let params: ReadMultipleFilesParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.readMultipleFiles params: {error}"),
                    )
                }
            };

            match read_multiple_files(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_read_multiple_files_failed", format!("{error:#}")),
            }
        }
        "tool.scanProject" => {
            let params: ProjectRootParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.scanProject params: {error}"),
                    )
                }
            };

            match scan_project(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_scan_project_failed", format!("{error:#}")),
            }
        }
        "tool.projectSummary" => {
            let params: ProjectRootParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.projectSummary params: {error}"),
                    )
                }
            };

            match project_summary(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_project_summary_failed", format!("{error:#}")),
            }
        }
        "tool.monitorSnapshot" => {
            let params: MonitorSnapshotParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    return CoreResponse::error(
                        request.id,
                        "invalid_params",
                        format!("Failed to decode tool.monitorSnapshot params: {error}"),
                    )
                }
            };

            match monitor_snapshot(params, sessions, sftp_cache).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_monitor_snapshot_failed", format!("{error:#}")),
            }
        }
        _ => CoreResponse::error(
            request.id,
            "method_not_implemented",
            format!("Method '{}' is not implemented yet", request.method),
        ),
    }
}

async fn connect_session(
    params: SshConnectParams,
    sessions: Sessions,
    sftp_cache: SftpCache,
    output_tx: OutputSender,
) -> anyhow::Result<String> {
    let remote_forwards = Arc::new(Mutex::new(HashMap::new()));
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut handle = client::connect(config, (params.host.as_str(), params.port), ClientHandler { remote_forwards: remote_forwards.clone() })
        .await
        .context("Failed to establish russh client connection")?;

    match params.auth_type.as_str() {
        "password" => {
            let password = params.password.as_deref().ok_or_else(|| anyhow!("Missing password"))?;
            let auth = handle
                .authenticate_password(params.username.clone(), password)
                .await
                .context("Password authentication failed")?;
            if !auth.success() {
                return Err(anyhow!("Password authentication rejected by server"));
            }
        }
        "key" | "keyWithPassphrase" => {
            let key_path = params
                .private_key_path
                .as_deref()
                .ok_or_else(|| anyhow!("Missing private key path"))?;
            let key = load_secret_key(Path::new(key_path), params.passphrase.as_deref())
                .with_context(|| format!("Failed to load private key from {key_path}"))?;
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let auth = handle
                .authenticate_publickey(
                    params.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .context("Public key authentication failed")?;
            if !auth.success() {
                return Err(anyhow!("Public key authentication rejected by server"));
            }
        }
        other => return Err(anyhow!("Unsupported auth type: {other}")),
    }

    let session_handle = Arc::new(Mutex::new(handle));

    let channel: russh::Channel<Msg> = {
        let handle_guard = session_handle.lock().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            handle_guard.channel_open_session(),
        )
        .await
        .map_err(|_| anyhow!("Timed out opening SSH shell channel"))?
        .context("Failed to open SSH session channel")?
    };
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .context("Failed to request PTY")?;

    if params.ai_compatibility_mode.unwrap_or(false) {
        channel.set_env(false, "TERM", "xterm-256color").await.ok();
        channel.set_env(false, "COLORTERM", "truecolor").await.ok();
        channel.set_env(false, "TERM_PROGRAM", "Nutshell").await.ok();
        channel.set_env(false, "FORCE_COLOR", "1").await.ok();
    }

    channel
        .request_shell(true)
        .await
        .context("Failed to request remote shell")?;

    let (mut reader, writer) = channel.split();
    let writer = Arc::new(Mutex::new(writer));
    let session_id = params.session_id.clone();

    {
        let mut guard = sessions.lock().await;
        guard.insert(
            params.session_id.clone(),
            RustSshSession {
                channel: writer.clone(),
                session_handle: session_handle.clone(),
                remote_forwards: remote_forwards.clone(),
                session_info: SessionInfo {
                    host: params.host.clone(),
                    port: params.port,
                    username: params.username.clone(),
                    auth_type: params.auth_type.clone(),
                    password: params.password.clone(),
                    private_key_path: params.private_key_path.clone(),
                    passphrase: params.passphrase.clone(),
                },
            },
        );
    }

    let reader_sftp_cache = sftp_cache.clone();
    tokio::spawn(async move {
        let mut sent_close = false;
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let text = String::from_utf8_lossy(&data).to_string();
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshData {
                        session_id: session_id.clone(),
                        data: text,
                    }));
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::Log {
                        level: "info".to_string(),
                        message: format!("SSH session {} exited with status {exit_status}", session_id),
                    }));
                }
                ChannelMsg::Close | ChannelMsg::Eof => {
                    {
                        let mut guard = sessions.lock().await;
                        guard.remove(&session_id);
                    }
                    {
                        let mut cache = reader_sftp_cache.lock().await;
                        cache.remove(&session_id);
                    }
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshClose {
                        session_id: session_id.clone(),
                    }));
                    sent_close = true;
                    break;
                }
                ChannelMsg::ExitSignal { error_message, .. } => {
                    {
                        let mut guard = sessions.lock().await;
                        guard.remove(&session_id);
                    }
                    {
                        let mut cache = reader_sftp_cache.lock().await;
                        cache.remove(&session_id);
                    }
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshError {
                        session_id: session_id.clone(),
                        error: error_message,
                    }));
                    sent_close = true;
                    break;
                }
                _ => {}
            }
        }

        // reader.wait() returned None — connection died ungracefully
        {
            let mut guard = sessions.lock().await;
            guard.remove(&session_id);
        }
        {
            let mut cache = reader_sftp_cache.lock().await;
            cache.remove(&session_id);
        }
        if !sent_close {
            let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshClose {
                session_id: session_id.clone(),
            }));
        }
    });

    Ok(params.session_id)
}

async fn disconnect_session(session_id: &str, sessions: Sessions, sftp_cache: SftpCache, forwards: Forwards, output_tx: OutputSender) -> Result<(), String> {
    // Clear cached SFTP session
    {
        let mut cache = sftp_cache.lock().await;
        cache.remove(session_id);
    }
    cleanup_port_forwards_for_session(session_id, sessions.clone(), forwards, output_tx).await;
    let session = {
        let mut guard = sessions.lock().await;
        guard.remove(session_id)
    }
    .ok_or_else(|| "Session not found".to_string())?;

    {
        let channel = session.channel.lock().await;
        channel.close().await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn list_port_forwards(session_id: &str, forwards: Forwards) -> anyhow::Result<Vec<PortForwardRuleParams>> {
    let guard = forwards.lock().await;
    Ok(guard
        .values()
        .filter(|record| record.rule.connection_id == session_id)
        .map(|record| record.rule.clone())
        .collect())
}

async fn remove_port_forward(rule_id: &str, sessions: Sessions, forwards: Forwards, output_tx: OutputSender) -> anyhow::Result<()> {
    let record = {
        let mut guard = forwards.lock().await;
        guard.remove(rule_id)
    };

    if let Some(record) = record {
        if let Some(task) = record.task {
            task.abort();
        }
        if let Some((address, port, handle)) = record.remote_binding {
            let handle_guard = handle.lock().await;
            let _ = handle_guard.cancel_tcpip_forward(address, port).await;
            let remote_forwards = {
                let guard = sessions.lock().await;
                guard.get(&record.rule.connection_id).map(|session| Arc::clone(&session.remote_forwards))
            };
            if let Some(remote_forwards) = remote_forwards {
                let mut rf = remote_forwards.lock().await;
                rf.remove(&(record.rule.remote_host.clone(), port));
            }
        }
        output_tx.send(OutputMessage::Event(CoreEvent::PortForwardStatus {
            rule_id: record.rule.id,
            status: "stopped".to_string(),
        })).ok();
    }

    Ok(())
}

async fn cleanup_port_forwards_for_session(session_id: &str, sessions: Sessions, forwards: Forwards, output_tx: OutputSender) {
    let forward_ids: Vec<String> = {
        let guard = forwards.lock().await;
        guard.values()
            .filter(|record| record.rule.connection_id == session_id)
            .map(|record| record.rule.id.clone())
            .collect()
    };

    for rule_id in forward_ids {
        let _ = remove_port_forward(&rule_id, sessions.clone(), forwards.clone(), output_tx.clone()).await;
    }
}

async fn create_port_forward(
    rule: PortForwardRuleParams,
    sessions: Sessions,
    forwards: Forwards,
    output_tx: OutputSender,
) -> anyhow::Result<()> {
    remove_port_forward(&rule.id, sessions.clone(), forwards.clone(), output_tx.clone()).await.ok();

    let session_handle = {
        let guard = sessions.lock().await;
        guard.get(&rule.connection_id)
            .map(|session| Arc::clone(&session.session_handle))
            .ok_or_else(|| anyhow!("Session not found"))?
    };
    let remote_forwards = {
        let guard = sessions.lock().await;
        guard.get(&rule.connection_id)
            .map(|session| Arc::clone(&session.remote_forwards))
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    if rule.r#type == "remote" {
        let actual_port = {
            let handle_guard = session_handle.lock().await;
            handle_guard
                .tcpip_forward(rule.remote_host.clone(), rule.remote_port as u32)
                .await
                .with_context(|| format!("Failed to request remote forward {}:{}", rule.remote_host, rule.remote_port))?
        };

        {
            let mut rf = remote_forwards.lock().await;
            rf.insert((rule.remote_host.clone(), actual_port), (rule.local_host.clone(), rule.local_port));
        }

        {
            let mut guard = forwards.lock().await;
            guard.insert(rule.id.clone(), PortForwardRecord {
                rule: PortForwardRuleParams {
                    remote_port: actual_port as u16,
                    ..rule.clone()
                },
                task: None,
                remote_binding: Some((rule.remote_host.clone(), actual_port, session_handle.clone())),
            });
        }

        output_tx.send(OutputMessage::Event(CoreEvent::PortForwardStatus {
            rule_id: rule.id.clone(),
            status: "active".to_string(),
        })).ok();

        return Ok(());
    }

    let task_rule = rule.clone();
    let task_output = output_tx.clone();
    let task = tokio::spawn(async move {
        let status = match task_rule.r#type.as_str() {
            "local" | "dynamic" => run_local_like_forward(task_rule.clone(), session_handle, task_output.clone()).await,
            other => Err(anyhow!("Unsupported port forward type: {other}")),
        };

        if let Err(error) = status {
            task_output.send(OutputMessage::Event(CoreEvent::PortForwardStatus {
                rule_id: task_rule.id.clone(),
                status: format!("error: {error}"),
            })).ok();
        }
    });

    {
        let mut guard = forwards.lock().await;
        guard.insert(rule.id.clone(), PortForwardRecord {
            rule: rule.clone(),
            task: Some(Arc::new(task)),
            remote_binding: None,
        });
    }

    output_tx.send(OutputMessage::Event(CoreEvent::PortForwardStatus {
        rule_id: rule.id.clone(),
        status: "active".to_string(),
    })).ok();

    Ok(())
}

async fn run_local_like_forward(
    rule: PortForwardRuleParams,
    session_handle: Arc<Mutex<Handle<ClientHandler>>>,
    output_tx: OutputSender,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind((rule.local_host.as_str(), rule.local_port)).await
        .with_context(|| format!("Failed to bind local port {}:{}", rule.local_host, rule.local_port))?;

    loop {
        let (mut local_stream, _) = listener.accept().await?;
        let handle = session_handle.clone();
        let rule_clone = rule.clone();
        let output_clone = output_tx.clone();

        tokio::spawn(async move {
            let result = async {
                let channel = {
                    let handle_guard = handle.lock().await;
                    if rule_clone.r#type == "dynamic" {
                        let mut buf = [0_u8; 262];
                        let n = local_stream.read(&mut buf).await?;
                        if n < 7 || buf[0] != 0x05 {
                            return Err(anyhow!("Invalid SOCKS5 handshake"));
                        }
                        local_stream.write_all(&[0x05, 0x00]).await?;

                        let req_n = local_stream.read(&mut buf).await?;
                        if req_n < 7 || buf[0] != 0x05 || buf[1] != 0x01 {
                            return Err(anyhow!("Unsupported SOCKS5 request"));
                        }

                        let atyp = buf[3];
                        let (dest_host, port_index) = match atyp {
                            0x01 => {
                                let host = format!("{}.{}.{}.{}", buf[4], buf[5], buf[6], buf[7]);
                                (host, 8)
                            }
                            0x03 => {
                                let len = buf[4] as usize;
                                let host = String::from_utf8_lossy(&buf[5..5 + len]).to_string();
                                (host, 5 + len)
                            }
                            _ => return Err(anyhow!("Unsupported SOCKS5 address type")),
                        };
                        let dest_port = u16::from_be_bytes([buf[port_index], buf[port_index + 1]]);
                        let channel = handle_guard.channel_open_direct_tcpip(dest_host, dest_port as u32, rule_clone.local_host.clone(), rule_clone.local_port as u32).await?;
                        local_stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
                        channel
                    } else {
                        handle_guard.channel_open_direct_tcpip(rule_clone.remote_host.clone(), rule_clone.remote_port as u32, rule_clone.local_host.clone(), rule_clone.local_port as u32).await?
                    }
                };

                let mut ssh_stream = channel.into_stream();
                tokio::io::copy_bidirectional(&mut local_stream, &mut ssh_stream).await?;
                Ok::<(), anyhow::Error>(())
            }.await;

            if let Err(error) = result {
                output_clone.send(OutputMessage::Event(CoreEvent::PortForwardStatus {
                    rule_id: rule_clone.id.clone(),
                    status: format!("error: {error}"),
                })).ok();
            }
        });
    }
}

async fn write_to_session(session_id: &str, data: &str, sessions: Sessions) -> Result<(), String> {
    let channel = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| Arc::clone(&session.channel))
            .ok_or_else(|| "Session not found".to_string())?
    };

    let writer = channel.lock().await;
    let payload = Cursor::new(Bytes::copy_from_slice(data.as_bytes()));
    match tokio::time::timeout(Duration::from_secs(5), writer.data(payload)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Write timed out".to_string()),
    }
}

async fn resize_session(
    session_id: &str,
    cols: u32,
    rows: u32,
    sessions: Sessions,
) -> Result<(), String> {
    let channel = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| Arc::clone(&session.channel))
            .ok_or_else(|| "Session not found".to_string())?
    };

    let writer = channel.lock().await;
    match tokio::time::timeout(Duration::from_secs(5), writer.window_change(cols, rows, 0, 0)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Resize timed out".to_string()),
    }
}

async fn run_command(params: RunCommandParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let risk = assess_command_risk(&params.command);
    if risk.requires_confirmation && !params.require_confirmation.unwrap_or(false) {
        return Ok(json!({
            "command": params.command,
            "stdout": "",
            "stderr": "",
            "exitCode": null,
            "durationMs": 0,
            "riskLevel": risk.risk_level,
            "requiresConfirmation": true,
            "blocked": true,
            "reason": risk.reason,
        }));
    }

    let mut command = String::new();

    if let Some(cwd) = params.cwd {
        command.push_str(&format!("cd {} && ", shell_escape(&cwd)));
    }

    if let Some(env) = params.env {
        for entry in env {
            command.push_str(&format!("{}={} ", entry.key, shell_escape(&entry.value)));
        }
    }

    command.push_str(&params.command);

    let output = exec_capture(
        &params.session_id,
        &command,
        params.timeout_ms.unwrap_or(15_000),
        sessions,
    )
    .await?;

    Ok(json!({
        "command": params.command,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
        "durationMs": output.duration_ms,
        "riskLevel": risk.risk_level,
        "requiresConfirmation": risk.requires_confirmation,
        "blocked": false,
        "reason": risk.reason,
    }))
}

async fn list_dir(params: ListDirParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    let mut entries = Vec::new();
    let dir = sftp.read_dir(params.path.clone()).await?;
    for entry in dir {
        let filename = entry.file_name();
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let size = meta.len();
        let mode = meta.permissions().to_string();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d: std::time::Duration| d.as_secs())
            .unwrap_or(0);
        let full_path = if params.path.ends_with('/') {
            format!("{}{}", params.path, filename)
        } else {
            format!("{}/{}", params.path, filename)
        };
        entries.push(json!({
            "name": filename,
            "path": full_path,
            "isDir": is_dir,
            "size": size,
            "mode": mode,
            "mtime": mtime
        }));
    }
    Ok(json!({ "entries": entries }))
}

async fn read_file(params: ReadFileParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let max_bytes = params.max_bytes.unwrap_or(128 * 1024);
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;

    // Get file size first, then only read what we need
    let metadata = sftp.metadata(params.path.clone()).await?;
    let size = metadata.len() as usize;
    let read_bytes = std::cmp::min(size, max_bytes);
    let truncated = size > max_bytes;

    let mut file = sftp.open(params.path.clone()).await?;
    let mut buf = vec![0_u8; read_bytes];
    let mut total_read = 0usize;
    while total_read < read_bytes {
        let n = file.read(&mut buf[total_read..]).await?;
        if n == 0 {
            break;
        }
        total_read += n;
    }
    buf.truncate(total_read);

    let content = String::from_utf8_lossy(&buf).to_string();
    Ok(json!({
        "content": content,
        "truncated": truncated,
        "size": size,
    }))
}

async fn read_binary_file(
    params: ReadBinaryFileParams,
    sessions: Sessions,
    sftp_cache: SftpCache,
) -> anyhow::Result<serde_json::Value> {
    let max_bytes = params.max_bytes.unwrap_or(1024 * 1024);
    let offset = params.offset.unwrap_or(0);
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    let metadata = sftp.metadata(params.path.clone()).await?;
    let size = metadata.len();
    let mut file = sftp.open(params.path.clone()).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut decoded = vec![0_u8; max_bytes];
    let mut total_read = 0usize;
    while total_read < max_bytes {
        let n = file.read(&mut decoded[total_read..]).await?;
        if n == 0 {
            break;
        }
        total_read += n;
    }
    decoded.truncate(total_read);
    let bytes_read = decoded.len() as u64;
    Ok(json!({
        "contentBase64": BASE64_STANDARD.encode(decoded),
        "size": size,
        "bytesRead": bytes_read,
        "eof": offset + bytes_read >= size,
    }))
}

async fn search(params: SearchParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let limit = params.limit.unwrap_or(100);
    let command = format!(
        "python3 - <<'PY'\nimport json, os, re\nroot = {}\npattern = re.compile({}, re.IGNORECASE)\nlimit = {}\nresults = []\nfor base, _, files in os.walk(root):\n    for name in files:\n        path = os.path.join(base, name)\n        try:\n            with open(path, 'r', encoding='utf-8', errors='replace') as f:\n                for idx, line in enumerate(f, start=1):\n                    if pattern.search(line):\n                        results.append({{\"path\": path, \"line\": idx, \"preview\": line.rstrip('\\n')}})\n                        if len(results) >= limit:\n                            print(json.dumps(results, ensure_ascii=False))\n                            raise SystemExit\n        except Exception:\n            pass\nprint(json.dumps(results, ensure_ascii=False))\nPY",
        python_string(&params.root_path),
        python_string(&params.pattern),
        limit
    );
    let output = exec_capture(&params.session_id, &command, 20_000, sessions).await?;
    let matches = parse_json_stdout(&output.stdout)?;
    Ok(json!({ "matches": matches }))
}

async fn write_file(params: WriteFileParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    if params.create_dirs.unwrap_or(false) {
        if let Some(parent) = Path::new(&params.path).parent() {
            create_dir_all_sftp(&sftp, parent).await.ok();
        }
    }
    let mut file = sftp.create(params.path.clone()).await?;
    file.write_all(params.content.as_bytes()).await?;
    file.flush().await?;
    Ok(json!({
        "path": params.path,
        "written": params.content.len()
    }))
}

async fn write_binary_file(
    params: WriteBinaryFileParams,
    sessions: Sessions,
    sftp_cache: SftpCache,
) -> anyhow::Result<serde_json::Value> {
    let content = BASE64_STANDARD
        .decode(params.content_base64.as_bytes())
        .context("Failed to decode base64 file content")?;
    let sftp = open_sftp_session(&params.session_id, sessions.clone(), sftp_cache.clone()).await?;
    if params.create_dirs.unwrap_or(false) {
        if let Some(parent) = Path::new(&params.path).parent() {
            create_dir_all_sftp(&sftp, parent).await.ok();
        }
    }

    let mut file = if params.append.unwrap_or(false) {
        let mut file = sftp.open_with_flags(
            params.path.clone(),
            russh_sftp::protocol::OpenFlags::CREATE
                | russh_sftp::protocol::OpenFlags::WRITE
                | russh_sftp::protocol::OpenFlags::READ,
        ).await?;
        file.seek(std::io::SeekFrom::End(0)).await?;
        file
    } else {
        sftp.open_with_flags(
            params.path.clone(),
            russh_sftp::protocol::OpenFlags::CREATE
                | russh_sftp::protocol::OpenFlags::TRUNCATE
                | russh_sftp::protocol::OpenFlags::WRITE
                | russh_sftp::protocol::OpenFlags::READ,
        ).await?
    };
    file.write_all(&content).await?;
    file.flush().await?;
    Ok(json!({
        "path": params.path,
        "written": content.len()
    }))
}

async fn stat_path(params: StatPathParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    let metadata = match sftp.symlink_metadata(params.path.clone()).await {
        Ok(meta) => meta,
        Err(_) => return Ok(json!({ "exists": false })),
    };
    let file_type = metadata.file_type();
    let kind_dir = file_type.is_dir();
    let kind_file = file_type.is_file();
    let kind_symlink = file_type.is_symlink();
    let mode = metadata.permissions().to_string();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t: std::time::SystemTime| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d: std::time::Duration| d.as_secs())
        .unwrap_or(0);
    Ok(json!({
        "exists": true,
        "path": params.path,
        "isDir": kind_dir,
        "isFile": kind_file,
        "isSymlink": kind_symlink,
        "size": metadata.len(),
        "mode": mode,
        "mtime": mtime
    }))
}

async fn mkdir(params: MkdirParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    if params.recursive.unwrap_or(true) {
        create_dir_all_sftp(&sftp, Path::new(&params.path)).await?;
    } else {
        sftp.create_dir(params.path.clone()).await?;
    }
    Ok(json!({ "path": params.path, "created": true }))
}

async fn remove_path(params: RemovePathParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions.clone(), sftp_cache.clone()).await?;
    let metadata = sftp.symlink_metadata(params.path.clone()).await?;
    if metadata.is_dir() && !metadata.is_symlink() {
        if params.recursive.unwrap_or(false) {
            remove_dir_recursive_sftp(&sftp, &params.path).await?;
        } else {
            sftp.remove_dir(params.path.clone()).await?;
        }
    } else {
        sftp.remove_file(params.path.clone()).await?;
    }
    Ok(json!({ "path": params.path, "removed": true }))
}

async fn move_path(params: MovePathParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    sftp.rename(params.from_path.clone(), params.to_path.clone()).await?;
    Ok(json!({ "from": params.from_path, "to": params.to_path, "moved": true }))
}

async fn chmod_path(params: ChmodPathParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let parsed_mode = u32::from_str_radix(params.mode.trim(), 8)
        .context("Invalid chmod mode")?;
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;
    let mut metadata = sftp.symlink_metadata(params.path.clone()).await?;
    metadata.permissions = Some((metadata.permissions.unwrap_or(0) & !0o777) | parsed_mode);
    sftp.set_metadata(params.path.clone(), metadata).await?;
    Ok(json!({ "path": params.path, "mode": params.mode, "updated": true }))
}

async fn read_sftp_text_file(sftp: &SftpSession, remote_path: &str) -> anyhow::Result<String> {
    let bytes = sftp.read(remote_path.to_string()).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

async fn monitor_snapshot(params: MonitorSnapshotParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let sftp = open_sftp_session(&params.session_id, sessions, sftp_cache).await?;

    // Read all proc files concurrently
    let (uptime, cpu, loadavg, meminfo, netdev) = tokio::join!(
        read_sftp_text_file(&sftp, "/proc/uptime"),
        read_sftp_text_file(&sftp, "/proc/stat"),
        read_sftp_text_file(&sftp, "/proc/loadavg"),
        read_sftp_text_file(&sftp, "/proc/meminfo"),
        read_sftp_text_file(&sftp, "/proc/net/dev"),
    );
    let uptime = uptime.unwrap_or_default();
    let cpu = cpu.unwrap_or_default();
    let loadavg = loadavg.unwrap_or_default();
    let meminfo = meminfo.unwrap_or_default();
    let netdev = netdev.unwrap_or_default();

    Ok(json!({
        "serverTime": uptime.lines().next().unwrap_or_default(),
        "cpu": cpu.lines().next().unwrap_or_default(),
        "loadavg": loadavg.lines().next().unwrap_or_default(),
        "uptime": uptime.lines().next().unwrap_or_default(),
        "memory": meminfo,
        "network": netdev,
    }))
}

async fn start_docker_exec(
    params: DockerExecParams,
    sessions: Sessions,
    output_tx: OutputSender,
) -> anyhow::Result<String> {
    let session_handle = {
        let guard = sessions.lock().await;
        guard.get(&params.session_id)
            .map(|session| (Arc::clone(&session.session_handle), session.session_info.clone(), session.remote_forwards.clone()))
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    let exec_session_id = format!("docker-exec-{}-{}", params.container_id, chrono_like_now_millis());
    let mut channel = {
        let handle_guard = session_handle.0.lock().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            handle_guard.channel_open_session(),
        )
        .await
        .map_err(|_| anyhow!("Timed out opening Docker exec channel"))?
        .context("Failed to open Docker exec channel")?
    };

    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .context("Failed to request Docker exec PTY")?;

    channel
        .request_shell(true)
        .await
        .context("Failed to request Docker shell")?;

    let command = format!(
        "docker exec -it {} /bin/sh -c 'if command -v bash > /dev/null; then exec bash; else exec sh; fi'; exit\n",
        shell_escape(&params.container_id)
    );

    // Split channel into reader/writer so we can store the writer in the
    // sessions map for ssh.write / ssh.resize to find it.
    let (mut reader, mut writer) = channel.split();
    
    // Inject the docker exec command directly into the shell
    let payload = Cursor::new(Bytes::copy_from_slice(command.as_bytes()));
    let _ = writer.data(payload).await;
    
    let writer = Arc::new(Mutex::new(writer));

    {
        let mut guard = sessions.lock().await;
        guard.insert(
            exec_session_id.clone(),
            RustSshSession {
                channel: writer,
                session_handle: session_handle.0.clone(),
                remote_forwards: session_handle.2.clone(),
                session_info: session_handle.1.clone(),
            },
        );
    }

    let session_id = exec_session_id.clone();
    let sessions_cleanup = sessions.clone();
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let text = String::from_utf8_lossy(&data).to_string();
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshData {
                        session_id: session_id.clone(),
                        data: text,
                    }));
                }
                ChannelMsg::Close | ChannelMsg::Eof => {
                    {
                        let mut guard = sessions_cleanup.lock().await;
                        guard.remove(&session_id);
                    }
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::ExternalShellClose {
                        session_id: session_id.clone(),
                    }));
                    break;
                }
                ChannelMsg::ExitSignal { error_message, .. } => {
                    {
                        let mut guard = sessions_cleanup.lock().await;
                        guard.remove(&session_id);
                    }
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshError {
                        session_id: session_id.clone(),
                        error: error_message,
                    }));
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(exec_session_id)
}

async fn start_docker_log_stream(
    params: DockerLogStreamParams,
    sessions: Sessions,
    streams: StreamTasks,
    output_tx: OutputSender,
) -> anyhow::Result<String> {
    let session_info = {
        let guard = sessions.lock().await;
        guard.get(&params.session_id)
            .map(|session| session.session_info.clone())
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    let stream_id = format!("docker-logs-{}-{}", params.container_id, chrono_like_now_millis());
    stop_stream_task(&stream_id, streams.clone()).await.ok();

    let container_id = params.container_id.clone();
    let tail = params.tail.unwrap_or_else(|| "200".to_string());
    let output = output_tx.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let handle = create_authenticated_handle(&session_info).await?;
            let mut channel = handle
                .channel_open_session()
                .await
                .context("Failed to open docker logs channel")?;
            let command = format!("docker logs -f --tail {} {}", tail, shell_escape(&container_id));
            channel.exec(true, command).await.context("Failed to start docker logs")?;

            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let _ = output.send(OutputMessage::Event(CoreEvent::DockerLogs {
                            container_id: container_id.clone(),
                            data: text,
                        }));
                    }
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
            }

            Ok::<(), anyhow::Error>(())
        }.await;

        if let Err(error) = result {
            let _ = output.send(OutputMessage::Event(CoreEvent::DockerLogs {
                container_id: container_id.clone(),
                data: format!("\n[stream error] {error}\n"),
            }));
        }
    });

    {
        let mut guard = streams.lock().await;
        guard.insert(stream_id.clone(), Arc::new(task));
    }

    Ok(stream_id)
}

async fn stop_stream_task(stream_id: &str, streams: StreamTasks) -> anyhow::Result<()> {
    let task = {
        let mut guard = streams.lock().await;
        guard.remove(stream_id)
    };
    if let Some(task) = task {
        task.abort();
    }
    Ok(())
}

fn chrono_like_now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn read_multiple_files(
    params: ReadMultipleFilesParams,
    sessions: Sessions,
    sftp_cache: SftpCache,
) -> anyhow::Result<serde_json::Value> {
    let max_bytes = params.max_bytes_per_file.unwrap_or(128 * 1024);

    // Read all files concurrently using the cached SFTP session
    let mut handles = Vec::new();
    for path in params.paths {
        let sessions = sessions.clone();
        let sftp_cache = sftp_cache.clone();
        let session_id = params.session_id.clone();
        handles.push(tokio::spawn(async move {
            let read_result = read_file(
                ReadFileParams {
                    session_id,
                    path: path.clone(),
                    max_bytes: Some(max_bytes),
                },
                sessions,
                sftp_cache,
            )
            .await;

            match read_result {
                Ok(result) => {
                    let content = result.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    json!({
                        "path": path,
                        "content": content,
                        "truncated": result.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                        "size": result.get("size").and_then(|v| v.as_u64()).unwrap_or(0)
                    })
                }
                Err(error) => {
                    json!({
                        "path": path,
                        "content": "",
                        "error": error.to_string()
                    })
                }
            }
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(handle.await.unwrap_or_else(|e| json!({"error": e.to_string()})));
    }

    Ok(json!({ "results": results }))
}

async fn scan_project(params: ProjectRootParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let command = format!(
        "python3 - <<'PY'\nimport json, os\nroot = {}\nexclude_dirs = {{'.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.venv', 'vendor'}}\nexclude_suffixes = ('.pyc', '.min.js', '.min.css', '.map')\nresults = []\nfor base, dirs, files in os.walk(root):\n    dirs[:] = [d for d in dirs if d not in exclude_dirs]\n    depth = os.path.relpath(base, root).count(os.sep) if os.path.relpath(base, root) != '.' else 0\n    if depth > 4:\n        dirs[:] = []\n        continue\n    for name in files:\n        if name.endswith(exclude_suffixes):\n            continue\n        results.append(os.path.join(base, name))\n        if len(results) >= 500:\n            print(json.dumps(results, ensure_ascii=False))\n            raise SystemExit\nprint(json.dumps(results, ensure_ascii=False))\nPY",
        python_string(&params.root_path)
    );
    let output = exec_capture(&params.session_id, &command, 20_000, sessions).await?;
    let files = parse_json_stdout(&output.stdout)?;
    Ok(json!({ "files": files }))
}

async fn project_summary(params: ProjectRootParams, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<serde_json::Value> {
    let tree_command = format!(
        "python3 - <<'PY'\nimport os\nroot = {}\nexclude = {{'.git', 'node_modules', '__pycache__', 'dist', 'build', '.next'}}\nlines = []\nfor base, dirs, files in os.walk(root):\n    dirs[:] = [d for d in dirs if d not in exclude]\n    rel = os.path.relpath(base, root)\n    depth = 0 if rel == '.' else rel.count(os.sep) + 1\n    if depth > 3:\n        dirs[:] = []\n        continue\n    indent = '  ' * depth\n    if rel != '.':\n        lines.append(indent + os.path.basename(base) + '/')\n    for name in sorted(files)[:20]:\n        lines.append(indent + '  ' + name)\n    if len(lines) >= 200:\n        break\nprint('\\n'.join(lines))\nPY",
        python_string(&params.root_path)
    );
    let tree_output = exec_capture(&params.session_id, &tree_command, 15_000, sessions.clone()).await?;

    let key_files = [
        "package.json",
        "Makefile",
        "Dockerfile",
        "docker-compose.yml",
        "requirements.txt",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "README.md",
        ".env.example",
        "tsconfig.json",
        "pyproject.toml",
    ];

    let mut summary = format!("项目目录: {}\n\n目录结构:\n{}\n", params.root_path, tree_output.stdout.trim());
    for key_file in key_files {
        let path = format!("{}/{}", params.root_path.trim_end_matches('/'), key_file);
        let file_result = read_file(
            ReadFileParams {
                session_id: params.session_id.clone(),
                path,
                max_bytes: Some(4096),
            },
            sessions.clone(),
            sftp_cache.clone(),
        )
        .await;

        if let Ok(result) = file_result {
            let content = result.get("content").and_then(|v| v.as_str()).unwrap_or("").trim();
            if !content.is_empty() {
                summary.push_str(&format!("\n--- {} ---\n{}\n", key_file, content));
            }
        }
    }

    if summary.len() > 8_000 {
        summary.truncate(8_000);
    }

    Ok(json!({ "summary": summary }))
}

async fn create_authenticated_handle(session: &SessionInfo) -> anyhow::Result<Handle<ClientHandler>> {
    let remote_forwards = Arc::new(Mutex::new(HashMap::new()));
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(10)),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut handle = client::connect(
        config,
        (session.host.as_str(), session.port),
        ClientHandler { remote_forwards },
    )
        .await
        .context("Failed to establish russh client connection")?;

    match session.auth_type.as_str() {
        "password" => {
            let password = session.password.as_deref().ok_or_else(|| anyhow!("Missing password"))?;
            let auth = handle
                .authenticate_password(session.username.clone(), password)
                .await
                .context("Password authentication failed")?;
            if !auth.success() {
                return Err(anyhow!("Password authentication rejected by server"));
            }
        }
        "key" | "keyWithPassphrase" => {
            let key_path = session
                .private_key_path
                .as_deref()
                .ok_or_else(|| anyhow!("Missing private key path"))?;
            let key = load_secret_key(Path::new(key_path), session.passphrase.as_deref())
                .with_context(|| format!("Failed to load private key from {key_path}"))?;
            let hash_alg = handle.best_supported_rsa_hash().await?.flatten();
            let auth = handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .context("Public key authentication failed")?;
            if !auth.success() {
                return Err(anyhow!("Public key authentication rejected by server"));
            }
        }
        other => return Err(anyhow!("Unsupported auth type: {other}")),
    }

    Ok(handle)
}

struct ExecCaptureResult {
    stdout: String,
    stderr: String,
    exit_code: i64,
    duration_ms: u128,
}

async fn open_sftp_session(session_id: &str, sessions: Sessions, sftp_cache: SftpCache) -> anyhow::Result<Arc<SftpSession>> {
    // Try to reuse a cached SFTP session — validate with a quick stat(".")
    {
        let cached = {
            let cache = sftp_cache.lock().await;
            cache.get(session_id).map(Arc::clone)
        };
        if let Some(sftp) = cached {
            match tokio::time::timeout(Duration::from_secs(5), sftp.metadata(".".to_string())).await {
                Ok(Ok(_)) => return Ok(sftp),
                _ => {
                    // Stale SFTP session — evict from cache and create a new one
                    let mut cache = sftp_cache.lock().await;
                    cache.remove(session_id);
                }
            }
        }
    }

    let session_handle = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| Arc::clone(&session.session_handle))
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    let channel = {
        let handle_guard = session_handle.lock().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            handle_guard.channel_open_session(),
        )
        .await
        .map_err(|_| anyhow!("Timed out opening SFTP channel"))?
        .context("Failed to open SFTP session channel")?
    };

    channel
        .request_subsystem(true, "sftp")
        .await
        .context("Failed to request SFTP subsystem")?;

    let sftp = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .context("Failed to initialize SFTP session")?
    );

    // Cache the session
    {
        let mut cache = sftp_cache.lock().await;
        cache.insert(session_id.to_string(), Arc::clone(&sftp));
    }

    Ok(sftp)
}

async fn create_dir_all_sftp(sftp: &SftpSession, dir: &Path) -> anyhow::Result<()> {
    let mut current = Path::new("").to_path_buf();
    for component in dir.components() {
        current.push(component.as_os_str());
        if current.as_os_str().is_empty() {
            continue;
        }
        let current_str = current.to_string_lossy().to_string();
        if sftp.try_exists(current_str.clone()).await.unwrap_or(false) {
            continue;
        }
        let _ = sftp.create_dir(current_str).await;
    }
    Ok(())
}

async fn remove_dir_recursive_sftp(sftp: &SftpSession, dir: &str) -> anyhow::Result<()> {
    let mut stack: Vec<(String, bool)> = vec![(dir.to_string(), false)];

    while let Some((current_dir, visited)) = stack.pop() {
        if visited {
            sftp.remove_dir(current_dir).await?;
            continue;
        }

        stack.push((current_dir.clone(), true));
        let entries = sftp.read_dir(current_dir.clone()).await?;
        for entry in entries {
            let name = entry.file_name();
            let path = if current_dir.ends_with('/') {
                format!("{}{}", current_dir, name)
            } else {
                format!("{}/{}", current_dir, name)
            };
            let meta = entry.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((path, false));
            } else {
                sftp.remove_file(path).await?;
            }
        }
    }

    Ok(())
}

struct CommandRiskAssessment {
    risk_level: &'static str,
    requires_confirmation: bool,
    reason: &'static str,
}

fn assess_command_risk(command: &str) -> CommandRiskAssessment {
    let normalized = command.to_lowercase();
    let dangerous_patterns = [
        ("rm -rf", "critical", "命令包含递归强制删除"),
        ("mkfs", "critical", "命令可能格式化磁盘"),
        ("dd if=", "critical", "命令可能直接覆盖磁盘或分区"),
        ("shutdown", "high", "命令会关闭远端机器"),
        ("reboot", "high", "命令会重启远端机器"),
        ("poweroff", "high", "命令会关闭远端机器"),
        ("halt", "high", "命令会停止远端机器"),
        (":(){ :|:& };:", "critical", "命令包含 fork bomb"),
        ("chmod -r 777 /", "critical", "命令会递归修改根目录权限"),
        ("chown -r", "high", "命令会递归更改所有者"),
        ("userdel", "high", "命令会删除系统用户"),
        ("groupdel", "high", "命令会删除系统组"),
    ];

    for (pattern, level, reason) in dangerous_patterns {
        if normalized.contains(pattern) {
            return CommandRiskAssessment {
                risk_level: level,
                requires_confirmation: true,
                reason,
            };
        }
    }

    if normalized.contains("sudo ") || normalized.starts_with("sudo") {
        return CommandRiskAssessment {
            risk_level: "medium",
            requires_confirmation: true,
            reason: "命令将以 sudo 提权执行",
        };
    }

    CommandRiskAssessment {
        risk_level: "low",
        requires_confirmation: false,
        reason: "",
    }
}

async fn exec_capture(
    session_id: &str,
    command: &str,
    timeout_ms: u64,
    sessions: Sessions,
) -> anyhow::Result<ExecCaptureResult> {
    let session_handle = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| Arc::clone(&session.session_handle))
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    let started = std::time::Instant::now();
    let channel = {
        let handle_guard = session_handle.lock().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            handle_guard.channel_open_session(),
        )
        .await
        .map_err(|_| anyhow!("Timed out opening exec channel"))?
        .context("Failed to open exec session channel")?
    };
    channel.exec(true, command).await.context("Failed to exec command")?;

    let deadline = Duration::from_millis(timeout_ms);
    let capture = tokio::time::timeout(deadline, async move {
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut exit_code = 0_i64;
        let mut saw_exit = false;
        let mut reader = channel;

        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.push_str(&String::from_utf8_lossy(&data)),
                ChannelMsg::ExtendedData { data, .. } => stderr.push_str(&String::from_utf8_lossy(&data)),
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = exit_status as i64;
                    saw_exit = true;
                }
                ChannelMsg::ExitSignal { error_message, .. } => {
                    if !stderr.is_empty() {
                        stderr.push('\n');
                    }
                    stderr.push_str(&error_message);
                    saw_exit = true;
                    exit_code = 1;
                }
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }

        if !saw_exit {
            exit_code = if stderr.is_empty() { 0 } else { 1 };
        }

        Ok::<ExecCaptureResult, anyhow::Error>(ExecCaptureResult {
            stdout,
            stderr,
            exit_code,
            duration_ms: started.elapsed().as_millis(),
        })
    })
    .await;

    match capture {
        Ok(result) => result,
        Err(_) => Err(anyhow!("Command timed out after {}ms", timeout_ms)),
    }
}

fn parse_json_stdout(stdout: &str) -> anyhow::Result<serde_json::Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Failed to parse JSON output from remote command: stdout was empty"));
    }
    serde_json::from_str(trimmed).context("Failed to parse JSON output from remote command")
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace("'", "'\\''"))
}

fn python_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    format!("'{}'", escaped)
}

async fn write_response(stdout: &mut io::Stdout, response: &CoreResponse) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(response)?;
    write_frame(stdout, &payload).await?;
    stdout.flush().await?;
    Ok(())
}

async fn emit_event(stdout: &mut io::Stdout, event: &CoreEvent) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(event)?;
    write_frame(stdout, &payload).await?;
    stdout.flush().await?;
    Ok(())
}

async fn read_frame(stdin: &mut io::Stdin) -> anyhow::Result<Option<String>> {
    let mut len_buf = [0_u8; 4];
    match stdin.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }

    let len = u32::from_be_bytes(len_buf) as usize;
    let mut payload = vec![0_u8; len];
    stdin.read_exact(&mut payload).await?;
    Ok(Some(String::from_utf8(payload)?))
}

async fn write_frame(stdout: &mut io::Stdout, payload: &[u8]) -> anyhow::Result<()> {
    let len = u32::try_from(payload.len()).context("Payload too large")?;
    stdout.write_all(&len.to_be_bytes()).await?;
    stdout.write_all(payload).await?;
    Ok(())
}
