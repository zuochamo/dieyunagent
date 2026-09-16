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
