//! 项目身份：`projects` / `project_paths`（项目记忆 scope 的唯一身份来源）。
//!
//! 老实现把路径编进 scope（`project:<路径>` 或 `project:<sha256前16>:<路径尾72>`），
//! 于是「改目录名」等于换了一个项目：之前沉淀的项目记忆再也召不回来，而且这种断裂是静默的。
//! 同一仓库的大小写差异、尾斜杠、软链/worktree 入口也会各算一个 scope。
//!
//! 现在 scope 恒为 `project:<id>`：
//!
//! - `projects(id, root_path, git_origin, created_at, last_seen_at)`：项目本体；
//! - `project_paths(path_key, project_id, path, first_seen_at)`：见过的每个路径（别名），
//!   `path_key` 是规范化结果（小写、反斜杠统一、去尾分隔符），唯一索引；
//! - 解析顺序：`path_key` 命中 → 用该 project；未命中且 `git_origin` 与某个 project 相同
//!   → 该路径挂成它的别名（仓库搬家/换盘符仍指向同一 project）；都没有 → 新建 project。
//!
//! 为什么不把 `git_origin` 检测放在 Rust：core 不读 git 仓库（也就不必为身份再造一个
//! 「git 命令执行器」）。检测在 Node 侧（`src/gateway/`），这里只接收解析结果并落库。

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::error::CoreError;

use super::{now_ms, MemoryStore};

/// 路径规范化：身份比较口径（与 `src/gateway/project-memory.js::projectPathKey` 一致）。
///
/// 只做「不改变语义」的归一：反斜杠统一成 `/`、去掉尾部 `/`、转小写。
/// 不做 `canonicalize`（远端 POSIX 路径在 Windows 上会被解析成盘符路径，反而更乱）。
pub(crate) fn project_path_key(input: &str) -> String {
    let mut s = input.trim().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    // Windows 盘符大小写不敏感；远端主机名也不该因为大小写分裂
    s.to_lowercase()
}

impl MemoryStore {
    /// 解析（必要时创建）项目身份。
    ///
    /// * `path`：项目根（调用方负责先剥 worktree 后缀）
    /// * `git_origin`：可选的 `remote.origin.url`，用于把「同一仓库的新路径」挂到同一 project
    pub fn resolve_project(
        &self,
        path: &str,
        git_origin: Option<&str>,
    ) -> Result<Value, CoreError> {
        let raw = path.trim();
        if raw.is_empty() {
            return Err(CoreError::rpc("INVALID_WORKSPACE", "path 必填"));
        }
        let key = project_path_key(raw);
        let origin = git_origin.map(|s| s.trim()).filter(|s| !s.is_empty());
        let now = now_ms();
        self.with_conn(|conn| {
            let existing: Option<(i64, String)> = conn
                .query_row(
                    "SELECT p.id, p.root_path FROM project_paths pp
                     JOIN projects p ON p.id = pp.project_id
                     WHERE pp.path_key = ?1",
                    params![key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((id, root)) = existing {
                let _ = conn.execute(
                    "UPDATE projects SET last_seen_at = ?1 WHERE id = ?2",
                    params![now, id],
                );
                let _ = conn.execute(
                    "UPDATE project_paths SET path = ?1 WHERE path_key = ?2",
                    params![raw, key],
                );
                // 这条路径以前可能没机会认领（进程在注册前退出过），顺手补一次
                let _ = rekey_legacy_scope_for_path(conn, id, raw);
                return Ok(json!({
                    "projectId": id,
                    "scope": format!("project:{id}"),
                    "rootPath": root,
                    "aliased": false
                }));
            }

            // 未见过这个路径：若同一个 git remote 已登记过，就把它当别名（仓库搬家/换盘符）
            if let Some(origin) = origin {
                let by_origin: Option<(i64, String)> = conn
                    .query_row(
                        "SELECT id, root_path FROM projects WHERE git_origin = ?1 ORDER BY id LIMIT 1",
                        params![origin],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((id, root)) = by_origin {
                    conn.execute(
                        "INSERT INTO project_paths (path_key, project_id, path, first_seen_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![key, id, raw, now],
                    )?;
                    let _ = conn.execute(
                        "UPDATE projects SET last_seen_at = ?1 WHERE id = ?2",
                        params![now, id],
                    );
                    let _ = rekey_legacy_scope_for_path(conn, id, raw);
                    return Ok(json!({
                        "projectId": id,
                        "scope": format!("project:{id}"),
                        "rootPath": root,
                        "aliased": true
                    }));
                }
            }

            conn.execute(
                "INSERT INTO projects (root_path, git_origin, created_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![raw, origin, now, now],
            )?;
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO project_paths (path_key, project_id, path, first_seen_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![key, id, raw, now],
            )?;
            // 首次登记即认领：老库的项目记忆 scope 是路径串，此刻才知道它属于哪个 project
            // （放到启动时做不行 —— 启动时 projects 表还是空的，一条也认领不到）。
            let _ = rekey_legacy_scope_for_path(conn, id, raw);
            Ok(json!({
                "projectId": id,
                "scope": format!("project:{id}"),
                "rootPath": raw,
                "aliased": false
            }))
        })
    }

    /// 人工挂别名（已知同一项目换了路径，但 git remote 不可用/为空时用）。
    pub fn add_project_alias(&self, project_id: i64, path: &str) -> Result<Value, CoreError> {
        let raw = path.trim();
        if raw.is_empty() {
            return Err(CoreError::rpc("INVALID_WORKSPACE", "path 必填"));
        }
        let key = project_path_key(raw);
        let now = now_ms();
        self.with_conn(|conn| {
            let exists: Option<i64> = conn
                .query_row(
                    "SELECT id FROM projects WHERE id = ?1",
                    params![project_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(CoreError::rpc("NOT_FOUND", "project 不存在"));
            }
            // 同一 project 的多条路径允许并存；若该路径已属于别的 project，直接改挂
            conn.execute(
                "INSERT INTO project_paths (path_key, project_id, path, first_seen_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path_key) DO UPDATE SET project_id = excluded.project_id, path = excluded.path",
                params![key, project_id, raw, now],
            )?;
            Ok(json!({
                "ok": true,
                "projectId": project_id,
                "scope": format!("project:{project_id}"),
                "pathKey": key
            }))
        })
    }

    /// 项目清单（含别名条数与记忆条数），给设置页/排查用。
    pub fn list_projects(&self, limit: usize) -> Result<Value, CoreError> {
        let limit = limit.clamp(1, 200) as i64;
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT p.id, p.root_path, p.git_origin, p.created_at, p.last_seen_at,
                        (SELECT COUNT(*) FROM project_paths pp WHERE pp.project_id = p.id),
                        (SELECT COUNT(*) FROM long_memories lm
                          WHERE lm.scope = 'project:' || p.id AND lm.status IN ('active','stale'))
                   FROM projects p
                  ORDER BY p.last_seen_at DESC
                  LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit], |r| {
                    Ok(json!({
                        "projectId": r.get::<_, i64>(0)?,
                        "rootPath": r.get::<_, String>(1)?,
                        "gitOrigin": r.get::<_, Option<String>>(2)?,
                        "createdAt": r.get::<_, Option<i64>>(3)?,
                        "lastSeenAt": r.get::<_, Option<i64>>(4)?,
                        "pathCount": r.get::<_, i64>(5)?,
                        "memoryCount": r.get::<_, i64>(6)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "ok": true, "results": rows }))
        })
    }

    /// 把历史「路径派生 scope」重挂到 `project:<id>`（启动自愈的一部分，幂等）。
    ///
    /// 老库里的行写着 `project:<路径>` 或 `project:<sha256前16>:<路径尾72>`。以前这两种字符串就是身份，
    /// 没法反查；现在 `projects` 表存了各项目的根路径，于是可以**正向复算**老 key 再反查：
    /// 对每个已知项目算出它当年会得到的两个 legacy key，命中就整批 UPDATE。
    ///
    /// 认领不了的（项目路径从未在新代码里出现过、目录已删除）保持原样 —— 不猜、不删。
    /// 这条 migration 让「项目记忆按 scope 精确查询」在新身份下继续生效。
    pub fn migrate_legacy_project_scopes(&self) -> Result<Value, CoreError> {
        let legacy: Vec<(String, i64)> = self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT root_path, id FROM projects ORDER BY id",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        if legacy.is_empty() {
            return Ok(json!({ "ok": true, "rewritten": 0 }));
        }
        let mut key_to_id: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (path, id) in &legacy {
            key_to_id.insert(legacy_scope_key(path), *id);
        }
        self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id, root_path FROM projects ORDER BY id")?;
            let projects: Vec<(i64, String)> = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut rewritten = 0i64;
            for (id, path) in projects {
                rewritten += rekey_legacy_scope_for_path(conn, id, &path)?;
            }
            Ok(json!({ "ok": true, "rewritten": rewritten }))
        })
    }
}

/// 把这个路径当年会得到的 legacy scope 整批改写成 `project:<id>`；返回改了行数。
///
/// 只在**知道路径属于哪个 project 的那一刻**调用（首次登记 / 挂别名 / 启动补扫），
/// 因为「路径 → project」这一层信息只有 `projects` 表有。
fn rekey_legacy_scope_for_path(
    conn: &rusqlite::Connection,
    project_id: i64,
    path: &str,
) -> Result<i64, CoreError> {
    let legacy = legacy_scope_key(path);
    let next = format!("project:{project_id}");
    if legacy == next {
        return Ok(0);
    }
    let changed = conn.execute(
        "UPDATE long_memories SET scope = ?1 WHERE scope = ?2",
        params![next, legacy],
    )?;
    Ok(changed as i64)
}

/// 老口径的 scope key（与已删除的 `src/gateway/project-memory.js::projectMemoryScope` 逐字节一致）。
///
/// 只在迁移里用来「复算历史 key」，不作为新写入口径。
pub(crate) fn legacy_scope_key(path: &str) -> String {
    if path.chars().count() <= 100 {
        return format!("project:{path}");
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(path.as_bytes());
    let head: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let tail: String = {
        let chars: Vec<char> = path.chars().collect();
        chars[chars.len().saturating_sub(72)..].iter().collect()
    };
    format!("project:{head}:{tail}")
}
