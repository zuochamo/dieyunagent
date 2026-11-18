//! 工作区回收与「路径/卷是否还在」的判定。
//!
//! 从 `index/mod.rs` 机械搬来（纯移动）。两条硬边界：**工程标记与宽限期永不自动删**、
//! **用户自选的工作空间不动**；Windows 上「整卷离线」也不删（Linux 分支的判定更宽，
//! 见 `volume_root` 的注释 —— 那是既有行为，本次只搬家不改语义）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::params;

use super::{delete_all_chunks, workspace, IndexService};

impl IndexService {

    /// 清掉「本地根目录已经不存在」的工作区的索引行（chunks / 向量 / 图谱 / workspaces 行）。
    ///
    /// 为什么不能靠读路径顺手清：`status`、`search` 这些入口第一步都是 `resolve_workspace`，
    /// 路径不存在就直接 `INVALID_WORKSPACE` 返回，**根本走不到那一行**，于是被删掉的项目
    /// 会永远躺在库里（`D:\opencode\wechat` 实测留了 53,538 段）。
    ///
    /// 宁可不删的两条边界：
    /// - 远端工作区（`ssh://...` 的 key 不是本地路径）：本地看不看得见与它的数据无关；
    /// - 整卷离线（移动盘没插，`F:\` 本身不存在）：那是暂时的，删掉等于让用户插回盘后
    ///   白重建一次向量（几小时）。
    ///
    /// 返回被清掉的工作区路径，供调用方记日志。
    pub fn prune_missing_workspaces(&self) -> Vec<String> {
        let Ok(conn) = self.open_dedicated() else {
            return Vec::new();
        };
        // 两处都会留「目录已消失」的行：索引行在 `workspaces`，图谱行在 `graph_workspaces`
        // （只建过图谱、索引后来被重置的仓库只在后者留痕）。按 root_hash 取并集。
        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT root_hash, root_path FROM workspaces
                 UNION
                 SELECT root_hash, root_path FROM graph_workspaces",
            )
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .and_then(|it| it.collect())
            })
            .unwrap_or_default();

        let mut seen: HashSet<String> = HashSet::new();
        let mut removed = Vec::new();
        for (root_hash, root_path) in rows {
            if !seen.insert(root_hash.clone())
                || workspace::is_remote_workspace_key(&root_path)
                || !local_root_vanished(Path::new(&root_path))
            {
                continue;
            }
            if delete_all_chunks(&conn, &root_hash).is_err() {
                continue;
            }
            // 两处必须一起清：只清 chunks 不清图谱，`graph_*` 查询会拿到没有 chunk 支撑的符号；
            // 只清一半还照样把 workspace 报成「已回收」，就是最坏的静默半应用。
            //
            // 失败**不静默**：打一行诊断并跳过这个工作区（行留在库里，下次启动重试）。不往上报
            // 是因为唯一调用方是起动期的 `IndexService::from_config` —— 清理失败不该让 core
            // 起不来，但也不能当它没发生。
            if let Err(e) = crate::graph::clear_workspace_rows(&conn, &root_hash) {
                eprintln!(
                    "[index] 工作区 {} 的图谱清理失败，整条留到下次启动重试：{e}",
                    root_path
                );
                continue;
            }
            if conn
                .execute(
                    "DELETE FROM workspaces WHERE root_hash = ?1",
                    params![root_hash],
                )
                .is_ok()
            {
                self.clear_progress(&root_hash);
                removed.push(root_path);
            }
        }
        removed
    }


}

/// 本地根目录「确实没了」，而不是「整卷暂时不在」。
///
/// 判据：根目录不存在，但它所在的**卷根**还在 —— 目录被删或被改名；连卷根都找不着，
/// 说明盘没插（移动硬盘 / 网络盘），这种情况保守跳过：插回盘后索引仍然有效。
pub(crate) fn local_root_vanished(path: &Path) -> bool {
    if path.exists() {
        return false;
    }
    volume_root(path).map(|v| v.exists()).unwrap_or(false)
}


#[cfg(windows)]
pub(crate) fn volume_root(path: &Path) -> Option<PathBuf> {
    match path.components().next()? {
        std::path::Component::Prefix(prefix) => {
            let mut s = prefix.as_os_str().to_os_string();
            s.push("\\");
            Some(PathBuf::from(s))
        }
        _ => None,
    }
}


#[cfg(not(windows))]
pub(crate) fn volume_root(_path: &Path) -> Option<PathBuf> {
    Some(PathBuf::from("/"))
}

