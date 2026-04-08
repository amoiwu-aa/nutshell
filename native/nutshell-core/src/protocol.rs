use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct CoreRequest {
    pub id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Deserialize)]
pub struct SshConnectParams {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    pub ai_compatibility_mode: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SessionIdParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ResizeParams {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Deserialize)]
pub struct WriteParams {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct RunCommandParams {
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub env: Option<Vec<EnvEntry>>,
    pub require_confirmation: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ListDirParams {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadFileParams {
    pub session_id: String,
    pub path: String,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ReadBinaryFileParams {
    pub session_id: String,
    pub path: String,
    pub offset: Option<u64>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    pub session_id: String,
    pub root_path: String,
    pub pattern: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct WriteFileParams {
    pub session_id: String,
    pub path: String,
    pub content: String,
    pub create_dirs: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct WriteBinaryFileParams {
    pub session_id: String,
    pub path: String,
    pub content_base64: String,
    pub append: Option<bool>,
    pub create_dirs: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct StatPathParams {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct MkdirParams {
    pub session_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct RemovePathParams {
    pub session_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MovePathParams {
    pub session_id: String,
    pub from_path: String,
    pub to_path: String,
}

#[derive(Debug, Deserialize)]
pub struct ChmodPathParams {
    pub session_id: String,
    pub path: String,
    pub mode: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadMultipleFilesParams {
    pub session_id: String,
    pub paths: Vec<String>,
    pub max_bytes_per_file: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectRootParams {
    pub session_id: String,
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
pub struct MonitorSnapshotParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PortForwardRuleParams {
    pub id: String,
    pub connection_id: String,
    pub r#type: String,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct ForwardRemoveParams {
    pub rule_id: String,
}

#[derive(Debug, Deserialize)]
pub struct DockerExecParams {
    pub session_id: String,
    pub container_id: String,
}

#[derive(Debug, Deserialize)]
pub struct DockerLogStreamParams {
    pub session_id: String,
    pub container_id: String,
    pub tail: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum CoreResponse {
    #[serde(rename = "response")]
    Success {
        id: Option<String>,
        success: bool,
        result: Value,
    },
    #[serde(rename = "response")]
    Error {
        id: Option<String>,
        success: bool,
        error: CoreError,
    },
}

#[derive(Debug, Serialize)]
pub struct CoreError {
    pub code: String,
    pub message: String,
}

impl CoreResponse {
    pub fn success(id: Option<String>, result: Value) -> Self {
        Self::Success {
            id,
            success: true,
            result,
        }
    }

    pub fn error(id: Option<String>, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            id,
            success: false,
            error: CoreError {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum CoreEvent {
    #[serde(rename = "event")]
    Ready { version: String },
    #[serde(rename = "event")]
    Log { level: String, message: String },
    #[serde(rename = "event")]
    SshData { session_id: String, data: String },
    #[serde(rename = "event")]
    SshClose { session_id: String },
    #[serde(rename = "event")]
    SshError { session_id: String, error: String },
    #[serde(rename = "event")]
    PortForwardStatus { rule_id: String, status: String },
    #[serde(rename = "event")]
    DockerLogs { container_id: String, data: String },
    #[serde(rename = "event")]
    ExternalShellClose { session_id: String },
}
