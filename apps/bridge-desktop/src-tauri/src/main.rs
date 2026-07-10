#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{Command as ShellCommand, CommandEvent},
    ShellExt,
};

const BRIDGE_SIDECAR_NAME: &str = "hunsu-bridge-sidecar";
const BRIDGE_TRAY_ID: &str = "hunsu-bridge";
const BRIDGE_TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Serialize)]
struct FolderSelection {
    path: String,
}

#[derive(Serialize)]
struct BinarySelection {
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
async fn choose_codex_binary(app: tauri::AppHandle) -> Result<Option<BinarySelection>, String> {
    let picker = app.dialog().file();
    #[cfg(target_os = "windows")]
    let picker = picker
        .set_title("Select codex.exe")
        .add_filter("Codex executable", &["exe"]);
    #[cfg(not(target_os = "windows"))]
    let picker = picker.set_title("Select Codex executable");
    let binary = picker.blocking_pick_file();
    binary
        .map(|path| {
            path.into_path()
                .map(|path| BinarySelection {
                    path: path.to_string_lossy().to_string(),
                })
                .map_err(|error| error.to_string())
        })
        .transpose()
}

#[tauri::command]
async fn choose_codex_home(app: tauri::AppHandle) -> Result<Option<FolderSelection>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title("Select Codex Home")
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
    let mut args = vec!["start".to_string()];
    if let Some(cwd) = cwd {
        validate_path_arg(&cwd)?;
        args.push("--cwd".to_string());
        args.push(cwd);
    }
    args.push("--no-open".to_string());
    spawn_sidecar_command(sidecar_command(&app)?.args(args))
}

#[tauri::command]
async fn spawn_bridge_app_command(
    app: tauri::AppHandle,
    input: BridgeCommandInput,
) -> Result<(), String> {
    validate_bridge_command_args(&input.args)?;
    spawn_sidecar_command(sidecar_command(&app)?.args(input.args))
}

#[tauri::command]
async fn run_bridge_app_command(
    app: tauri::AppHandle,
    input: BridgeCommandInput,
) -> Result<BridgeCommandOutput, String> {
    validate_bridge_command_args(&input.args)?;
    let output = sidecar_command(&app)?
        .args(input.args)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    Ok(BridgeCommandOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn sidecar_command(app: &tauri::AppHandle) -> Result<ShellCommand, String> {
    app.shell()
        .sidecar(BRIDGE_SIDECAR_NAME)
        .map_err(|error| error.to_string())
}

fn spawn_sidecar_command(command: ShellCommand) -> Result<(), String> {
    let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let CommandEvent::Error(error) = event {
                eprintln!("Hunsu Bridge sidecar error: {error}");
            }
        }
        drop(child);
    });
    Ok(())
}

fn validate_external_url(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.contains('\0') {
        return Err("External URL is invalid.".to_string());
    }
    if value.starts_with("hunsu://")
        || value.starts_with("https://hunsu.app/")
        || value.starts_with("https://chatgpt.com/codex")
        || is_allowed_loopback_url(value)
    {
        Ok(())
    } else {
        Err("External URL is not allowlisted.".to_string())
    }
}

fn is_allowed_loopback_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("http://") else {
        return false;
    };
    let Some((host_port, _path)) = rest.split_once('/') else {
        return false;
    };
    let Some((host, port)) = host_port.rsplit_once(':') else {
        return false;
    };
    if !matches!(host, "127.0.0.1" | "localhost") {
        return false;
    }
    !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit())
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
        "snapshot" | "status" | "stop" | "diagnostics" | "choose-folder" | "logout" => {
            args.len() == 1
        }
        "prerequisites" => args.len() == 2 && args[1] == "status",
        "ui-intent" => validate_ui_intent_args(args),
        "activate-roadmap" => {
            args.len() == 1 || (args.len() == 2 && validate_identifier_arg(&args[1]).is_ok())
        }
        "pair" => {
            args.len() == 1
                || (args.len() == 3 && args[1] == "--next" && validate_next_arg(&args[2]).is_ok())
        }
        "login" => args.len() == 2 && args[1] == "--gui",
        "remote" => args.len() == 2 && matches!(args[1].as_str(), "enable" | "disable"),
        "protocol" => args.len() == 2 && matches!(args[1].as_str(), "install" | "status"),
        "settings" => validate_settings_args(args),
        "service" => validate_service_args(args),
        "model-alias" => validate_model_alias_args(args),
        "inspect" => args.len() == 3 && args[2] == "--json" && validate_path_arg(&args[1]).is_ok(),
        "open-project" | "port" | "create" => {
            args.len() == 1 || (args.len() == 2 && validate_path_arg(&args[1]).is_ok())
        }
        "open-roadmap" => args.len() == 2 && validate_identifier_arg(&args[1]).is_ok(),
        "projects" => validate_projects_args(args),
        "roadmaps" => validate_roadmaps_args(args),
        "codex" => validate_codex_args(args),
        "provider" => validate_provider_args(args),
        "auth-callback" => validate_auth_callback_args(args),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(format!("Bridge command is not allowed: {}", command))
    }
}

fn validate_settings_args(args: &[String]) -> bool {
    matches!(
        args,
        [command, setting, action]
            if command == "settings"
                && setting == "quit-behavior"
                && action == "get"
    ) || matches!(
        args,
        [command, setting, action, value]
            if command == "settings"
                && setting == "quit-behavior"
                && action == "set"
                && matches!(value.as_str(), "keep-background" | "stop-background")
    )
}

fn validate_service_args(args: &[String]) -> bool {
    if args.len() < 2 || args[0] != "service" {
        return false;
    }
    let subcommand = args[1].as_str();
    if matches!(subcommand, "status" | "start" | "stop") {
        return args.len() == 2;
    }
    if !matches!(subcommand, "install" | "uninstall") {
        return false;
    }
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" | "--user" | "--system" => index += 1,
            "--cwd" if index + 1 < args.len() && validate_path_arg(&args[index + 1]).is_ok() => {
                index += 2
            }
            _ => return false,
        }
    }
    true
}

fn validate_model_alias_args(args: &[String]) -> bool {
    if args.len() < 2 || args[0] != "model-alias" {
        return false;
    }
    matches!(
        args[1].as_str(),
        "list" | "get" | "set" | "delete" | "validate" | "override"
    )
}

fn validate_roadmaps_args(args: &[String]) -> bool {
    match args {
        [command, subcommand] if command == "roadmaps" && subcommand == "list" => true,
        [command, subcommand, path] if command == "roadmaps" && subcommand == "add" => {
            validate_path_arg(path).is_ok()
        }
        [command, subcommand, roadmap_id]
            if command == "roadmaps"
                && matches!(subcommand.as_str(), "activate" | "deactivate" | "remove") =>
        {
            validate_identifier_arg(roadmap_id).is_ok()
        }
        [command, subcommand, mode, roadmap_id]
            if command == "roadmaps"
                && subcommand == "remote"
                && matches!(mode.as_str(), "enable" | "disable") =>
        {
            validate_identifier_arg(roadmap_id).is_ok()
        }
        [command, subcommand, mode, roadmap_id, flag, scopes]
            if command == "roadmaps"
                && subcommand == "remote"
                && mode == "enable"
                && matches!(flag.as_str(), "--scope" | "--scopes") =>
        {
            validate_identifier_arg(roadmap_id).is_ok()
                && validate_project_grant_scopes_arg(scopes).is_ok()
        }
        _ => false,
    }
}

fn validate_codex_args(args: &[String]) -> bool {
    match args {
        [command, subcommand]
            if command == "codex"
                && matches!(
                    subcommand.as_str(),
                    "status" | "install" | "recheck" | "logout"
                ) =>
        {
            true
        }
        [command, subcommand, flag]
            if command == "codex"
                && subcommand == "install"
                && matches!(flag.as_str(), "--confirm" | "--dry-run" | "--json") =>
        {
            true
        }
        [command, subcommand, first_flag, second_flag]
            if command == "codex"
                && subcommand == "install"
                && valid_codex_install_flags(&[first_flag.as_str(), second_flag.as_str()]) =>
        {
            true
        }
        [command, subcommand, first_flag, second_flag, third_flag]
            if command == "codex"
                && subcommand == "install"
                && valid_codex_install_flags(&[
                    first_flag.as_str(),
                    second_flag.as_str(),
                    third_flag.as_str(),
                ]) =>
        {
            true
        }
        [command, subcommand] if command == "codex" && subcommand == "login" => true,
        [command, subcommand, flag]
            if command == "codex" && subcommand == "login" && flag == "--api-key" =>
        {
            true
        }
        [command, subcommand, flag]
            if command == "codex" && subcommand == "login" && flag == "--device" =>
        {
            true
        }
        [command, subcommand, first_flag, second_flag]
            if command == "codex"
                && subcommand == "login"
                && valid_codex_login_flags(&[first_flag.as_str(), second_flag.as_str()]) =>
        {
            true
        }
        [command, subcommand, first_flag, second_flag, third_flag]
            if command == "codex"
                && subcommand == "login"
                && valid_codex_login_flags(&[
                    first_flag.as_str(),
                    second_flag.as_str(),
                    third_flag.as_str(),
                ]) =>
        {
            true
        }
        [command, subcommand, action]
            if command == "codex" && subcommand == "path" && action == "reset" =>
        {
            true
        }
        [command, subcommand, action, path]
            if command == "codex" && subcommand == "path" && action == "set" =>
        {
            validate_path_arg(path).is_ok()
        }
        [command, subcommand, action]
            if command == "codex" && subcommand == "home" && action == "reset" =>
        {
            true
        }
        [command, subcommand, action, path]
            if command == "codex" && subcommand == "home" && action == "set" =>
        {
            validate_path_arg(path).is_ok()
        }
        [command, subcommand, action, ..]
            if command == "codex" && subcommand == "settings" && action == "set" =>
        {
            validate_codex_settings_set_args(args)
        }
        _ => false,
    }
}

fn valid_codex_install_flags(flags: &[&str]) -> bool {
    let mut saw_confirm = false;
    let mut saw_dry_run = false;
    let mut saw_json = false;
    for flag in flags {
        match *flag {
            "--confirm" if !saw_confirm => saw_confirm = true,
            "--dry-run" if !saw_dry_run => saw_dry_run = true,
            "--json" if !saw_json => saw_json = true,
            _ => return false,
        }
    }
    true
}

fn valid_codex_login_flags(flags: &[&str]) -> bool {
    let mut saw_device = false;
    let mut saw_json = false;
    let mut saw_background = false;
    for flag in flags {
        match *flag {
            "--device" if !saw_device => saw_device = true,
            "--json" if !saw_json => saw_json = true,
            "--background" if !saw_background => saw_background = true,
            _ => return false,
        }
    }
    saw_device
}

fn validate_codex_settings_set_args(args: &[String]) -> bool {
    if args.len() < 3 || args[0] != "codex" || args[1] != "settings" || args[2] != "set" {
        return false;
    }
    let mut index = 3;
    let mut saw_install_channel = false;
    let mut saw_auth_preference = false;
    let mut saw_codex_home = false;
    let mut saw_app_server_command = false;
    let mut saw_app_server_args = false;
    while index < args.len() {
        if index + 1 >= args.len() {
            return false;
        }
        match args[index].as_str() {
            "--install-channel" if !saw_install_channel => {
                if !matches!(args[index + 1].as_str(), "stable" | "latest" | "manual") {
                    return false;
                }
                saw_install_channel = true;
            }
            "--auth-preference" if !saw_auth_preference => {
                if !matches!(
                    args[index + 1].as_str(),
                    "chatgpt" | "api_key" | "device_code"
                ) {
                    return false;
                }
                saw_auth_preference = true;
            }
            "--codex-home" if !saw_codex_home => {
                if validate_path_arg(&args[index + 1]).is_err() {
                    return false;
                }
                saw_codex_home = true;
            }
            "--app-server-command" if !saw_app_server_command => {
                if validate_plain_arg(&args[index + 1]).is_err() {
                    return false;
                }
                saw_app_server_command = true;
            }
            "--app-server-args" if !saw_app_server_args => {
                if validate_plain_arg(&args[index + 1]).is_err() {
                    return false;
                }
                saw_app_server_args = true;
            }
            _ => return false,
        }
        index += 2;
    }
    true
}

fn validate_provider_args(args: &[String]) -> bool {
    let compact: Vec<&String> = args.iter().filter(|arg| arg.as_str() != "--json").collect();
    match compact.as_slice() {
        [command, subcommand]
            if command.as_str() == "provider"
                && matches!(subcommand.as_str(), "status" | "metadata") =>
        {
            true
        }
        [command, subcommand, flag]
            if command.as_str() == "provider"
                && subcommand.as_str() == "status"
                && flag.as_str() == "--recheck" =>
        {
            true
        }
        [command, subcommand, action]
            if command.as_str() == "provider"
                && subcommand.as_str() == "config"
                && matches!(action.as_str(), "get" | "reset" | "validate") =>
        {
            true
        }
        [command, subcommand, action, value]
            if command.as_str() == "provider"
                && subcommand.as_str() == "config"
                && matches!(action.as_str(), "save-json" | "validate-json") =>
        {
            validate_plain_arg(value).is_ok()
        }
        [command, subcommand, action, key, value]
            if command.as_str() == "provider"
                && subcommand.as_str() == "config"
                && matches!(action.as_str(), "set" | "validate") =>
        {
            validate_plain_arg(key).is_ok() && validate_plain_arg(value).is_ok()
        }
        [command, subcommand]
            if command.as_str() == "provider"
                && matches!(subcommand.as_str(), "authenticate" | "login") =>
        {
            true
        }
        [command, subcommand, method]
            if command.as_str() == "provider"
                && matches!(subcommand.as_str(), "authenticate" | "login") =>
        {
            matches!(
                method.as_str(),
                "default" | "chatgpt" | "device" | "device_code" | "api_key"
            )
        }
        _ => false,
    }
}

fn validate_ui_intent_args(args: &[String]) -> bool {
    match args {
        [command, tab] if command == "ui-intent" => validate_ui_tab_arg(tab).is_ok(),
        [command, tab, detail] if command == "ui-intent" && validate_ui_tab_arg(tab).is_ok() => {
            matches!(
                (tab.as_str(), detail.as_str()),
                ("provider", "codex")
                    | ("prerequisites", "codex")
                    | ("connection", "remote")
                    | ("workspaces", "add-workspace")
                    | ("roadmaps", "add-roadmap")
            )
        }
        _ => false,
    }
}

fn validate_projects_args(args: &[String]) -> bool {
    match args {
        [command, subcommand]
            if command == "projects" && matches!(subcommand.as_str(), "list" | "recent") =>
        {
            true
        }
        [command, subcommand, path]
            if command == "projects" && matches!(subcommand.as_str(), "grant" | "revoke") =>
        {
            validate_path_arg(path).is_ok()
        }
        [command, subcommand, flag, value]
            if command == "projects" && subcommand == "remove" && flag == "--roadmap-id" =>
        {
            validate_identifier_arg(value).is_ok()
        }
        [command, subcommand, flag, value]
            if command == "projects" && subcommand == "remove" && flag == "--path" =>
        {
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

fn validate_project_grant_scopes_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if value == "all" {
        return Ok(());
    }
    let allowed = [
        "execute.start",
        "artifactAction.run",
        "env.read",
        "hostAlias.expose",
        "remoteRelay.access",
    ];
    let scopes: Vec<&str> = value.split(',').collect();
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|scope| scope.is_empty() || !allowed.contains(scope))
    {
        Err("Project Grant scopes contain unsupported values.".to_string())
    } else {
        Ok(())
    }
}

fn validate_ui_tab_arg(value: &str) -> Result<(), String> {
    validate_plain_arg(value)?;
    if matches!(
        value,
        "provider"
            | "workspaces"
            | "connection"
            | "advanced"
            | "diagnostics"
            | "settings"
            | "overview"
            | "prerequisites"
            | "roadmaps"
            | "remote"
    ) {
        Ok(())
    } else {
        Err("Bridge App tab is not supported.".to_string())
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
    if let Ok(command) = sidecar_command(app) {
        let _ = spawn_sidecar_command(command.args(args));
    }
}

fn handle_protocol_url_and_show(app: &tauri::AppHandle, url: &str) {
    handle_protocol_url(app, url);
    show_main_window(app);
}

fn start_local_bridge_on_launch(app: &tauri::AppHandle) {
    if let Ok(command) = sidecar_command(app) {
        let _ = spawn_sidecar_command(command.args(["start", "--no-open"]));
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn maybe_show_main_window_for_setup(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if should_open_main_window_on_launch(&app).await {
            show_main_window(&app);
        }
    });
}

async fn should_open_main_window_on_launch(app: &tauri::AppHandle) -> bool {
    let Ok(snapshot) = bridge_snapshot(app).await else {
        return true;
    };
    provider_needs_setup(&snapshot)
        || active_workspace_count(&snapshot) == 0
        || snapshot["status"]["healthError"].is_string()
}

fn create_bridge_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = bridge_tray_menu(app, &TrayStatusSummary::checking())?;
    TrayIconBuilder::with_id(BRIDGE_TRAY_ID)
        .tooltip("Hunsu Bridge")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "summary_title" | "summary_provider" | "summary_local" | "summary_remote"
            | "summary_workspaces" => show_main_window(app),
            "open_web" => handle_protocol_url_and_show(app, "hunsu://pair"),
            "provider" => handle_protocol_url_and_show(app, "hunsu://provider"),
            "add_workspace" => handle_protocol_url_and_show(app, "hunsu://add-workspace"),
            "workspaces" => handle_protocol_url_and_show(app, "hunsu://workspaces"),
            "connection" => handle_protocol_url_and_show(app, "hunsu://connection"),
            "diagnostics" => handle_protocol_url_and_show(app, "hunsu://diagnostics"),
            "quit" => quit_bridge_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn bridge_tray_menu(
    app: &tauri::AppHandle,
    summary: &TrayStatusSummary,
) -> tauri::Result<Menu<tauri::Wry>> {
    let title = MenuItemBuilder::with_id("summary_title", "Hunsu Bridge").build(app)?;
    let provider_status =
        MenuItemBuilder::with_id("summary_provider", summary.provider.as_str()).build(app)?;
    let local_status =
        MenuItemBuilder::with_id("summary_local", summary.local.as_str()).build(app)?;
    let remote_status =
        MenuItemBuilder::with_id("summary_remote", summary.remote.as_str()).build(app)?;
    let workspace_status =
        MenuItemBuilder::with_id("summary_workspaces", summary.workspaces.as_str()).build(app)?;
    let open_web = MenuItemBuilder::with_id("open_web", "Open Hunsu Web").build(app)?;
    let provider = MenuItemBuilder::with_id("provider", "Provider Setup").build(app)?;
    let add_workspace = MenuItemBuilder::with_id("add_workspace", "Add Workspace").build(app)?;
    let workspaces = MenuItemBuilder::with_id("workspaces", "Workspaces").build(app)?;
    let connection = MenuItemBuilder::with_id("connection", "Connection").build(app)?;
    let diagnostics = MenuItemBuilder::with_id("diagnostics", "Diagnostics").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &title,
            &provider_status,
            &local_status,
            &remote_status,
            &workspace_status,
            &open_web,
            &provider,
            &add_workspace,
            &workspaces,
            &connection,
            &diagnostics,
            &quit,
        ])
        .build()?;

    Ok(menu)
}

async fn refresh_bridge_tray_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(BRIDGE_TRAY_ID).is_none() {
        return Ok(());
    }
    let summary = tray_status_summary(app).await;
    let Some(tray) = app.tray_by_id(BRIDGE_TRAY_ID) else {
        return Ok(());
    };
    let menu = bridge_tray_menu(app, &summary)?;
    tray.set_menu(Some(menu))?;
    Ok(())
}

fn start_bridge_tray_refresh(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = refresh_bridge_tray_menu(&app).await;
            tokio::time::sleep(BRIDGE_TRAY_REFRESH_INTERVAL).await;
        }
    });
}

#[derive(Debug)]
struct TrayStatusSummary {
    provider: String,
    local: String,
    remote: String,
    workspaces: String,
}

impl TrayStatusSummary {
    fn checking() -> Self {
        Self {
            provider: "Provider: Checking".to_string(),
            local: "Local: Starting".to_string(),
            remote: "Remote: Checking".to_string(),
            workspaces: "Workspaces: Checking".to_string(),
        }
    }
}

async fn tray_status_summary(app: &tauri::AppHandle) -> TrayStatusSummary {
    match bridge_snapshot(app).await {
        Ok(snapshot) => {
            let provider_label = snapshot["providers"]["current"]["label"]
                .as_str()
                .unwrap_or("Provider");
            let provider_ready = snapshot["providers"]["current"]["ready"]
                .as_bool()
                .unwrap_or(false);
            let local = snapshot["status"]["localBridge"]
                .as_str()
                .unwrap_or("not-running");
            let remote = snapshot["status"]["remoteAccess"].as_str().unwrap_or("Off");
            TrayStatusSummary {
                provider: format!(
                    "Provider: {provider_label} {}",
                    if provider_ready {
                        "Ready"
                    } else {
                        "Needs Setup"
                    }
                ),
                local: format!("Local: {}", local_bridge_label(local)),
                remote: format!("Remote: {}", remote_bridge_label(remote, &snapshot)),
                workspaces: format!("Workspaces: {} active", active_workspace_count(&snapshot)),
            }
        }
        Err(_) => TrayStatusSummary {
            provider: "Provider: Needs Setup".to_string(),
            local: "Local: Starting".to_string(),
            remote: "Remote: Off".to_string(),
            workspaces: "Workspaces: 0 active".to_string(),
        },
    }
}

async fn bridge_snapshot(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let output = sidecar_command(app)?
        .arg("snapshot")
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn provider_needs_setup(snapshot: &serde_json::Value) -> bool {
    !snapshot["providers"]["current"]["ready"]
        .as_bool()
        .unwrap_or(false)
}

fn active_workspace_count(snapshot: &serde_json::Value) -> usize {
    snapshot["workspaces"]["active"]
        .as_array()
        .map(|items| items.len())
        .or_else(|| {
            snapshot["managedRoadmaps"].as_array().map(|items| {
                items
                    .iter()
                    .filter(|item| item["lifecycle"].as_str() == Some("active"))
                    .count()
            })
        })
        .unwrap_or(0)
}

fn local_bridge_label(value: &str) -> &'static str {
    match value {
        "connected" => "Connected",
        "starting" => "Starting",
        "error" => "Error",
        _ => "Not Running",
    }
}

fn remote_bridge_label(value: &str, snapshot: &serde_json::Value) -> &'static str {
    if snapshot["status"]["account"]
        .as_str()
        .map(|label| label.to_ascii_lowercase().contains("signed out"))
        .unwrap_or(false)
    {
        return "Sign in required";
    }
    match value {
        "On" => "On",
        "Registered but offline" => "On",
        _ => "Off",
    }
}

fn quit_bridge_app(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        quit_bridge_app_async(app).await;
    });
}

async fn quit_bridge_app_async(app: tauri::AppHandle) {
    let preference = quit_background_preference(&app).await;
    let message = match preference {
        QuitBackgroundPreference::KeepBackground => "Quit Hunsu Bridge?\n\nYour quit preference keeps the background Bridge service running.",
        QuitBackgroundPreference::StopBackground => "Quit Hunsu Bridge?\n\nYour quit preference stops the background Bridge service.",
    };
    let should_quit = app
        .dialog()
        .message(message)
        .title("Hunsu Bridge")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();
    if !should_quit {
        return;
    }
    if matches!(preference, QuitBackgroundPreference::StopBackground) {
        if let Ok(command) = sidecar_command(&app) {
            let _ = command.arg("stop").output().await;
        }
    }
    app.exit(0);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitBackgroundPreference {
    KeepBackground,
    StopBackground,
}

async fn quit_background_preference(app: &tauri::AppHandle) -> QuitBackgroundPreference {
    match bridge_snapshot(app)
        .await
        .ok()
        .and_then(|snapshot| {
            snapshot["status"]["quitBehavior"]
                .as_str()
                .map(str::to_string)
        })
        .as_deref()
    {
        Some("stop-background") => QuitBackgroundPreference::StopBackground,
        _ => QuitBackgroundPreference::KeepBackground,
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
        "open" => vec!["ui-intent".to_string(), "provider".to_string()],
        "pair" => {
            if let (Some(code), Some(state)) =
                (query_value(&query, "code"), query_value(&query, "state"))
            {
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
        "open-workspace" => {
            let workspace_id = query_value(&query, "workspaceId")
                .ok_or_else(|| "hunsu://open-workspace requires workspaceId.".to_string())?;
            vec!["open-roadmap".to_string(), workspace_id]
        }
        "add-workspace" | "add-roadmap" => {
            if let Some(path) = query_value(&query, "path") {
                vec!["roadmaps".to_string(), "add".to_string(), path]
            } else {
                vec![
                    "ui-intent".to_string(),
                    "workspaces".to_string(),
                    "add-workspace".to_string(),
                ]
            }
        }
        "workspaces" | "roadmaps" => vec!["ui-intent".to_string(), "workspaces".to_string()],
        "codex" => vec![
            "ui-intent".to_string(),
            "provider".to_string(),
            "codex".to_string(),
        ],
        "provider" => {
            let decoded_path = path_part.map(percent_decode);
            if !matches!(decoded_path.as_deref(), None | Some("codex")) {
                return Err("Unsupported hunsu://provider path.".to_string());
            }
            let mut args = vec!["ui-intent".to_string(), "provider".to_string()];
            if decoded_path.as_deref() == Some("codex") {
                args.push("codex".to_string());
            }
            args
        }
        "prerequisites" => {
            let decoded_path = path_part.map(percent_decode);
            if !matches!(decoded_path.as_deref(), None | Some("codex")) {
                return Err("Unsupported hunsu://prerequisites path.".to_string());
            }
            let mut args = vec!["ui-intent".to_string(), "provider".to_string()];
            if decoded_path.as_deref() == Some("codex") {
                args.push("codex".to_string());
            }
            args
        }
        "diagnostics" => {
            if path_part
                .map(percent_decode)
                .is_some_and(|path| !path.is_empty())
            {
                return Err("Unsupported hunsu://diagnostics path.".to_string());
            }
            vec!["ui-intent".to_string(), "diagnostics".to_string()]
        }
        "connection" => {
            let decoded_path = path_part.map(percent_decode);
            if !matches!(decoded_path.as_deref(), None | Some("remote")) {
                return Err("Unsupported hunsu://connection path.".to_string());
            }
            let mut args = vec!["ui-intent".to_string(), "connection".to_string()];
            if decoded_path.as_deref() == Some("remote") {
                args.push("remote".to_string());
            }
            args
        }
        "activate-roadmap" => {
            let roadmap_id = query_value(&query, "roadmapId")
                .ok_or_else(|| "hunsu://activate-roadmap requires roadmapId.".to_string())?;
            vec!["activate-roadmap".to_string(), roadmap_id]
        }
        "activate-workspace" => {
            let workspace_id = query_value(&query, "workspaceId")
                .ok_or_else(|| "hunsu://activate-workspace requires workspaceId.".to_string())?;
            vec!["activate-roadmap".to_string(), workspace_id]
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let protocol_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_protocol_url_and_show(&protocol_app, url.as_str());
                }
            });
            #[cfg(target_os = "linux")]
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("Could not register Hunsu Bridge deep links: {error}");
            }
            start_local_bridge_on_launch(&app.handle());
            create_bridge_tray(&app.handle())?;
            start_bridge_tray_refresh(app.handle().clone());
            let mut opened_protocol_url = false;
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    opened_protocol_url = true;
                    handle_protocol_url_and_show(&app.handle(), url.as_str());
                }
            }
            if !opened_protocol_url {
                maybe_show_main_window_for_setup(&app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_project_folder,
            choose_codex_binary,
            choose_codex_home,
            open_external,
            start_bridge_sidecar,
            spawn_bridge_app_command,
            run_bridge_app_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hunsu Bridge");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_allowlist_rejects_arbitrary_web_origins() {
        assert!(validate_external_url("hunsu://roadmaps").is_ok());
        assert!(validate_external_url("https://hunsu.app/download/bridge").is_ok());
        assert!(validate_external_url("https://chatgpt.com/codex/login").is_ok());
        assert!(validate_external_url("http://127.0.0.1:5173/studio").is_ok());
        assert!(validate_external_url("http://localhost:5173/studio").is_ok());
        assert!(validate_external_url("https://evil.example/studio").is_err());
        assert!(validate_external_url("http://example.test:5173/studio").is_err());
    }

    #[test]
    fn protocol_urls_and_sidecar_commands_are_allowlisted() {
        assert_eq!(BRIDGE_SIDECAR_NAME, "hunsu-bridge-sidecar");
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://open").unwrap(),
            vec!["ui-intent", "provider"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://pair").unwrap(),
            vec!["pair"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://pair?next=/studio").unwrap(),
            vec!["pair", "--next", "/studio"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://pair?next=/studio/roadmaps/roadmap_123").unwrap(),
            vec!["pair", "--next", "/studio/roadmaps/roadmap_123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://pair?code=abc123&state=state123").unwrap(),
            vec!["auth-callback", "--code", "abc123", "--state", "state123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://provider").unwrap(),
            vec!["ui-intent", "provider"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://provider/codex").unwrap(),
            vec!["ui-intent", "provider", "codex"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://codex").unwrap(),
            vec!["ui-intent", "provider", "codex"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://workspaces").unwrap(),
            vec!["ui-intent", "workspaces"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://add-workspace").unwrap(),
            vec!["ui-intent", "workspaces", "add-workspace"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://add-workspace?path=/tmp/example").unwrap(),
            vec!["roadmaps", "add", "/tmp/example"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://connection").unwrap(),
            vec!["ui-intent", "connection"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://connection/remote").unwrap(),
            vec!["ui-intent", "connection", "remote"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://add-roadmap").unwrap(),
            vec!["ui-intent", "workspaces", "add-workspace"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://add-roadmap?path=/tmp/example").unwrap(),
            vec!["roadmaps", "add", "/tmp/example"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://roadmaps").unwrap(),
            vec!["ui-intent", "workspaces"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://prerequisites").unwrap(),
            vec!["ui-intent", "provider"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://prerequisites/codex").unwrap(),
            vec!["ui-intent", "provider", "codex"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://diagnostics").unwrap(),
            vec!["ui-intent", "diagnostics"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://activate-roadmap?roadmapId=roadmap_123").unwrap(),
            vec!["activate-roadmap", "roadmap_123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://activate-workspace?workspaceId=roadmap_123")
                .unwrap(),
            vec!["activate-roadmap", "roadmap_123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://open-roadmap?roadmapId=roadmap_123").unwrap(),
            vec!["open-roadmap", "roadmap_123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://open-workspace?workspaceId=roadmap_123").unwrap(),
            vec!["open-roadmap", "roadmap_123"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://sign-in").unwrap(),
            vec!["login", "--gui"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://sign-out").unwrap(),
            vec!["logout"]
        );
        assert_eq!(
            bridge_args_for_protocol_url("hunsu://remote-disable").unwrap(),
            vec!["remote", "disable"]
        );
        assert!(bridge_args_for_protocol_url("hunsu://delete-everything").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://provider/other").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://prerequisites/other").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://diagnostics/other").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://connection/relay").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://open-roadmap").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://open-workspace").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://activate-roadmap").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://activate-workspace").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://activate-roadmap?roadmapId=bad/id").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://open-project?path=%00tmp").is_err());
        assert!(bridge_args_for_protocol_url("hunsu://add-roadmap?path=").is_err());
    }

    #[test]
    fn codex_sidecar_commands_cannot_pass_arbitrary_arguments() {
        assert!(validate_bridge_command_args(&["codex".into(), "login".into()]).is_ok());
        assert!(
            validate_bridge_command_args(&["codex".into(), "login".into(), "--device".into()])
                .is_ok()
        );
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--device".into(),
            "--background".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--device".into(),
            "--json".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--json".into(),
            "--device".into(),
            "--background".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--background".into()
        ])
        .is_err());
        assert!(
            validate_bridge_command_args(&["codex".into(), "login".into(), "--json".into()])
                .is_err()
        );
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--background".into(),
            "--json".into()
        ])
        .is_err());
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "login".into(),
            "--device".into(),
            "--danger".into()
        ])
        .is_err());
        assert!(
            validate_bridge_command_args(&["codex".into(), "exec".into(), "rm -rf /".into()])
                .is_err()
        );
        assert!(validate_bridge_command_args(&[
            "codex".into(),
            "home".into(),
            "set".into(),
            "/tmp/codex-home".into()
        ])
        .is_ok());
        assert!(
            validate_bridge_command_args(&["codex".into(), "home".into(), "reset".into()]).is_ok()
        );
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "metadata".into(),
            "--json".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "config".into(),
            "validate-json".into(),
            r#"[{"key":"codexHome","value":"/tmp/codex-home","isSet":true,"isSecret":false}]"#
                .into(),
            "--json".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "config".into(),
            "save-json".into(),
            r#"[{"key":"binaryPath","value":"/tmp/codex","isSet":true,"isSecret":false}]"#.into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "config".into(),
            "reset".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "config".into(),
            "save-json".into(),
            "\0".into()
        ])
        .is_err());
        assert!(validate_bridge_command_args(&[
            "provider".into(),
            "shell".into(),
            "rm -rf /".into()
        ])
        .is_err());
        assert!(validate_bridge_command_args(&[
            "settings".into(),
            "quit-behavior".into(),
            "get".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "settings".into(),
            "quit-behavior".into(),
            "set".into(),
            "keep-background".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "settings".into(),
            "quit-behavior".into(),
            "set".into(),
            "stop-background".into()
        ])
        .is_ok());
        assert!(validate_bridge_command_args(&[
            "settings".into(),
            "quit-behavior".into(),
            "set".into(),
            "delete-state".into()
        ])
        .is_err());
    }
}
