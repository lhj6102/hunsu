export type CodexCommandLaunch = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

export function codexCommandLaunch(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): CodexCommandLaunch {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args };
  }
  const comSpec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  return {
    command: comSpec,
    args: ["/d", "/s", "/v:off", "/c", windowsCmdCommandLine(command, args)],
    windowsVerbatimArguments: true
  };
}

function windowsCmdCommandLine(command: string, args: string[]): string {
  return `"${[command, ...args].map(quoteWindowsCmdArgument).join(" ")}"`;
}

function quoteWindowsCmdArgument(value: string): string {
  // cmd expands percent variables even inside quotes, and embedded quotes or
  // control characters would escape this deliberately narrow shim boundary.
  if (/[%"\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Windows command-shim paths and arguments cannot contain percent, quote, or control characters.");
  }
  return `"${value}"`;
}
