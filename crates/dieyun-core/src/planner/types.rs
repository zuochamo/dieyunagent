use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub worker: String,
    pub title: String,
    pub instruction: String,
    pub expected_output: String,
    pub agent_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub plan_summary: String,
    pub todos: Vec<String>,
    pub subtasks: Vec<Subtask>,
    pub best_of_n: u32,
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub accepted: bool,
    pub retry: Vec<Value>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResultInput {
    pub id: String,
    pub worker: String,
    #[serde(default)]
    pub subagent_id: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerJobOut {
    pub worker: String,
    pub tasks: Vec<Subtask>,
    #[serde(default)]
    pub is_retry: bool,
    #[serde(default)]
    pub retry_reason: Option<String>,
    #[serde(default)]
    pub use_best_of_n: bool,
    #[serde(default)]
    pub best_of_n_total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerTraceEntry {
    pub round: u32,
    pub phase: String,
    pub thought: String,
    #[serde(default)]
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerStartParams {
    pub model: String,
    pub sys_content: String,
    pub user_text: String,
    #[serde(default)]
    pub chat_history_block: String,
    #[serde(default)]
    pub has_images: bool,
    #[serde(default)]
    pub has_explore_tools: bool,
    #[serde(default)]
    pub max_worker_retries: u32,
    #[serde(default)]
    pub best_of_n: u32,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    #[serde(default)]
    pub resume_checkpoint: Option<Value>,
    #[serde(default)]
    pub vision_model: Option<String>,
    /// Host passes `agent-limits` `ctxAgentToolCallLimit` (or the model setting).
    #[serde(default)]
    pub max_tool_calls: Option<u32>,
}

fn default_max_output_tokens() -> u32 {
    8192
}

fn default_temperature() -> f64 {
    0.7
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerContinueInput {
    pub step: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub worker_results: Vec<WorkerResultInput>,
    #[serde(default)]
    pub hit_round_limit: bool,
    #[serde(default)]
    pub partial_content: Option<String>,
    #[serde(default)]
    pub partial_body: Option<Value>,
    #[serde(default)]
    pub worktree_ctx: Option<Value>,
    #[serde(default)]
    pub arbitration_action: Option<String>,
}
