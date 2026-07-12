import { win32 } from "node:path";

const INCOMPATIBLE_MODULE_PATH_KEYS = new Set([
  "psmodulepath",
  "winpsmodulepath"
]);

export function isWindowsPowerShellCommand(command: string): boolean {
  const executable = win32.basename(command).toLowerCase();
  return executable === "powershell" || executable === "powershell.exe";
}

export function windowsPowerShellEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (INCOMPATIBLE_MODULE_PATH_KEYS.has(key.toLowerCase()) || value === undefined) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
