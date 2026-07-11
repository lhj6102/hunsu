import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { HunsuPaths } from "../state/index.ts";
import { BRIDGE_CONTROL_TOKEN_HEADER } from "../client/controlClient.ts";
import { BridgeError } from "../client/cliResult.ts";

export type DaemonStartupLock = {
  release(): Promise<void>;
};

export type EndpointProbe =
  | { kind: "unreachable" }
  | { kind: "foreign" }
  | { kind: "hunsu-unauthenticated" }
  | { kind: "hunsu-authenticated"; instanceId?: string };

export async function acquireDaemonStartupLock(input: {
  paths: HunsuPaths;
  endpoint: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
  pid?: number;
  now?: () => Date;
  processAlive?: (pid: number) => boolean;
}): Promise<DaemonStartupLock> {
  const pid = input.pid ?? process.pid;
  const now = input.now ?? (() => new Date());
  const processAlive = input.processAlive ?? isProcessAlive;
  const fetchImpl = input.fetchImpl ?? fetch;
  await mkdir(dirname(input.paths.daemonLockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(input.paths.daemonLockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid, createdAt: now().toISOString() })}\n`, "utf8");
      } finally {
        await handle.close();
      }

      const probe = await probeDaemonEndpoint({
        endpoint: input.endpoint,
        controlToken: input.controlToken,
        fetchImpl
      });
      if (probe.kind !== "unreachable") {
        await safeUnlink(input.paths.daemonLockFile);
        throw endpointOwnershipError(probe);
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await safeUnlink(input.paths.daemonLockFile);
        }
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (!isAlreadyExists(error)) throw error;

      const lockPid = await readLockPid(input.paths.daemonLockFile);
      const probe = await probeDaemonEndpoint({
        endpoint: input.endpoint,
        controlToken: input.controlToken,
        fetchImpl
      });
      const recordedOwnerIsDead = lockPid !== undefined && !processAlive(lockPid);
      if (recordedOwnerIsDead && probe.kind === "unreachable" && attempt === 0) {
        await safeUnlink(input.paths.daemonLockFile);
        continue;
      }
      if (probe.kind !== "unreachable") {
        throw endpointOwnershipError(probe);
      }
      throw new BridgeError(
        "BRIDGE_ALREADY_RUNNING",
        "Another Hunsu Bridge daemon startup is already in progress."
      );
    }
  }
  throw new BridgeError("BRIDGE_ALREADY_RUNNING", "Another Hunsu Bridge daemon startup is already in progress.");
}

export async function probeDaemonEndpoint(input: {
  endpoint: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EndpointProbe> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 750;
  let health: Response;
  try {
    health = await fetchImpl(new URL("/health", input.endpoint), {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (_error) {
    return { kind: "unreachable" };
  }
  if (!health.ok) {
    return { kind: "foreign" };
  }
  const body = await health.json().catch(() => undefined) as { ok?: unknown; service?: unknown; protocolVersion?: unknown } | undefined;
  if (body?.ok !== true || body.service !== "hunsu-bridge" || body.protocolVersion !== "local-bridge-v1") {
    return { kind: "foreign" };
  }
  try {
    const status = await fetchImpl(new URL("/v1/control/status", input.endpoint), {
      headers: { [BRIDGE_CONTROL_TOKEN_HEADER]: input.controlToken },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!status.ok) {
      return { kind: "hunsu-unauthenticated" };
    }
    const result = await status.json().catch(() => undefined) as {
      ok?: unknown;
      value?: { instanceId?: unknown };
    } | undefined;
    return result?.ok === true
      ? {
          kind: "hunsu-authenticated",
          ...(typeof result.value?.instanceId === "string" ? { instanceId: result.value.instanceId } : {})
        }
      : { kind: "hunsu-unauthenticated" };
  } catch (_error) {
    return { kind: "hunsu-unauthenticated" };
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function endpointOwnershipError(probe: Exclude<EndpointProbe, { kind: "unreachable" }>): BridgeError {
  return probe.kind === "hunsu-authenticated"
    ? new BridgeError("BRIDGE_ALREADY_RUNNING", "Hunsu Bridge is already running.")
    : new BridgeError("BRIDGE_PORT_IN_USE", "The configured Hunsu Bridge port is already in use by another service.");
}

async function readLockPid(path: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
