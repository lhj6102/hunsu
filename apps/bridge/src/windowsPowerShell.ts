import { win32 } from "node:path";

const INCOMPATIBLE_MODULE_PATH_KEYS = new Set([
  "psmodulepath",
  "winpsmodulepath"
]);

export type WindowsPowerShellInvocation = {
  command: "powershell.exe";
  args: string[];
};

export function windowsCurrentUserOnlyFileAclPowerShellInvocation(
  path: string,
  pathVariableName: string
): WindowsPowerShellInvocation {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error("Windows ACL paths cannot contain control characters.");
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(pathVariableName)) {
    throw new Error("Windows ACL PowerShell variable names must be identifiers.");
  }

  const pathVariable = `$${pathVariableName}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `${pathVariable} = ${powerShellStringLiteral(path)}`,
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.Security.AccessControl.FileSecurity]::new()",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl.SetAccessRule($rule)",
    `[System.IO.File]::SetAccessControl(${pathVariable}, $acl)`
  ].join("; ");

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")
    ]
  };
}

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

function powerShellStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
