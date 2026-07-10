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

export class BridgeSidecarSupervisor {
  private readonly options: SidecarSupervisorOptions;
  private child: ChildProcess | undefined;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private statusValue: SidecarStatus = { status: "stopped", restartCount: 0 };

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
    this.spawnSidecar();
    return this.statusValue;
  }

  status(): SidecarStatus {
    return this.statusValue;
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
      return this.statusValue;
    }
    this.statusValue = { status: "stopping", pid: child.pid, restartCount: this.restartCount };
    await new Promise<void>(resolve => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
    this.child = undefined;
    this.statusValue = { status: "stopped", restartCount: this.restartCount };
    return this.statusValue;
  }

  private spawnSidecar(): void {
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
    child.stderr?.on("data", chunk => this.writeLog({ event: "sidecar.stderr", text: chunk.toString("utf8") }));
    child.once("exit", (exitCode, signal) => {
      this.child = undefined;
      if (this.stopping) {
        this.writeLog({ event: "sidecar.stopped", exitCode, signal });
        return;
      }
      this.statusValue = { status: "crashed", restartCount: this.restartCount, exitCode, signal };
      this.writeLog({ event: "sidecar.crashed", exitCode, signal });
      if (this.restartCount >= (this.options.restartLimit ?? 3)) {
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

  private writeLog(value: unknown): void {
    mkdirSync(dirname(this.options.logPath), { recursive: true });
    const safeValue = sanitizeDiagnostics({ ...(value as object), at: new Date().toISOString() });
    assertDiagnosticsSafe(safeValue);
    appendFileSync(this.options.logPath, `${JSON.stringify(safeValue)}\n`, "utf8");
  }
}
