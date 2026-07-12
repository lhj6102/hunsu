import { BridgeError } from "./cliResult.ts";

export type ParsedBridgeCliArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

const GLOBAL_OPTIONS = new Set(["home", "json", "help", "version"]);

const BOOLEAN_OPTIONS = new Set([
  "json",
  "help",
  "version",
  "follow",
  "delete-data",
  "confirm-delete-data",
  "no-open",
  "dry-run"
]);

const VALUE_OPTIONS = new Set([
  "home",
  "host",
  "port",
  "cwd",
  "web-url",
  "channel",
  "runtime-package",
  "binary",
  "codex-home",
  "workspace",
  "scopes"
]);

export function parseBridgeCliArgs(argv: string[]): ParsedBridgeCliArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (!raw) throw invalidOption("Invalid empty command option.");
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    assertKnownOption(name);
    if (flags.has(name)) throw invalidOption(`Duplicate option: --${name}.`);

    if (BOOLEAN_OPTIONS.has(name)) {
      if (equals >= 0) throw invalidOption(`--${name} does not accept a value.`);
      flags.set(name, true);
      continue;
    }

    const value = equals >= 0 ? raw.slice(equals + 1) : argv[index + 1];
    if (!value || (equals < 0 && value.startsWith("--"))) {
      throw invalidOption(`--${name} requires a value.`);
    }
    flags.set(name, value);
    if (equals < 0) index += 1;
  }

  const parsed = { positionals, flags };
  validateCommandOptions(parsed);
  return parsed;
}

export function bridgeCliJsonRequested(argv: readonly string[]): boolean {
  return argv.some(argument => argument === "--json" || argument.startsWith("--json="));
}

export function getFlag(parsed: ParsedBridgeCliArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(parsed: ParsedBridgeCliArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function assertKnownOption(name: string): void {
  if (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) {
    throw invalidOption(`Unknown option: --${name}.`);
  }
}

function validateCommandOptions(parsed: ParsedBridgeCliArgs): void {
  const command = parsed.positionals[0];
  if (!command) {
    assertAllowedOptions(parsed, GLOBAL_OPTIONS, "help");
    return;
  }

  const commandOptions = new Set(GLOBAL_OPTIONS);
  switch (command) {
    case "dev":
    case "daemon":
      addOptions(commandOptions, "host", "port", "cwd", "web-url");
      break;
    case "setup":
      addOptions(commandOptions, "channel", "runtime-package", "dry-run");
      break;
    case "remove":
      addOptions(commandOptions, "delete-data", "confirm-delete-data", "dry-run");
      break;
    case "logs":
      addOptions(commandOptions, "follow");
      break;
    case "provider":
      if (parsed.positionals[1] === "set") addOptions(commandOptions, "binary", "codex-home");
      break;
    case "workspace":
      if (parsed.positionals[1] === "grant") addOptions(commandOptions, "scopes");
      break;
    case "pair":
    case "open":
      addOptions(commandOptions, "workspace");
      break;
    case "login":
      addOptions(commandOptions, "no-open");
      break;
    default:
      break;
  }
  assertAllowedOptions(parsed, commandOptions, command);
}

function addOptions(target: Set<string>, ...options: string[]): void {
  for (const option of options) target.add(option);
}

function assertAllowedOptions(parsed: ParsedBridgeCliArgs, allowed: ReadonlySet<string>, command: string): void {
  for (const option of parsed.flags.keys()) {
    if (!allowed.has(option)) {
      throw invalidOption(`Option --${option} is not supported by ${command}.`);
    }
  }
}

function invalidOption(message: string): BridgeError {
  return new BridgeError("BRIDGE_STATE_INVALID", message);
}
