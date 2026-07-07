#!/usr/bin/env node
import { startStudioBridge } from "./index.ts";

type ParsedArgs = {
  command?: string;
  flags: Map<string, string | boolean>;
};

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || hasFlag(parsed, "help")) {
    printHelp();
    return 0;
  }
  if (parsed.command && parsed.command !== "start" && parsed.command !== "studio") {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  await startStudioBridge({
    cwd: getFlag(parsed, "cwd") ?? process.cwd(),
    webUrl: getFlag(parsed, "web-url"),
    noOpen: hasFlag(parsed, "no-open"),
    dryRun: hasFlag(parsed, "dry-run"),
    json: hasFlag(parsed, "json")
  });
  return 0;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      command ??= token;
      continue;
    }
    const rawName = token.slice(2);
    const equalsIndex = rawName.indexOf("=");
    if (equalsIndex >= 0) {
      flags.set(rawName.slice(0, equalsIndex), rawName.slice(equalsIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
      continue;
    }
    flags.set(rawName, true);
  }
  return { command, flags };
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function printHelp(): void {
  console.log(`Usage: hunsu-bridge [start|studio] [options]

Options:
  --cwd <path>       Repository or workspace path to open. Defaults to the current directory.
  --web-url <url>    Studio URL to pair with. Defaults to HUNSU_WEB_URL or https://hunsu.app/studio.
  --no-open          Print the paired Studio URL without opening a browser.
  --dry-run          Print start information without starting the Bridge server.
  --json             Print start information as JSON.
  --help             Show this help.
`);
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
