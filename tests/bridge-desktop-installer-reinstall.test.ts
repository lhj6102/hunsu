import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type InstallerSmokeInput = {
  bundleDir: string;
  platform: NodeJS.Platform;
  localAppData: string;
  installDir: string;
  stateRoot: string;
  settleMs: number;
  timeoutMs: number;
  logger: (message: string) => void;
  runner: (command: string, args: string[], options: unknown) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
  startSidecar: (command: string, args: string[], options: unknown) => Promise<{ pid: number }>;
  processAlive: (pid: number) => boolean;
  wait: (ms: number) => Promise<void>;
};

type InstallerSmokeModule = {
  smokeWindowsInstallerReinstall(input: InstallerSmokeInput): Promise<{
    installer: string;
    installDir: string;
    sidecar: string;
  }>;
};

const installerSmoke = await import(
  new URL("../apps/bridge-desktop/scripts/smoke-windows-installer-reinstall.mjs", import.meta.url).href
) as InstallerSmokeModule;

test("Windows NSIS hooks stop the current-user desktop and packaged sidecar before replacement", () => {
  const tauriRoot = join(process.cwd(), "apps/bridge-desktop/src-tauri");
  const windowsConfig = JSON.parse(readFileSync(join(tauriRoot, "tauri.windows.conf.json"), "utf8")) as {
    bundle?: { windows?: { nsis?: { installMode?: string; installerHooks?: string; template?: string } } };
  };
  const nsis = windowsConfig.bundle?.windows?.nsis;
  assert.equal(nsis?.installMode, "currentUser");
  assert.equal(nsis?.installerHooks, "./windows/installer-hooks.nsh");
  assert.equal(nsis?.template, undefined);

  const hooks = readFileSync(join(tauriRoot, "windows/installer-hooks.nsh"), "utf8");
  assert.match(hooks, /!macro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES/u);
  assert.match(hooks, /!insertmacro CheckIfAppIsRunning "\$\{MAINBINARYNAME\}\.exe" "\$\{PRODUCTNAME\}"/u);
  assert.match(hooks, /!insertmacro CheckIfAppIsRunning "hunsu-bridge-sidecar\.exe" "Hunsu Bridge background service"/u);
  assert.match(hooks, /!macro NSIS_HOOK_PREINSTALL\s+!insertmacro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES\s+!macroend/u);
  assert.match(hooks, /!macro NSIS_HOOK_PREUNINSTALL\s+!insertmacro HUNSU_BRIDGE_STOP_RUNNING_PROCESSES\s+!macroend/u);
  assert.equal(hooks.indexOf("${MAINBINARYNAME}.exe") < hooks.indexOf("hunsu-bridge-sidecar.exe"), true);
  assert.doesNotMatch(hooks, /taskkill|node\.exe|cmd\.exe/iu);
});

test("Windows installer smoke replaces and uninstalls a running packaged sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-installer-reinstall-test-"));
  const bundleDir = join(root, "bundle");
  const nsisDir = join(bundleDir, "nsis");
  const installer = join(nsisDir, "Hunsu Bridge_0.1.0_x64-setup.exe");
  const localAppData = join(root, "local-app-data");
  const installDir = join(localAppData, "Hunsu Bridge");
  const sidecar = join(installDir, "hunsu-bridge-sidecar.exe");
  const uninstaller = join(installDir, "uninstall.exe");
  const livePids = new Set<number>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const logs: string[] = [];
  let nextPid = 100;
  let installCount = 0;

  mkdirSync(nsisDir, { recursive: true });
  writeFileSync(installer, "installer", "utf8");
  try {
    const result = await installerSmoke.smokeWindowsInstallerReinstall({
      bundleDir,
      platform: "win32",
      localAppData,
      installDir,
      stateRoot: join(root, "state"),
      settleMs: 0,
      timeoutMs: 1_000,
      logger: message => logs.push(message),
      runner(command, args) {
        calls.push({ command, args });
        if (command === installer) {
          installCount += 1;
          mkdirSync(installDir, { recursive: true });
          writeFileSync(sidecar, `sidecar-${installCount}`, "utf8");
          writeFileSync(uninstaller, "uninstaller", "utf8");
          if (installCount === 2) {
            livePids.clear();
          }
        } else if (command === uninstaller) {
          livePids.clear();
          rmSync(installDir, { recursive: true, force: true });
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      async startSidecar(command, args) {
        assert.equal(command, sidecar);
        assert.deepEqual(args, ["start", "--no-open"]);
        const pid = nextPid;
        nextPid += 1;
        livePids.add(pid);
        return { pid };
      },
      processAlive: pid => livePids.has(pid),
      wait: async () => {}
    });

    assert.equal(result.installer, installer);
    assert.equal(result.sidecar, sidecar);
    assert.deepEqual(calls, [
      { command: installer, args: ["/S"] },
      { command: installer, args: ["/S"] },
      { command: uninstaller, args: ["/S"] }
    ]);
    assert.deepEqual(logs, [
      `[installer-smoke] installer=${installer}`,
      "[installer-smoke] reinstalling over a running sidecar",
      "[installer-smoke] uninstalling with a running sidecar",
      "[installer-smoke] reinstall and uninstall completed"
    ]);
    assert.equal(livePids.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows artifact workflow runs the locked-sidecar reinstall smoke before staging", () => {
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/bridge-desktop-artifacts.yml"), "utf8");
  const build = workflow.indexOf("Build desktop bundle");
  const reinstall = workflow.indexOf("smoke-windows-installer-reinstall.mjs");
  const staging = workflow.indexOf("Stage installer artifacts and checksums");
  assert.equal(build >= 0 && reinstall > build && staging > reinstall, true);
  assert.match(workflow, /Verify Windows installer replaces a running sidecar/u);
  assert.match(workflow, /if: startsWith\(matrix\.platform, 'windows'\)/u);
  assert.match(workflow, /timeout-minutes: 10/u);
  assert.match(workflow, /node --conditions=development apps\/bridge-desktop\/scripts\/smoke-windows-installer-reinstall\.mjs/u);
  assert.match(workflow, /--bundle-dir "apps\/bridge-desktop\/src-tauri\/target\/release\/bundle"/u);
  assert.match(workflow, /--timeout-ms 60000/u);
});
