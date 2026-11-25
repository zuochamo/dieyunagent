//! agent 域的阻塞型 RPC：每个方法一个函数（参数校验与返回形状都在这里）。
//!
//! 由 `ServiceSnapshot::dispatch` 的臂体机械搬来：`self.*` → `snap.*`，其余逐字未改。
//! 迁移纪律见 `rpc/registry.rs` 顶部注释；parity 测试会拦「双份实现」与「搬完忘删臂」。

use serde_json::Value;

use dieyun_base::error::CoreError;
use crate::rpc::ServiceSnapshot;

/// `agent.run_upsert`
pub(crate) fn run_upsert(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    snap.memory.upsert_agent_run(params)
}

/// `agent.plan_save`
pub(crate) fn plan_save(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let saved = snap.memory.upsert_agent_plan(params)?;
        if params.get("steps").and_then(|v| v.as_array()).is_some() {
            let mut step_input = params.clone();
            if let Some(obj) = step_input.as_object_mut() {
                obj.insert(
                    "planId".into(),
                    saved.get("planId").cloned().unwrap_or(Value::Null),
                );
            }
            snap.memory.save_agent_steps(&step_input)?;
        }
        Ok(saved)
    }

/// `agent.steps_save`
pub(crate) fn steps_save(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    snap.memory.save_agent_steps(params)
}

/// `agent.state_get`
pub(crate) fn state_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let session_id = params
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let row = snap.memory.get_latest_agent_state(session_id)?;
        Ok(row.unwrap_or(Value::Null))
    }

/// `agent.trace_save`
pub(crate) fn trace_save(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    snap.memory.save_agent_trace(params)
}

/// `agent.trace_get`
pub(crate) fn trace_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let row = snap.memory.get_agent_trace(params)?;
        Ok(row.unwrap_or(Value::Null))
    }

/// `agent.traces_get`：一次读池 + 一条 SQL 取一批 run 的最新 trace（回放思考区用）。
pub(crate) fn traces_get(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        snap.memory.get_agent_traces(params)
    }
    // ---- fs：磁盘 IO（实现见 rpc/handlers/fs.rs）----
    // ---- codebase / graph：同步查询与索引启动 ----
