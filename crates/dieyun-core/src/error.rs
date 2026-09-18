use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{message}")]
    Rpc { code: &'static str, message: String },
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl CoreError {
    pub fn rpc(code: &'static str, message: impl Into<String>) -> Self {
        Self::Rpc {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcErrorBody {
    pub code: String,
    pub message: String,
}

impl From<rusqlite::Error> for CoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::rpc("DB_ERROR", value.to_string())
    }
}

/// 序列化失败不再 panic（此前 rpc dispatch 大量 `to_value(..).unwrap()`），
/// 统一转为 INTERNAL 错误返回给 host。
impl From<serde_json::Error> for CoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Other(value.into())
    }
}

impl From<CoreError> for RpcErrorBody {
    fn from(value: CoreError) -> Self {
        match value {
            CoreError::Rpc { code, message } => Self {
                code: code.to_string(),
                message,
            },
            CoreError::Other(err) => Self {
                code: "INTERNAL".to_string(),
                message: err.to_string(),
            },
        }
    }
}
