import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { currentProcessEnv } from "@hunsu/config";

const execFileAsync = promisify(execFile);

export type NativeFolderPickerResult =
  | { ok: true; path: string; picker: "macos-osascript" | "windows-folder-dialog" | "linux-zenity" | "linux-kdialog" }
  | { ok: false; reason: "cancelled" | "no_gui" | "unavailable"; message: string };

type NativeFolderPickerName = Extract<NativeFolderPickerResult, { ok: true }>["picker"];

export async function chooseNativeFolder(input: { title?: string } = {}): Promise<NativeFolderPickerResult> {
  const title = input.title ?? "Choose a folder for Hunsu Bridge";
  const os = platform();
  if (os === "darwin") {
    return runPicker("macos-osascript", "osascript", [
      "-e",
      `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`
    ]);
  }
  if (os === "win32") {
    return runPicker("windows-folder-dialog", "powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = ${JSON.stringify(title)}`,
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
      ].join("; ")
    ]);
  }
  const env = currentProcessEnv();
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      ok: false,
      reason: "no_gui",
      message: "No graphical session is available. Use `hunsu-bridge open-project <path>` on this machine."
    };
  }
  const zenity = await runPicker("linux-zenity", "zenity", ["--file-selection", "--directory", "--title", title]);
  if (zenity.ok || zenity.reason === "cancelled") {
    return zenity;
  }
  return runPicker("linux-kdialog", "kdialog", ["--getexistingdirectory", homedir()]);
}

export type ProtocolRegistrationPlan = {
  platform: NodeJS.Platform;
  protocol: "hunsu";
  supported: boolean;
  installerManaged: boolean;
  commands: string[];
  notes: string[];
};

export function protocolRegistrationPlan(commandPath: string, args: string[] = []): ProtocolRegistrationPlan {
  const resolvedCommand = resolve(commandPath);
  const execLine = commandLine([resolvedCommand, ...args, "%u"]);
  const os = platform();
  if (os === "linux") {
    const desktopFile = join(homedir(), ".local", "share", "applications", "hunsu-bridge.desktop");
    return {
      platform: os,
      protocol: "hunsu",
      supported: true,
      installerManaged: false,
      commands: [
        `write ${desktopFile}`,
        `xdg-mime default hunsu-bridge.desktop x-scheme-handler/hunsu`
      ],
      notes: [`Exec=${execLine}`]
    };
  }
  if (os === "darwin") {
    return {
      platform: os,
      protocol: "hunsu",
      supported: true,
      installerManaged: true,
      commands: ["Register CFBundleURLSchemes=hunsu in the Hunsu Bridge app bundle Info.plist."],
      notes: ["The Tauri bundle config owns macOS protocol registration during app packaging."]
    };
  }
  if (os === "win32") {
    return {
      platform: os,
      protocol: "hunsu",
      supported: true,
      installerManaged: true,
      commands: ["Register HKCU\\Software\\Classes\\hunsu\\shell\\open\\command in the Windows installer."],
      notes: [`Default command: ${commandLine([resolvedCommand, ...args, "%1"])}`]
    };
  }
  return {
    platform: os,
    protocol: "hunsu",
    supported: false,
    installerManaged: false,
    commands: [],
    notes: ["Unsupported platform for automatic hunsu:// registration."]
  };
}

export function installLinuxProtocolHandler(commandPath: string, args: string[] = []): ProtocolRegistrationPlan {
  const plan = protocolRegistrationPlan(commandPath, args);
  if (plan.platform !== "linux" || !plan.supported) {
    return plan;
  }
  const desktopFile = join(homedir(), ".local", "share", "applications", "hunsu-bridge.desktop");
  mkdirSync(dirname(desktopFile), { recursive: true });
  writeFileSync(desktopFile, [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Hunsu Bridge",
    `Exec=${commandLine([resolve(commandPath), ...args, "%u"])}`,
    "Terminal=false",
    "MimeType=x-scheme-handler/hunsu;",
    "NoDisplay=true",
    ""
  ].join("\n"), "utf8");
  try {
    execFileSync("xdg-mime", ["default", "hunsu-bridge.desktop", "x-scheme-handler/hunsu"], {
      stdio: "ignore",
      windowsHide: true
    });
  } catch (_error) {
    plan.notes.push("xdg-mime was not available; run `xdg-mime default hunsu-bridge.desktop x-scheme-handler/hunsu` after install.");
  }
  return plan;
}

function commandLine(args: string[]): string {
  return args.map(arg => /\s/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg).join(" ");
}

async function runPicker(
  picker: NativeFolderPickerName,
  command: string,
  args: string[]
): Promise<NativeFolderPickerResult> {
  try {
    const { stdout } = await execFileAsync(command, args, { windowsHide: true });
    const selectedPath = stdout.trim();
    if (!selectedPath) {
      return { ok: false, reason: "cancelled", message: "Folder selection was cancelled." };
    }
    if (!existsSync(selectedPath)) {
      return { ok: false, reason: "unavailable", message: `Selected folder does not exist: ${selectedPath}` };
    }
    return { ok: true, path: selectedPath, picker };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
    if (code === "ENOENT") {
      return { ok: false, reason: "unavailable", message: `${command} is not available on this system.` };
    }
    return { ok: false, reason: "cancelled", message: "Folder selection was cancelled." };
  }
}
