use std::path::PathBuf;

use clap::{Parser, Subcommand};
use dieyun_core::config::AppConfig;
use dieyun_core::index::IndexService;
use dieyun_core::new_state;
use dieyun_core::rpc::stdio::serve_stdio;

#[derive(Parser)]
#[command(name = "dieyun-core", about = "Dieyun Rust core sidecar")]
struct Cli {
    #[arg(long, global = true, env = "DIEYUN_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// JSON-RPC over stdin/stdout (one request per line)
    ServeStdio {
        #[arg(long)]
        workspace: Option<PathBuf>,
    },
    /// Index a workspace and print status JSON
    Index {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long, default_value_t = true)]
        force: bool,
    },
    /// Search indexed workspace
    Search {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        query: String,
        #[arg(long, default_value_t = 8)]
        limit: u32,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let mut config = AppConfig::default();
    if let Some(dir) = cli.data_dir {
        config.data_dir = dir;
    }

    match cli.command {
        Commands::ServeStdio { workspace } => {
            if let Some(ws) = workspace {
                config
                    .apply_configure(&dieyun_core::config::ConfigureParams {
                        data_dir: None,
                        workspace_roots: vec![ws.to_string_lossy().into_owned()],
                        embedding: Default::default(),
                        llm: Default::default(),
                        models_dirs: Default::default(),
                        ..Default::default()
                    })
                    .ok();
            }
            std::fs::create_dir_all(&config.data_dir)?;
            serve_stdio(new_state(config)).await
        }
        Commands::Index { workspace, force } => {
            config
                .apply_configure(&dieyun_core::config::ConfigureParams {
                    data_dir: None,
                    workspace_roots: vec![workspace.to_string_lossy().into_owned()],
                    embedding: Default::default(),
                    llm: Default::default(),
                    models_dirs: Default::default(),
                    ..Default::default()
                })
                .ok();
            std::fs::create_dir_all(&config.data_dir)?;
            let svc = IndexService::from_config(&config);
            let st = svc
                .index_workspace(&workspace.to_string_lossy(), force)
                .await?;
            println!("{}", serde_json::to_string_pretty(&st)?);
            Ok(())
        }
        Commands::Search {
            workspace,
            query,
            limit,
        } => {
            config
                .apply_configure(&dieyun_core::config::ConfigureParams {
                    data_dir: None,
                    workspace_roots: vec![workspace.to_string_lossy().into_owned()],
                    embedding: Default::default(),
                    llm: Default::default(),
                    models_dirs: Default::default(),
                    ..Default::default()
                })
                .ok();
            std::fs::create_dir_all(&config.data_dir)?;
            let svc = IndexService::from_config(&config);
            let sr = svc
                .search(&workspace.to_string_lossy(), &query, Some(limit))
                .await?;
            println!("{}", serde_json::to_string_pretty(&sr)?);
            Ok(())
        }
    }
}
