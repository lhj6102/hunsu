import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "@hunsu/bridge";

export type SidecarStatus =
  | { status: "stopped"; restartCount: number }
  | { status: "starting"; restartCount: number }
  | { status: "running"; pid: number; restartCount: number; startedAt: string }
  | { status: "crashed"; restartCount: number; exitCode?: number | null; signal?: NodeJS.Signals | null }
  | { status: "stopping"; pid?: number; restartCount: number };

export type SidecarSupervisorOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  restartLimit?: number;
  restartDelayMs?: number;
};

/**
 * A daemon uses this process exit code when startup cannot succeed without
 * external intervention.  The supervisor must not restart these failures.
 * 78 is EX_CONFIG on platforms that define sysexits.h and is also preserved by
 * Windows process exit status handling.
 */
export const BRIDGE_SIDECAR_TERMINAL_EXIT_CODE = 78;

const TERMINAL_SIDECAR_FAILURE_CODES = new Set([
  "BRIDGE_ALREADY_RUNNING_UNMANAGED",
  "BRIDGE_PORT_IN_USE",
  "BRIDGE_START_COORDINATION_TIMEOUT"
]);

export class BridgeSidecarSupervisor {
  private readonly options: SidecarSupervisorOptions;
  private child: ChildProcess | undefined;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private statusValue: SidecarStatus = { status: "stopped", restartCount: 0 };
  private terminal: Promise<SidecarStatus> = Promise.resolve(this.statusValue);
  private resolveTerminal: ((status: SidecarStatus) => void) | undefined;
  private deterministicFailure = false;

  constructor(options: SidecarSupervisorOptions) {
    this.options = options;
  }

  start(): SidecarStatus {
    if (this.child) {
      return this.statusValue;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopping = false;
    this.terminal = new Promise<SidecarStatus>(resolve => {
      this.resolveTerminal = resolve;
    });
    this.spawnSidecar();
    return this.statusValue;
  }

  status(): SidecarStatus {
    return this.statusValue;
  }

  waitForTerminal(): Promise<SidecarStatus> {
    return this.terminal;
  }

  async stop(): Promise<SidecarStatus> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    if (!child) {
      this.statusValue = { status: "stopped", restartCount: this.restartCount };
      this.finishTerminal();
      return this.statusValue;
    }
    this.statusValue = { status: "stopping", pid: child.pid, restartCount: this.restartCount };
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
    this.child = undefined;
    this.statusValue = { status: "stopped", restartCount: this.restartCount };
    this.finishTerminal();
    return this.statusValue;
  }

  private spawnSidecar(): void {
    this.deterministicFailure = false;
    this.statusValue = { status: "starting", restartCount: this.restartCount };
    this.writeLog({ event: "sidecar.starting", command: this.options.command, args: this.options.args });
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.statusValue = {
      status: "running",
      pid: child.pid ?? 0,
      restartCount: this.restartCount,
      startedAt: new Date().toISOString()
    };
    child.stdout?.on("data", chunk => this.writeLog({ event: "sidecar.stdout", text: chunk.toString("utf8") }));
    child.stderr?.on("data", chunk => {
      const text = chunk.toString("utf8");
      this.deterministicFailure ||= isTerminalSidecarFailure(text);
      this.writeLog({ event: "sidecar.stderr", text });
    });
    child.once("exit", (exitCode, signal) => {
      this.child = undefined;
      if (this.stopping || exitCode === 0) {
        this.statusValue = { status: "stopped", restartCount: this.restartCount };
        this.writeLog({ event: "sidecar.stopped", exitCode, signal, reason: this.stopping ? "requested" : "clean-exit" });
        this.finishTerminal();
        return;
      }
      this.statusValue = { status: "crashed", restartCount: this.restartCount, exitCode, signal };
      if (exitCode === BRIDGE_SIDECAR_TERMINAL_EXIT_CODE || this.deterministicFailure) {
        this.writeLog({
          event: "sidecar.terminal-failure",
          exitCode,
          signal,
          reason: exitCode === BRIDGE_SIDECAR_TERMINAL_EXIT_CODE ? "typed-terminal-exit" : "singleton-or-port"
        });
        this.finishTerminal();
        return;
      }
      this.writeLog({ event: "sidecar.crashed", exitCode, signal });
      if (this.restartCount >= (this.options.restartLimit ?? 3)) {
        this.finishTerminal();
        return;
      }
      this.restartCount += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (!this.stopping) {
          this.spawnSidecar();
        }
      }, this.options.restartDelayMs ?? 500);
    });
  }

  private finishTerminal(): void {
    this.resolveTerminal?.(this.statusValue);
    this.resolveTerminal = undefined;
  }

  private writeLog(value: unknown): void {
    const event = typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value, at: new Date().toISOString() }
      : { value, at: new Date().toISOString() };
    const safeEvent = sanitizeDiagnostics(event);
    assertDiagnosticsSafe(safeEvent);
    mkdirSync(dirname(this.options.logPath), { recursive: true });
    appendFileSync(this.options.logPath, `${JSON.stringify(safeEvent)}\n`, "utf8");
  }
}

export function isTerminalSidecarFailure(text: string): boolean {
  return /EADDRINUSE|BRIDGE_ALREADY_RUNNING_UNMANAGED|BRIDGE_PORT_IN_USE|BRIDGE_START_COORDINATION_TIMEOUT/iu.test(text);
}

export function isTerminalSidecarFailureCode(code: string): boolean {
  return TERMINAL_SIDECAR_FAILURE_CODES.has(code);
}
