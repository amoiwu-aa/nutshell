mod protocol;

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use bytes::Bytes;
use protocol::{
    CoreEvent, CoreRequest, CoreResponse, ListDirParams, MkdirParams, MovePathParams,
    ProjectRootParams, ReadFileParams, ReadMultipleFilesParams, RemovePathParams, ResizeParams,
    RunCommandParams, SearchParams, SessionIdParams, SshConnectParams, StatPathParams,
    WriteFileParams, WriteParams,
};
use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde_json::json;
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

type OutputSender = mpsc::UnboundedSender<OutputMessage>;
type Sessions = Arc<Mutex<HashMap<String, RustSshSession>>>;

enum OutputMessage {
    Event(CoreEvent),
    Response(CoreResponse),
}

struct RustSshSession {
    channel: Arc<Mutex<russh::ChannelWriteHalf<russh::client::Msg>>>,
    session_info: SessionInfo,
}

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
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
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
        let request_output = output_tx.clone();
        tokio::spawn(async move {
            let response = handle_request(request, request_sessions, request_output.clone()).await;
            request_output.send(OutputMessage::Response(response)).ok();
        });
    }

    drop(output_tx);
    let _ = stdout_task.await;
    Ok(())
}

async fn handle_request(request: CoreRequest, sessions: Sessions, output_tx: OutputSender) -> CoreResponse {
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
                    "sftp": false
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

            match connect_session(params, sessions, output_tx).await {
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

            match disconnect_session(&params.session_id, sessions).await {
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

            match list_dir(params, sessions).await {
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

            match read_file(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_read_file_failed", format!("{error:#}")),
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

            match write_file(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_write_file_failed", format!("{error:#}")),
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

            match stat_path(params, sessions).await {
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

            match mkdir(params, sessions).await {
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

            match remove_path(params, sessions).await {
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

            match move_path(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_move_path_failed", format!("{error:#}")),
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

            match read_multiple_files(params, sessions).await {
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

            match project_summary(params, sessions).await {
                Ok(result) => CoreResponse::success(request.id, result),
                Err(error) => CoreResponse::error(request.id, "tool_project_summary_failed", format!("{error:#}")),
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
    output_tx: OutputSender,
) -> anyhow::Result<String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (params.host.as_str(), params.port), ClientHandler)
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

    let channel: russh::Channel<Msg> = handle
        .channel_open_session()
        .await
        .context("Failed to open SSH session channel")?;
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
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshClose {
                        session_id: session_id.clone(),
                    }));
                    break;
                }
                ChannelMsg::ExitSignal { error_message, .. } => {
                    {
                        let mut guard = sessions.lock().await;
                        guard.remove(&session_id);
                    }
                    let _ = output_tx.send(OutputMessage::Event(CoreEvent::SshError {
                        session_id: session_id.clone(),
                        error: error_message,
                    }));
                }
                _ => {}
            }
        }

        let mut guard = sessions.lock().await;
        guard.remove(&session_id);
    });

    Ok(params.session_id)
}

async fn disconnect_session(session_id: &str, sessions: Sessions) -> Result<(), String> {
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
    if let Err(error) = writer
        .data(payload)
        .await
    {
        let mut guard = sessions.lock().await;
        guard.remove(session_id);
        return Err(error.to_string())
    }

    Ok(())
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
    if let Err(error) = writer
        .window_change(cols, rows, 0, 0)
        .await
    {
        let mut guard = sessions.lock().await;
        guard.remove(session_id);
        return Err(error.to_string())
    }

    Ok(())
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

async fn list_dir(params: ListDirParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let command = format!(
        "python3 - <<'PY'\nimport json, os, stat\npath = {}\nentries = []\nfor name in sorted(os.listdir(path)):\n    full = os.path.join(path, name)\n    st = os.lstat(full)\n    entries.append({{\"name\": name, \"path\": full, \"isDir\": stat.S_ISDIR(st.st_mode), \"size\": st.st_size, \"mode\": oct(st.st_mode & 0o777), \"mtime\": int(st.st_mtime)}})\nprint(json.dumps(entries, ensure_ascii=False))\nPY",
        python_string(&params.path)
    );
    let output = exec_capture(&params.session_id, &command, 15_000, sessions).await?;
    let entries = parse_json_stdout(&output.stdout)?;
    Ok(json!({ "entries": entries }))
}

async fn read_file(params: ReadFileParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let max_bytes = params.max_bytes.unwrap_or(128 * 1024);
    let command = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\npath = Path({})\nlimit = {}\ndata = path.read_bytes()\ntruncated = len(data) > limit\nout = data[:limit]\nimport json\nprint(json.dumps({{\"content\": out.decode('utf-8', errors='replace'), \"truncated\": truncated, \"size\": len(data)}}, ensure_ascii=False))\nPY",
        python_string(&params.path),
        max_bytes
    );
    let output = exec_capture(&params.session_id, &command, 15_000, sessions).await?;
    parse_json_stdout(&output.stdout)
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

async fn write_file(params: WriteFileParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let command = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\npath = Path({})\ncontent = {}\nif {}:\n    path.parent.mkdir(parents=True, exist_ok=True)\npath.write_text(content, encoding='utf-8')\nimport json\nprint(json.dumps({{\"path\": str(path), \"written\": len(content.encode('utf-8'))}}, ensure_ascii=False))\nPY",
        python_string(&params.path),
        python_string(&params.content),
        if params.create_dirs.unwrap_or(false) { "True" } else { "False" }
    );
    let output = exec_capture(&params.session_id, &command, 15_000, sessions).await?;
    parse_json_stdout(&output.stdout)
}

async fn stat_path(params: StatPathParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let command = format!(
        "python3 - <<'PY'\nimport json, os, stat\npath = {}\nexists = os.path.exists(path)\nif not exists:\n    print(json.dumps({{\"exists\": False}}, ensure_ascii=False))\nelse:\n    st = os.lstat(path)\n    print(json.dumps({{\"exists\": True, \"path\": path, \"isDir\": stat.S_ISDIR(st.st_mode), \"isFile\": stat.S_ISREG(st.st_mode), \"isSymlink\": stat.S_ISLNK(st.st_mode), \"size\": st.st_size, \"mode\": oct(st.st_mode & 0o777), \"mtime\": int(st.st_mtime)}}, ensure_ascii=False))\nPY",
        python_string(&params.path)
    );
    let output = exec_capture(&params.session_id, &command, 10_000, sessions).await?;
    parse_json_stdout(&output.stdout)
}

async fn mkdir(params: MkdirParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let recursive = params.recursive.unwrap_or(true);
    let command = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\nimport json\npath = Path({})\npath.mkdir(parents={}, exist_ok=True)\nprint(json.dumps({{\"path\": str(path), \"created\": True}}, ensure_ascii=False))\nPY",
        python_string(&params.path),
        if recursive { "True" } else { "False" }
    );
    let output = exec_capture(&params.session_id, &command, 10_000, sessions).await?;
    parse_json_stdout(&output.stdout)
}

async fn remove_path(params: RemovePathParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let recursive = params.recursive.unwrap_or(false);
    let command = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\nimport json, shutil\npath = Path({})\nif path.is_dir() and not path.is_symlink():\n    if {}:\n        shutil.rmtree(path)\n    else:\n        path.rmdir()\nelse:\n    path.unlink()\nprint(json.dumps({{\"path\": str(path), \"removed\": True}}, ensure_ascii=False))\nPY",
        python_string(&params.path),
        if recursive { "True" } else { "False" }
    );
    let output = exec_capture(&params.session_id, &command, 15_000, sessions).await?;
    parse_json_stdout(&output.stdout)
}

async fn move_path(params: MovePathParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
    let command = format!(
        "python3 - <<'PY'\nfrom pathlib import Path\nimport json\nfrom_path = Path({})\nto_path = Path({})\nfrom_path.rename(to_path)\nprint(json.dumps({{\"from\": str(from_path), \"to\": str(to_path), \"moved\": True}}, ensure_ascii=False))\nPY",
        python_string(&params.from_path),
        python_string(&params.to_path)
    );
    let output = exec_capture(&params.session_id, &command, 15_000, sessions).await?;
    parse_json_stdout(&output.stdout)
}

async fn read_multiple_files(
    params: ReadMultipleFilesParams,
    sessions: Sessions,
) -> anyhow::Result<serde_json::Value> {
    let mut results = Vec::new();
    let max_bytes = params.max_bytes_per_file.unwrap_or(128 * 1024);

    for path in params.paths {
        let read_result = read_file(
            ReadFileParams {
                session_id: params.session_id.clone(),
                path: path.clone(),
                max_bytes: Some(max_bytes),
            },
            sessions.clone(),
        )
        .await;

        match read_result {
            Ok(result) => {
                let content = result.get("content").and_then(|v| v.as_str()).unwrap_or("");
                results.push(json!({
                    "path": path,
                    "content": content,
                    "truncated": result.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false),
                    "size": result.get("size").and_then(|v| v.as_u64()).unwrap_or(0)
                }));
            }
            Err(error) => {
                results.push(json!({
                    "path": path,
                    "content": "",
                    "error": error.to_string()
                }));
            }
        }
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

async fn project_summary(params: ProjectRootParams, sessions: Sessions) -> anyhow::Result<serde_json::Value> {
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
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (session.host.as_str(), session.port), ClientHandler)
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
    let session_info = {
        let guard = sessions.lock().await;
        guard
            .get(session_id)
            .map(|session| session.session_info.clone())
            .ok_or_else(|| anyhow!("Session not found"))?
    };

    let handle = create_authenticated_handle(&session_info).await?;

    let started = std::time::Instant::now();
    let channel = handle
        .channel_open_session()
        .await
        .context("Failed to open exec session channel")?;
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
    serde_json::from_str(stdout.trim()).context("Failed to parse JSON output from remote command")
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace("'", "'\\''"))
}

fn python_string(value: &str) -> String {
    format!("r#\"{}\"#", value.replace("\"#", "\\\"#"))
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
