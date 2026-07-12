import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  BRIDGE_CONFIG_SCHEMA,
  LEGACY_BRIDGE_CONFIG_SCHEMA,
  createConfigStore,
  createCredentialStore,
  createRuntimeStore,
  createWorkspaceStore,
  resolveHunsuHome,
  resolveHunsuPaths
} from "../apps/bridge/src/state/index.ts";
import { BRIDGE_RUNTIME_SCHEMA } from "../apps/bridge/src/state/runtimeStore.ts";
import { windowsCredentialAclPowerShellInvocation } from "../apps/bridge/src/state/credentialStore.ts";
import { invalidState } from "../apps/bridge/src/state/atomicJsonStore.ts";
import { bridgeErrorResult } from "../apps/bridge/src/client/cliResult.ts";
import {
  isWindowsPowerShellCommand,
  windowsPowerShellEnvironment
} from "../apps/bridge/src/windowsPowerShell.ts";
import {
  createWorkspaceService,
  toWorkspaceSafeMetadata,
  workspaceIdForPath
} from "../apps/bridge/src/workspaces/workspaceService.ts";
import { createPairingService } from "../apps/bridge/src/pairing/pairingService.ts";
import { createStructuredLog } from "../apps/bridge/src/diagnostics/structuredLog.ts";
import {
  bridgeDeploymentEndpoints,
  bridgeSetupPackageTag
} from "../apps/bridge/src/deploymentProfile.ts";
import {
  LEGACY_RUNTIME_INSTALL_SCHEMA,
  RUNTIME_INSTALL_SCHEMA,
  createRuntimeInstallStore
} from "../apps/bridge/src/setup/runtimeInstaller.ts";

test("HUNSU_HOME resolves the platform defaults and complete state layout", () => {
  assert.equal(
    resolveHunsuHome({ platform: "linux", userHome: "/home/tester", env: {} }),
    "/home/tester/.local/share/hunsu/bridge"
  );
  assert.equal(
    resolveHunsuHome({ platform: "darwin", userHome: "/Users/tester", env: {} }),
    "/Users/tester/Library/Application Support/Hunsu/Bridge"
  );
  assert.equal(
    resolveHunsuHome({
      platform: "win32",
      userHome: "C:\\Users\\tester",
      localAppData: "C:\\Users\\tester\\AppData\\Local",
      env: {}
    }),
    "C:\\Users\\tester\\AppData\\Local\\Hunsu\\Bridge"
  );
  assert.equal(
    resolveHunsuHome({ platform: "linux", userHome: "/ignored", env: { HUNSU_HOME: "/custom/hunsu" } }),
    "/custom/hunsu"
  );

  const paths = resolveHunsuPaths({ platform: "win32", home: "C:\\Hunsu" });
  assert.equal(paths.configFile, win32.join("C:\\Hunsu", "config.json"));
  assert.equal(paths.structuredLogFile, win32.join("C:\\Hunsu", "logs", "bridge.jsonl"));
  assert.equal(paths.runtimeVersionsDirectory, win32.join("C:\\Hunsu", "runtime", "versions"));
});

test("Windows credential ACL hardening uses one encoded injection-safe PowerShell command", () => {
  const credentialPath = "C:\\Users\\O'Brien\\Hunsu Bridge\\credentials.json";
  const invocation = windowsCredentialAclPowerShellInvocation(credentialPath);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, -1), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand"
  ]);
  assert.equal(invocation.args.includes(credentialPath), false);
  const command = Buffer.from(invocation.args.at(-1) ?? "", "base64").toString("utf16le");
  assert.match(command, /\$CredentialPath = 'C:\\Users\\O''Brien\\Hunsu Bridge\\credentials\.json'/u);
  assert.match(command, /WindowsIdentity\]::GetCurrent\(\)\.User/u);
  assert.match(command, /FileSecurity\]::new\(\)/u);
  assert.match(command, /SetOwner\(\$sid\)/u);
  assert.match(command, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(command, /FileSystemAccessRule\]::new\(\$sid/u);
  assert.match(command, /FileSystemRights\]::FullControl/u);
  assert.match(command, /AccessControlType\]::Allow/u);
  assert.match(command, /System\.IO\.File\]::SetAccessControl\(\$CredentialPath, \$acl\)/u);
  assert.doesNotMatch(command, /param\(|Get-Acl|Set-Acl|New-Object|NTAccount/u);
  assert.throws(
    () => windowsCredentialAclPowerShellInvocation("C:\\Hunsu\nInjected\\credentials.json"),
    /control characters/u
  );
});

test("Windows PowerShell 5.1 children cannot inherit PowerShell 7 module paths", () => {
  assert.equal(isWindowsPowerShellCommand("powershell.exe"), true);
  assert.equal(isWindowsPowerShellCommand("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE"), true);
  assert.equal(isWindowsPowerShellCommand("pwsh.exe"), false);
  const environment = {
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    pSmOdUlEpAtH: "C:\\poisoned-user-modules",
    WinPSModulePath: "C:\\poisoned-windows-modules",
    wInPsMoDuLePaTh: "C:\\poisoned-case-variant",
    SAFE_VALUE: "preserved",
    OMITTED_VALUE: undefined
  };
  assert.deepEqual(windowsPowerShellEnvironment(environment), {
    Path: "C:\\Windows\\System32",
    SAFE_VALUE: "preserved"
  });
  assert.equal(environment.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
});

test("Bridge state failures keep the stable code and expose only basename-safe context", () => {
  const result = bridgeErrorResult(invalidState(
    "/secret/runtime/credentials.json",
    "credentials ACL could not be restricted to the current Windows user"
  ));
  assert.deepEqual(result, {
    schema: "hunsu.bridge.cli-result.v1",
    ok: false,
    code: "BRIDGE_STATE_INVALID",
    message: "Bridge state file is invalid (credentials.json): credentials ACL could not be restricted to the current Windows user"
  });
  assert.doesNotMatch(JSON.stringify(result), /\/secret\/runtime/u);
});

test("atomic state stores persist config, preserve credentials, and guard runtime identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-state-"));
  const paths = resolveHunsuPaths({ home });
  try {
    const configStore = createConfigStore(paths);
    assert.deepEqual(await configStore.read(), {
      schema: BRIDGE_CONFIG_SCHEMA,
      deploymentProfile: "production",
      host: "127.0.0.1",
      port: 19687,
      provider: { kind: "unconfigured" },
      remote: { enabled: false }
    });
    await configStore.write({
      schema: BRIDGE_CONFIG_SCHEMA,
      deploymentProfile: "production",
      host: "127.0.0.1",
      port: 43127,
      provider: { kind: "codex", binaryPath: "/opt/codex", home: "/tmp/codex-home" },
      remote: { enabled: true }
    });
    assert.equal((await configStore.read()).port, 43127);

    let credentialFill = 7;
    const credentialStore = createCredentialStore(paths, {
      randomBytes: size => new Uint8Array(size).fill(credentialFill++)
    });
    const first = await credentialStore.ensure();
    const second = await credentialStore.ensure();
    assert.equal(first.controlToken, second.controlToken);
    assert.match(first.controlToken, /^hunsu_control_/u);
    const coordinate = Buffer.alloc(32, 3).toString("base64url");
    const withAccount = await credentialStore.write({ connect: {
      signingPrivateKey: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate, d: coordinate },
      signingPublicKey: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate },
      agreementPrivateKey: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate, d: coordinate },
      agreementPublicKey: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate },
      state: "registered",
      deviceId: "device-1",
      accountId: "account-1",
      accessToken: "account-secret",
      refreshToken: "refresh-secret",
      expiresAt: "2026-07-12T02:00:00.000Z",
      connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device"
    } });
    assert.equal(withAccount.controlToken, first.controlToken);
    const rotated = await credentialStore.rotateControlToken();
    assert.notEqual(rotated.controlToken, first.controlToken);
    assert.deepEqual(rotated.connect, withAccount.connect);
    assert.equal((await stat(paths.credentialsFile)).mode & 0o777, 0o600);
    await assert.rejects(() => credentialStore.write({
      connect: { ...withAccount.connect!, expiresAt: "not-a-timestamp" }
    }), /valid timestamp/u);
    const hardened: string[] = [];
    await createCredentialStore(paths, {
      platform: "win32",
      windowsAclHardener: async path => { hardened.push(path); }
    }).ensure();
    assert.deepEqual(hardened, [paths.credentialsFile]);

    const runtimeStore = createRuntimeStore(paths);
    await runtimeStore.write({
      schema: BRIDGE_RUNTIME_SCHEMA,
      instanceId: "instance-one",
      daemonPid: 1234,
      version: "0.2.0-next.6",
      protocolVersion: "local-bridge-v1",
      deploymentProfile: "preview",
      startedAt: "2026-07-12T00:00:00.000Z",
      endpoint: "http://127.0.0.1:43127",
      runtimePath: "/home/test/.local/share/hunsu/bridge/runtime/versions/0.2.0-next.6",
      serviceManager: "development",
      lastHealthyAt: "2026-07-12T00:00:00.000Z"
    });
    assert.equal((await runtimeStore.read())?.instanceId, "instance-one");
    await assert.rejects(() => runtimeStore.write({
      schema: BRIDGE_RUNTIME_SCHEMA,
      instanceId: "instance-invalid",
      daemonPid: 1234,
      version: "0.2.0-next.6",
      protocolVersion: "local-bridge-v1",
      deploymentProfile: "preview",
      startedAt: "2026-07-12T00:00:00.000Z",
      endpoint: "http://127.0.0.1:43127",
      runtimePath: "relative/runtime",
      serviceManager: "development",
      lastHealthyAt: "2026-07-12T00:00:00.000Z"
    }), /runtimePath must be an absolute path/u);
    assert.equal(await runtimeStore.clear("another-instance"), false);
    assert.equal(await runtimeStore.clear("instance-one"), true);
    assert.equal(await runtimeStore.read(), undefined);

    assert.deepEqual(
      (await readdir(home)).filter(name => name.endsWith(".tmp")),
      []
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("deployment profiles migrate v1 homes to production and reject populated-home switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-profile-state-"));
  const legacyPaths = resolveHunsuPaths({ home: join(root, "legacy") });
  const previewPaths = resolveHunsuPaths({ home: join(root, "preview") });
  const populatedPaths = resolveHunsuPaths({ home: join(root, "populated") });
  try {
    await mkdir(legacyPaths.home, { recursive: true });
    await writeFile(legacyPaths.configFile, `${JSON.stringify({
      schema: LEGACY_BRIDGE_CONFIG_SCHEMA,
      host: "127.0.0.1",
      port: 19687,
      provider: { kind: "unconfigured" },
      remote: { enabled: false }
    })}\n`, "utf8");
    const legacyStore = createConfigStore(legacyPaths);
    assert.equal((await legacyStore.read()).deploymentProfile, "production");
    assert.equal(JSON.parse(await readFile(legacyPaths.configFile, "utf8")).schema, LEGACY_BRIDGE_CONFIG_SCHEMA);
    await legacyStore.ensureDeploymentProfile("production");
    assert.deepEqual(
      JSON.parse(await readFile(legacyPaths.configFile, "utf8")),
      {
        schema: BRIDGE_CONFIG_SCHEMA,
        deploymentProfile: "production",
        host: "127.0.0.1",
        port: 19687,
        provider: { kind: "unconfigured" },
        remote: { enabled: false }
      }
    );
    await assert.rejects(
      () => legacyStore.ensureDeploymentProfile("preview"),
      /cannot switch to preview/u
    );

    const previewStore = createConfigStore(previewPaths);
    assert.equal((await previewStore.ensureDeploymentProfile("preview")).deploymentProfile, "preview");
    await assert.rejects(
      () => previewStore.ensureDeploymentProfile("production"),
      /cannot switch to production/u
    );

    await mkdir(populatedPaths.home, { recursive: true });
    await writeFile(populatedPaths.credentialsFile, "legacy durable state\n", "utf8");
    await assert.rejects(
      () => createConfigStore(populatedPaths).ensureDeploymentProfile("preview"),
      /treated as production/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment profiles resolve exact Web, Connect, signing-key, and setup-channel allowlists", () => {
  assert.deepEqual(bridgeDeploymentEndpoints("production"), {
    webUrl: "https://hunsu.app/studio",
    connectApiUrl: "https://connect.hunsu.app",
    connectWsUrl: "wss://connect.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.hunsu.app",
    connectTicketSigningKeyId: "connect-Ea21pgXVRp5WfId1kXKSeyea",
    connectTicketSigningPublicJwk: {
      kty: "EC", crv: "P-256",
      x: "SekGyUfv_HqJlJ35q9uE4cUzM7jWW6V6B7k4_HGy6ck",
      y: "zY0W0qv5kHQKxF6aynjmy0kGv1XodPwF4MX4yvTW_C8"
    }
  });
  assert.deepEqual(bridgeDeploymentEndpoints("preview"), {
    webUrl: "https://preview.hunsu.app/studio",
    connectApiUrl: "https://connect.preview.hunsu.app",
    connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.preview.hunsu.app",
    connectTicketSigningKeyId: "connect-vd_GiPDTK2lPIDS3Y2dDIEck",
    connectTicketSigningPublicJwk: {
      kty: "EC", crv: "P-256",
      x: "DZDAFyOricZ4dOBOhNrNtAS2X_EdqrE2wQxB23raNcc",
      y: "qLXw7DinTp-5T0i_MdU9jN15Wpnxu0dXh-Owo5ydL1U"
    }
  });
  assert.equal(bridgeSetupPackageTag("production"), "next");
  assert.equal(bridgeSetupPackageTag("preview"), "candidate-next");
});

test("runtime install state migrates v1 without trusting an unversioned digest and validates v2 CLI integrity", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-runtime-install-state-"));
  const paths = resolveHunsuPaths({ home });
  const timestamp = "2026-07-12T00:00:00.000Z";
  const runtimePath = join(paths.runtimeVersionsDirectory, "0.2.0-next.6");
  const cliPath = join(runtimePath, "node_modules", "@hunsu", "bridge", "dist", "cli.js");
  const legacy = {
    schema: LEGACY_RUNTIME_INSTALL_SCHEMA,
    installationId: "install_runtime_state_test",
    current: {
      packageVersion: "0.2.0-next.6",
      runtimePath,
      nodePath: process.execPath,
      cliPath,
      cliSha256: "a".repeat(64),
      installedAt: timestamp
    },
    previous: null,
    serviceInput: {
      nodePath: process.execPath,
      cliPath,
      hunsuHome: home,
      packageVersion: "0.2.0-next.6",
      runtimePath,
      deploymentProfile: "production"
    },
    updatedAt: timestamp
  };
  try {
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await writeFile(paths.runtimeInstallFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const store = createRuntimeInstallStore(paths);
    const migrated = await store.read();
    assert.equal(migrated?.schema, RUNTIME_INSTALL_SCHEMA);
    assert.equal(migrated?.current.cliSha256, null);
    assert.equal(JSON.parse(await readFile(paths.runtimeInstallFile, "utf8")).schema, LEGACY_RUNTIME_INSTALL_SCHEMA);

    assert.ok(migrated);
    const trustedSha256 = "b".repeat(64);
    await store.write({
      ...migrated,
      current: { ...migrated.current, cliSha256: trustedSha256 }
    });
    const persisted = JSON.parse(await readFile(paths.runtimeInstallFile, "utf8")) as {
      schema: string;
      current: { cliSha256: string };
    };
    assert.equal(persisted.schema, RUNTIME_INSTALL_SCHEMA);
    assert.equal(persisted.current.cliSha256, trustedSha256);

    persisted.current.cliSha256 = "not-a-sha256";
    await writeFile(paths.runtimeInstallFile, `${JSON.stringify(persisted)}\n`, "utf8");
    await assert.rejects(store.read(), /current\.cliSha256 must be a lowercase SHA-256 digest/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("control-token rotation hardens the temporary file before commit and never exposes split disk and daemon authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-credential-rotation-"));
  const paths = resolveHunsuPaths({ home });
  let randomFill = 1;
  let failHardening = false;
  let enteredHardening!: (path: string) => void;
  let releaseHardening!: () => void;
  const hardeningEntered = new Promise<string>(resolve => { enteredHardening = resolve; });
  const hardeningRelease = new Promise<void>(resolve => { releaseHardening = resolve; });
  const store = createCredentialStore(paths, {
    platform: "win32",
    randomBytes: size => new Uint8Array(size).fill(randomFill++),
    windowsAclHardener: async path => {
      if (!failHardening) return;
      enteredHardening(path);
      await hardeningRelease;
      throw new Error("injected ACL failure");
    }
  });
  try {
    const initial = await store.ensure();
    let activeControlToken = initial.controlToken;
    failHardening = true;
    const rotation = store.rotateControlToken({
      onCommitted: credentials => { activeControlToken = credentials.controlToken; }
    });
    const preparedPath = await hardeningEntered;
    assert.notEqual(preparedPath, paths.credentialsFile);
    assert.match(preparedPath, /\.credentials\.json\..+\.tmp$/u);
    const duringFailure = JSON.parse(await readFile(paths.credentialsFile, "utf8")) as { controlToken: string };
    assert.equal(duringFailure.controlToken, initial.controlToken);
    assert.equal(activeControlToken, initial.controlToken);

    releaseHardening();
    await assert.rejects(rotation, /Unable to persist Bridge state file/u);
    const afterFailure = JSON.parse(await readFile(paths.credentialsFile, "utf8")) as { controlToken: string };
    assert.equal(afterFailure.controlToken, initial.controlToken);
    assert.equal(activeControlToken, initial.controlToken);

    failHardening = false;
    const rotated = await store.rotateControlToken({
      onCommitted: credentials => { activeControlToken = credentials.controlToken; }
    });
    const afterSuccess = JSON.parse(await readFile(paths.credentialsFile, "utf8")) as { controlToken: string };
    assert.equal(afterSuccess.controlToken, rotated.controlToken);
    assert.equal(activeControlToken, rotated.controlToken);
    assert.notEqual(activeControlToken, initial.controlToken);
  } finally {
    releaseHardening();
    await rm(home, { recursive: true, force: true });
  }
});

test("Workspace service uses canonical stable IDs and typed Result failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-workspaces-"));
  const repository = join(home, "example-repository");
  await mkdir(repository);
  const paths = resolveHunsuPaths({ home: join(home, "state") });
  const service = createWorkspaceService({
    store: createWorkspaceStore(paths),
    now: () => new Date("2026-07-12T01:02:03.000Z")
  });
  try {
    const added = await service.add(repository);
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.match(added.value.workspaceId, /^ws_[a-f0-9]{64}$/u);
    assert.equal(added.value.workspaceId, workspaceIdForPath(repository));
    assert.equal(added.value.displayName, "example-repository");
    assert.deepEqual(added.value.remoteAccess, { enabled: false, scopes: [] });
    const granted = await service.setRemoteAccess(added.value.workspaceId, {
      enabled: true,
      scopes: ["remote.access"]
    });
    assert.equal(granted.ok, true);
    if (granted.ok) assert.deepEqual(granted.value.remoteAccess, { enabled: true, scopes: ["remote.access"] });

    const duplicate = await service.add(repository);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "WORKSPACE_ALREADY_REGISTERED");

    const listed = await service.list();
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.value.length, 1);
      const safe = toWorkspaceSafeMetadata(listed.value[0]!);
      assert.equal("repositoryPath" in safe, false);
      assert.equal(safe.pathRedacted, true);
    }

    const opened = await service.open(added.value.workspaceId);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.value.repositoryPath, repository);

    await rm(repository, { recursive: true, force: true });
    const missing = await service.get(added.value.workspaceId);
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.value.lifecycle, "missing");
    const missingOpen = await service.open(added.value.workspaceId);
    assert.equal(missingOpen.ok, false);
    if (!missingOpen.ok) assert.equal(missingOpen.error.code, "WORKSPACE_PATH_INVALID");

    const removed = await service.remove(added.value.workspaceId);
    assert.equal(removed.ok, true);
    const absent = await service.get(added.value.workspaceId);
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.error.code, "WORKSPACE_NOT_FOUND");

    const invalid = await service.add("");
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "WORKSPACE_PATH_INVALID");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pairing rotates a distinct short-lived credential without exposing it in safe metadata", () => {
  let currentTime = Date.parse("2026-07-12T00:00:00.000Z");
  let fill = 1;
  const service = createPairingService({
    controlToken: "hunsu_control_control-secret",
    ttlMs: 1_000,
    now: () => currentTime,
    randomBytes: size => new Uint8Array(size).fill(fill++)
  });
  const rotated = service.rotate({
    browserUrl: "http://hunsu.localhost:5173/studio",
    workspaceId: "ws_example"
  });
  assert.equal(rotated.ok, true);
  if (!rotated.ok) return;
  assert.notEqual(rotated.value.internal.credential, "hunsu_control_control-secret");
  assert.match(rotated.value.internal.pairingUrl, /hunsuBridgeToken=/u);
  assert.equal(JSON.stringify(rotated.value.safe).includes(rotated.value.internal.credential), false);
  assert.equal(JSON.stringify(rotated.value.safe).includes("pairingUrl"), false);
  assert.deepEqual(service.validate(), { valid: false, reason: "missing" });
  assert.deepEqual(service.validate(rotated.value.internal.credential), { valid: true });

  const consumed = service.consume(rotated.value.internal.credential);
  assert.equal(consumed.ok, true);
  assert.equal(service.getSafeMetadata()?.status, "consumed");
  assert.deepEqual(service.validate(rotated.value.internal.credential), { valid: true });

  assert.equal(service.revoke(rotated.value.safe.pairingId), true);
  assert.deepEqual(service.validate(rotated.value.internal.credential), { valid: false, reason: "revoked" });

  const second = service.rotate({ browserUrl: "https://hunsu.app/studio" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  currentTime += 1_001;
  assert.deepEqual(service.validate(second.value.internal.credential), { valid: false, reason: "expired" });
  assert.equal(service.getSafeMetadata()?.status, "expired");
});

test("structured JSONL sanitizes writes and reads while bounding rotated history", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-log-"));
  const paths = resolveHunsuPaths({ home });
  let sequence = 0;
  const log = createStructuredLog({
    paths,
    maxBytes: 320,
    maxFiles: 2,
    now: () => new Date(Date.parse("2026-07-12T00:00:00.000Z") + sequence++ * 1_000)
  });
  try {
    await log.append({
      level: "info",
      event: "pairing.created",
      message: "open http://localhost/?hunsuBridgeToken=hunsu_bridge_pair_raw-secret",
      data: { Authorization: "Bearer raw-authorization", nested: { accessToken: "raw-access-token" } }
    });
    await log.append({
      level: "warn",
      event: "control.redaction",
      message: "unexpected hunsu_control_raw-control-token"
    });
    const controlPersisted = await readFile(paths.structuredLogFile, "utf8");
    assert.equal(controlPersisted.includes("raw-control-token"), false);
    const firstPersisted = await readFile(paths.structuredLogFile, "utf8");
    assert.equal(firstPersisted.includes("raw-secret"), false);
    assert.equal(firstPersisted.includes("raw-authorization"), false);
    assert.equal(firstPersisted.includes("raw-access-token"), false);
    for (let index = 0; index < 8; index += 1) {
      await log.append({
        level: "info",
        event: "rotation.test",
        message: `bounded record ${index} ${"x".repeat(80)}`
      });
    }
    await log.append({ level: "warn", event: "oversized", message: "x".repeat(10_000) });

    const logFiles = (await readdir(paths.logsDirectory)).filter(name => name.startsWith("bridge.jsonl"));
    assert.ok(logFiles.length <= 2);
    for (const file of logFiles) assert.ok((await stat(join(paths.logsDirectory, file))).size <= 320);
    const persisted = (await Promise.all(logFiles.map(file => readFile(join(paths.logsDirectory, file), "utf8")))).join("\n");
    assert.equal(persisted.includes("raw-secret"), false);
    assert.equal(persisted.includes("raw-authorization"), false);
    assert.equal(persisted.includes("raw-access-token"), false);

    await appendFile(paths.structuredLogFile, `${JSON.stringify({
      schema: "hunsu.bridge.log.v1",
      timestamp: "2026-07-12T02:00:00.000Z",
      level: "warn",
      event: "legacy.record",
      data: { token: "historical-raw-token" }
    })}\n`);
    const historical = await log.read();
    assert.equal(JSON.stringify(historical).includes("historical-raw-token"), false);
    assert.ok(historical.some(record => record.event === "legacy.record"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
