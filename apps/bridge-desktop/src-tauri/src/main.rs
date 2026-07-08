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
    folder
        .map(|path| {
            path.into_path()
                .map(|path| FolderSelection {
                    path: path.to_string_lossy().to_string(),
                })
                .map_err(|error| error.to_string())
        })
        .transpose()
}

#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_bridge_sidecar(app: tauri::AppHandle, cwd: Option<String>) -> Result<(), String> {
    let mut command = Command::new(sidecar_path(&app)?);
    command.arg("start");
    if let Some(cwd) = cwd {
        validate_path_arg(&cwd)?;
        command.arg("--cwd").arg(cwd);
    }
    command.arg("--no-open");
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn spawn_bridge_app_command(app: tauri::AppHandle, input: BridgeCommandInput) -> Result<(), String> {
    validate_bridge_command_args(&input.args)?;
    Command::new(sidecar_path(&app)?)
        .args(input.args)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn run_bridge_app_command(app: tauri::AppHandle, input: BridgeCommandInput) -> Result<BridgeCommandOutput, String> {
    validate_bridge_command_args(&input.args)?;
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

fn validate_external_url(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.contains('\0') {
        return Err("External URL is invalid.".to_string());
    }
    let allowed = value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("hunsu://");
    if allowed {
        Ok(())
    } else {
        Err("External URL scheme is not allowed.".to_string())
    }
}

fn validate_bridge_command_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("Bridge command is required.".to_string());
    }
    for arg in args {
        validate_plain_arg(arg)?;
    }
    let command = args[0].as_str();
    let allowed = match command {
        "snapshot" | "status" | "stop" | "diagnostics" | "choose-folder" | "logout" => args.len() == 1,
        "pair" => {
            args.len() == 1
                || (args.len() == 3 && args[1] == "--next" && validate_next_arg(&args[2]).is_ok())
        }
        "login" => args.len() == 2 && args[1] == "--gui",
        "remote" => args.len() == 2 && matches!(args[1].as_str(), "enable" | "disable"),
        "protocol" => args.len() == 2 && matches!(args[1].as_str(), "install" | "status"),
        "inspect" => args.len() == 3 && args[2] == "--json" && validate_path_arg(&args[1]).is_ok(),
        "open-project" | "port" | "create" => {
            args.len() == 1 || (args.len() == 2 && validate_path_arg(&args[1]).is_ok())
        }
        "open-roadmap" => args.len() == 2 && validate_identifier_arg(&args[1]).is_ok(),
        "projects" => validate_projects_args(args),
        "auth-callback" => validate_auth_callback_args(args),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(format!("Bridge command is not allowed: {}", command))
    }
}

fn validate_projects_args(args: &[String]) -> bool {
    match args {
        [command, subcommand] if command == "projects" && matches!(subcommand.as_str(), "list" | "recent") => true,
        [command, subcommand, path] if command == "projects" && matches!(subcommand.as_str(), "grant" | "revoke") => {
            validate_path_arg(path).is_ok()
        }
        [command, subcommand, flag, value] if command == "projects" && subcommand == "remove" && flag == "--roadmap-id" => {
            validate_identifier_arg(value).is_ok()
        }
        [command, subcommand, flag, value] if command == "projects" && subcommand == "remove" && flag == "--path" => {
            validate_path_arg(value).is_ok()
        }
        [command, subcommand, value] if command == "projects" && subcommand == "remove" => {
            validate_plain_arg(value).is_ok()
        }
        _ => false,
    }
}

fn validate_auth_callback_args(args: &[String]) -> bool {
    args.len() == 5
        && args[0] == "auth-callback"
        && args[1] == "--code"
        && validate_oauth_arg(&args[2]).is_ok()
        && args[3] == "--state"
        && validate_oauth_arg(&args[4]).is_ok()
}

fn validate_plain_arg(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        Err("Bridge command argument is invalid.".to_string())
    } else {
        Ok(())
    }
}

fn validate_path_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if value.trim().is_empty() {
        Err("Path argument is empty.".to_string())
    } else {
        Ok(())
    }
}

fn validate_identifier_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
    {
        Ok(())
    } else {
        Err("Identifier argument contains unsupported characters.".to_string())
    }
}

fn validate_oauth_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '~'))
    {
        Ok(())
    } else {
        Err("OAuth callback argument contains unsupported characters.".to_string())
    }
}

fn validate_next_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if value.starts_with("/studio") && !value.starts_with("//") {
        Ok(())
    } else {
        Err("Studio next route is not allowed.".to_string())
    }
}

fn handle_protocol_url(app: &tauri::AppHandle, url: &str) {
    let args = match bridge_args_for_protocol_url(url) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    if let Ok(sidecar) = sidecar_path(app) {
        let _ = Command::new(sidecar).args(args).spawn();
    }
}

fn bridge_args_for_protocol_url(value: &str) -> Result<Vec<String>, String> {
    validate_external_url(value)?;
    let without_scheme = value
        .strip_prefix("hunsu://")
        .ok_or_else(|| "Unsupported protocol URL.".to_string())?;
    let (command_part, query_part) = match without_scheme.split_once('?') {
        Some((command, query)) => (command, Some(query)),
        None => (without_scheme, None),
    };
    let (command, path_part) = match command_part.split_once('/') {
        Some((host, path)) => (host, Some(path)),
        None => (command_part, None),
    };
    let query = parse_query(query_part.unwrap_or(""));
    let args = match command {
        "open" => vec!["status".to_string()],
        "pair" => {
            if let (Some(code), Some(state)) = (query_value(&query, "code"), query_value(&query, "state")) {
                vec![
                    "auth-callback".to_string(),
                    "--code".to_string(),
                    code,
                    "--state".to_string(),
                    state,
                ]
            } else {
                let mut args = vec!["pair".to_string()];
                if let Some(next) = query_value(&query, "next") {
                    args.push("--next".to_string());
                    args.push(next);
                }
                args
            }
        }
        "open-project" => {
            let path = query_value(&query, "path").or_else(|| path_part.map(percent_decode));
            let mut args = vec!["open-project".to_string()];
            if let Some(path) = path.filter(|path| !path.is_empty() && path != "open-project") {
                args.push(path);
            }
            args
        }
        "open-roadmap" => {
            let roadmap_id = query_value(&query, "roadmapId")
                .ok_or_else(|| "hunsu://open-roadmap requires roadmapId.".to_string())?;
            vec!["open-roadmap".to_string(), roadmap_id]
        }
        "sign-in" => vec!["login".to_string(), "--gui".to_string()],
        "sign-out" => vec!["logout".to_string()],
        "remote-disable" => vec!["remote".to_string(), "disable".to_string()],
        _ => return Err(format!("Unsupported hunsu:// command: {command}")),
    };
    validate_bridge_command_args(&args)?;
    Ok(args)
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn query_value(query: &[(String, String)], key: &str) -> Option<String> {
    query
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.clone())
}

fn percent_decode(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            if let Ok(hex) = std::str::from_utf8(&raw[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    bytes.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        bytes.push(if raw[index] == b'+' { b' ' } else { raw[index] });
        index += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
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
