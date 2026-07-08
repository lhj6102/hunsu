use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
struct FolderSelection {
    path: String,
}

#[derive(Serialize)]
struct BridgeCommandOutput {
    status: i32,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize)]
struct BridgeCommandInput {
    args: Vec<String>,
}

#[tauri::command]
async fn choose_project_folder(app: tauri::AppHandle) -> Result<Option<FolderSelection>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("Choose a folder for Hunsu Bridge")
        .blocking_pick_folder();
    Ok(folder.map(|path| FolderSelection {
        path: path.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_bridge_sidecar(app: tauri::AppHandle, cwd: Option<String>) -> Result<(), String> {
    let mut command = Command::new(sidecar_path(&app)?);
    command.arg("start");
    if let Some(cwd) = cwd {
        command.arg("--cwd").arg(cwd);
    }
    command.arg("--no-open");
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn spawn_bridge_app_command(app: tauri::AppHandle, input: BridgeCommandInput) -> Result<(), String> {
    Command::new(sidecar_path(&app)?)
        .args(input.args)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn run_bridge_app_command(app: tauri::AppHandle, input: BridgeCommandInput) -> Result<BridgeCommandOutput, String> {
    let output = Command::new(sidecar_path(&app)?)
        .args(input.args)
        .output()
        .map_err(|error| error.to_string())?;
    Ok(BridgeCommandOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn sidecar_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_name = if cfg!(target_os = "windows") {
        "hunsu-bridge-sidecar.exe"
    } else {
        "hunsu-bridge-sidecar"
    };
    app.path()
        .resolve(resource_name, tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())
}

fn handle_protocol_url(app: &tauri::AppHandle, url: &str) {
    if let Ok(sidecar) = sidecar_path(app) {
        let _ = Command::new(sidecar).arg(url).spawn();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|arg| arg.starts_with("hunsu://")) {
                handle_protocol_url(app, url);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            for arg in std::env::args().filter(|arg| arg.starts_with("hunsu://")) {
                handle_protocol_url(&app.handle(), &arg);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_project_folder,
            open_external,
            start_bridge_sidecar,
            spawn_bridge_app_command,
            run_bridge_app_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hunsu Bridge");
}
