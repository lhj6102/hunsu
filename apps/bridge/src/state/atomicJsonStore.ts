import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type BridgeStateErrorCode = "BRIDGE_STATE_INVALID";

export class BridgeStateError extends Error {
  readonly code: BridgeStateErrorCode = "BRIDGE_STATE_INVALID";
  readonly file: string;

  constructor(file: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BridgeStateError";
    this.file = file;
  }
}

export async function readJsonState(file: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new BridgeStateError(file, `Unable to read Bridge state file: ${basename(file)}.`, { cause: error });
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BridgeStateError(file, `Bridge state file is not valid JSON: ${basename(file)}.`, { cause: error });
  }
}

export async function writeJsonStateAtomic(
  file: string,
  value: unknown,
  options: {
    mode?: number;
    prepareTemporaryFile?: (temporaryFile: string) => Promise<void>;
    onCommitted?: () => void;
  } = {}
): Promise<void> {
  const directory = dirname(file);
  const mode = options.mode ?? 0o600;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryFile = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryFile, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await options.prepareTemporaryFile?.(temporaryFile);
    await rename(temporaryFile, file);
    options.onCommitted?.();
  } catch (error) {
    throw new BridgeStateError(file, `Unable to persist Bridge state file: ${basename(file)}.`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryFile).catch(error => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export function invalidState(file: string, detail: string): BridgeStateError {
  return new BridgeStateError(file, `Bridge state file is invalid (${basename(file)}): ${detail}`);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
