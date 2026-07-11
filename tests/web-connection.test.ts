import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BridgeConnectionState } from "../apps/web/src/shared/api/bridgeConnection.ts";
import type { BridgeStatusResponse, StudioConnectionStatus } from "../apps/web/src/shared/api/bridgeTypes.ts";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");
const require = createRequire(import.meta.url);

test("Connection Center card labels cover required Studio connection states", async () => {
  const { module, close } = await loadConnectionModule();
  try {
    assert.equal(module.connectionCardLabel({
      status: "online",
      tokenPresent: false
    }), "Local Bridge · Pairing needed");

    assert.equal(module.connectionCardLabel({
      status: "offline",
      tokenPresent: false,
      error: "Bridge is not reachable"
    }), "Bridge not connected");

    assert.equal(module.connectionCardLabel(onlineConnection({
      mode: "remote",
      transport: "relay",
      health: "connected"
    })), "Remote Bridge · Connected");

    assert.equal(module.connectionCardLabel(onlineConnection({
      auth: "account_mismatch",
      account: { webUserId: "web@example.test", bridgeUserId: "bridge@example.test", sameUser: false }
    })), "Account mismatch");

    assert.equal(module.connectionCardLabel(onlineConnection({
      projectAccess: "needs_grant"
    })), "Workspace access needed");

    assert.equal(module.connectionCardLabel(onlineConnection({
      projectAccess: "denied"
    })), "Workspace access denied");

    assert.equal(module.connectionCardLabel(onlineConnection({
      warnings: ["version_mismatch"]
    })), "Bridge update needed");

    assert.equal(module.connectionCardLabel(onlineConnection({
      compatibility: { compatible: false, reason: "studio_update_needed", message: "Studio is too old." },
      warnings: ["version_mismatch"]
    })), "Studio update needed");

    assert.equal(module.connectionCardLabel(onlineConnection({
      compatibility: { compatible: false, reason: "feature_unavailable", message: "Missing feature." },
      warnings: ["version_mismatch"]
    })), "Feature unavailable on this Bridge version");

  } finally {
    await close();
  }
});

test("Roadmap workspace preflight actions map to same-origin Studio destinations", async () => {
  const { module, close } = await loadPreflightActionsModule();
  try {
    assert.equal(module.bridgeActionHref({ type: "install_provider", label: "Install Codex" }), "/studio/setup?next=%2Fstudio");
    assert.equal(module.bridgeActionHref({ type: "login_provider", label: "Sign In" }), "/studio/setup?next=%2Fstudio");
    assert.equal(module.bridgeActionHref({ type: "open_workspaces", label: "Open Workspaces" }), "/studio");
    assert.equal(module.bridgeActionHref({ type: "activate_workspace", label: "Activate Workspace", workspaceId: "workspace 123" }), "/studio");
    assert.equal(module.bridgeActionHref({ type: "open_workspaces", label: "External href", href: "https://example.test/workspaces" }), "/studio");
    assert.equal(module.bridgeActionHref({ type: "open_connection", label: "Open Connection" }), "/studio/setup?next=%2Fstudio");
    assert.equal(module.bridgeActionHref({ type: "edit_model_alias", label: "Edit Model Alias" }), "/studio/settings/model-aliases");
    assert.equal(module.bridgeActionHref({ type: "install_provider", label: "Install Codex", providerId: "codex" }), "/studio/setup?next=%2Fstudio");
    assert.equal(module.bridgeActionHref({ type: "open_provider_setup", label: "Open Provider Setup" }), "/studio/setup?next=%2Fstudio");
  } finally {
    await close();
  }
});

test("Web Execute preflight contract exposes provider workspace connection and model areas", () => {
  const bridgeTypesSource = readFileSync(join(WEB_ROOT, "src/shared/api/bridgeTypes.ts"), "utf8");
  const preflightContract = bridgeTypesSource.slice(
    bridgeTypesSource.indexOf("export type ExecutePreflightAction"),
    bridgeTypesSource.indexOf("export type RoadmapListResult")
  );
  const preflightActionsSource = readFileSync(join(WEB_ROOT, "src/features/roadmap-workspace/preflightActions.ts"), "utf8");
  assert.match(preflightContract, /area: "provider"/);
  assert.match(preflightContract, /area: "workspace"/);
  assert.match(preflightContract, /area: "connection"/);
  assert.match(preflightContract, /area: "model"/);
  assert.match(preflightContract, /area: "model";\s+backendId: string;/);
  assert.doesNotMatch(preflightContract, /area: "codex"/);
  assert.doesNotMatch(preflightContract, /area: "roadmap"/);
  assert.doesNotMatch(preflightContract, /install_codex|codex_login|codex_recheck|open_prerequisites|open_roadmaps|activate_roadmap|CODEX_|ROADMAP_/);
  assert.doesNotMatch(preflightActionsSource, /install_codex|codex_login|codex_recheck|open_prerequisites|open_roadmaps|activate_roadmap/);
});

test("Web model selection UX keeps alias and direct provider modes available", () => {
  const roadmapWorkspaceSource = readFileSync(join(WEB_ROOT, "src/features/roadmap-workspace/RoadmapWorkspace.tsx"), "utf8");
  const aliasSettingsSource = readFileSync(join(WEB_ROOT, "src/features/model-aliases/ModelAliasSettings.tsx"), "utf8");
  const aliasStorageSource = readFileSync(join(WEB_ROOT, "src/features/model-aliases/modelAliasStorage.ts"), "utf8");
  const assignmentSource = readFileSync(join(WEB_ROOT, "src/features/model-aliases/modelSelectionAssignment.ts"), "utf8");
  const configDraftSource = readFileSync(join(WEB_ROOT, "src/features/model-aliases/modelConfigDraftStorage.ts"), "utf8");
  assert.match(roadmapWorkspaceSource, /executeModelMode/);
  assert.match(roadmapWorkspaceSource, /Use alias/);
  assert.match(roadmapWorkspaceSource, /Direct provider/);
  assert.match(roadmapWorkspaceSource, /kind: "direct"/);
  assert.match(roadmapWorkspaceSource, /capabilities\.reasoningEfforts/);
  assert.match(roadmapWorkspaceSource, /capabilities\.serviceTiers/);
  assert.match(roadmapWorkspaceSource, /aliases: input\.aliases/);
  assert.doesNotMatch(roadmapWorkspaceSource, /modelAliases: input\.aliases/);
  assert.match(aliasSettingsSource, /aliases\s*\}/);
  assert.doesNotMatch(aliasSettingsSource, /modelAliases: aliases/);
  assert.doesNotMatch(roadmapWorkspaceSource, /executeModelAliasPayload/);
  assert.match(aliasSettingsSource, /createAlias/);
  assert.match(aliasSettingsSource, /deleteSelectedAlias/);
  assert.match(aliasSettingsSource, /capabilities\.reasoningEfforts/);
  assert.match(aliasStorageSource, /scope: \{ kind: "user" \}/);
  assert.doesNotMatch(aliasStorageSource, /scope: "user"/);
  assert.match(assignmentSource, /assignManagerModelSelection/);
  assert.match(assignmentSource, /assignMemberModelSelection/);
  assert.match(assignmentSource, /assignExecutorModelSelection/);
  assert.match(aliasSettingsSource, /Web Config Draft/);
  assert.match(aliasSettingsSource, /readWebModelConfigDraft/);
  assert.match(aliasSettingsSource, /assignWebModelConfigDraft/);
  assert.match(aliasSettingsSource, /writeWebModelConfigDraft/);
  assert.match(aliasSettingsSource, /Model aliases are currently saved in this browser/);
  assert.match(aliasSettingsSource, /Account and workspace sync will be added later/);
  assert.match(configDraftSource, /assignManagerModelSelection/);
  assert.match(configDraftSource, /assignMemberModelSelection/);
  assert.match(configDraftSource, /assignExecutorModelSelection/);
  assert.doesNotMatch(readFileSync(join(WEB_ROOT, "src/shared/api/bridgeTypes.ts"), "utf8"), /modelAliasOverrides\?:|modelAliases\?:/);
});

test("Web model alias settings config draft assigns Manager Member and Executor configs through the production path", async () => {
  const { module, close } = await loadModelConfigDraftStorageModule();
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>();
  try {
    const directProvider = {
      providerId: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: "fast"
    };
    const draft = module.createDefaultWebModelConfigDraft("2026-07-10T00:00:00.000Z");
    const managerAlias = module.assignWebModelConfigDraft(draft, "manager", { mode: "alias", aliasId: "ReviewerModel" }, "2026-07-10T00:01:00.000Z");
    assert.equal(managerAlias.manager.modelSelection.kind, "alias");
    assert.equal(managerAlias.manager.modelSelection.aliasId, "ReviewerModel");

    const managerDirect = module.assignWebModelConfigDraft(managerAlias, "manager", { mode: "direct", provider: directProvider }, "2026-07-10T00:02:00.000Z");
    assert.equal(managerDirect.manager.modelSelection.kind, "direct");
    assert.equal(managerDirect.manager.modelSelection.provider.model, "gpt-5.5");

    const memberDirect = module.assignWebModelConfigDraft(managerDirect, "member", { mode: "direct", provider: directProvider }, "2026-07-10T00:03:00.000Z");
    assert.equal(memberDirect.member.modelSelection.kind, "direct");
    assert.equal(memberDirect.member.model, "gpt-5.5");
    assert.equal(memberDirect.member.reasoningEffort, "medium");
    assert.equal(memberDirect.member.serviceTier, "fast");

    const executorAlias = module.assignWebModelConfigDraft(memberDirect, "executor", { mode: "alias", aliasId: "PrimaryModel" }, "2026-07-10T00:04:00.000Z");
    assert.equal(executorAlias.executor.runtimePolicy.modelSelection.kind, "alias");
    assert.equal(executorAlias.executor.runtimePolicy.modelSelection.aliasId, "PrimaryModel");

    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem(key: string) {
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
        removeItem(key: string) {
          storage.delete(key);
        }
      }
    };
    module.writeWebModelConfigDraft(executorAlias);
    const persisted = module.readWebModelConfigDraft();
    assert.equal(persisted.manager.modelSelection.kind, "direct");
    assert.equal(persisted.member.modelSelection.provider.model, "gpt-5.5");
    assert.equal(persisted.executor.runtimePolicy.modelSelection.aliasId, "PrimaryModel");
  } finally {
    await close();
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web model selection assignment helpers update Manager Member and Executor configs", async () => {
  const { module, close } = await loadModelSelectionAssignmentModule();
  try {
    const directProvider = {
      providerId: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      serviceTier: "fast"
    };
    const manager = module.assignManagerModelSelection({
      id: "manager.test",
      promptTemplate: { engine: "hunsu-template-v1", template: "Guide the draft." },
      skills: [],
      plugins: []
    }, { mode: "alias", aliasId: "PrimaryModel" });
    assert.equal(manager.modelSelection.kind, "alias");
    assert.equal(manager.modelSelection.aliasId, "PrimaryModel");

    const member = module.assignMemberModelSelection({
      id: "member.test",
      promptTemplate: { engine: "hunsu-template-v1", template: "Build." },
      skills: [],
      plugins: [],
      model: "codex-default",
      reasoningEffort: "default",
      serviceTier: "default",
      execution: { kind: "read_only", network: "disabled" },
      approval: { policy: "never" }
    }, { mode: "direct", provider: directProvider });
    assert.equal(member.modelSelection.kind, "direct");
    assert.equal(member.model, "gpt-5.5");
    assert.equal(member.reasoningEffort, "medium");
    assert.equal(member.serviceTier, "fast");

    const executor = module.assignExecutorModelSelection({
      kind: "member",
      id: "executor.test",
      promptTemplate: { engine: "hunsu-template-v1", template: "Execute." },
      resources: [],
      runtimePolicy: {
        model: "codex-default",
        reasoningEffort: "default",
        serviceTier: "default",
        execution: { kind: "read_only", network: "disabled" },
        approval: { policy: "never" }
      }
    }, { mode: "alias", aliasId: "ReviewerModel" });
    assert.equal(executor.runtimePolicy.modelSelection.kind, "alias");
    assert.equal(executor.runtimePolicy.modelSelection.aliasId, "ReviewerModel");
  } finally {
    await close();
  }
});

test("Roadmap workspace renders multiple server-provided preflight actions", async () => {
  const { module, close } = await loadRoadmapWorkspaceModule();
  try {
    const react = require("../apps/web/node_modules/react") as { createElement: (type: unknown, props: unknown) => unknown };
    const reactDomServer = require("../apps/web/node_modules/react-dom/server.node.js") as { renderToString: (element: unknown) => string };
    const html = reactDomServer.renderToString(react.createElement(module.RoadmapWorkspacePreflightActions, {
      preflight: {
        area: "workspace",
        error: "WORKSPACE_INACTIVE",
        message: "This Workspace is inactive.",
        workspaceId: "roadmap_123",
        actions: [
          { type: "open_workspaces", label: "Open Workspaces", href: "/studio" },
          { type: "activate_workspace", label: "Activate Workspace", href: "/studio" }
        ]
      },
      open: () => undefined
    }));

    assert.match(html, /Open Workspaces/);
    assert.match(html, /Activate Workspace/);
  } finally {
    await close();
  }
});

test("Connection footer renders local provider and active workspaces from Bridge status", async () => {
  const { module, close } = await loadConnectionFooterModule();
  try {
    const react = require("../apps/web/node_modules/react") as { createElement: (type: unknown, props: unknown) => unknown };
    const reactDomServer = require("../apps/web/node_modules/react-dom/server.node.js") as { renderToString: (element: unknown) => string };
    const html = reactDomServer.renderToString(react.createElement(module.ConnectionFooter, {
      collapsed: false,
      bridgeStatusState: "online",
      fallbackConnection: { status: "offline", tokenPresent: false },
      onOpen: () => undefined,
      bridgeStatus: {
        provider: {
          providerId: "codex",
          kind: "codex",
          label: "Codex",
          connectionKind: "local_cli",
          installed: true,
          configured: true,
          authenticated: true,
          ready: true,
          auth: { kind: "chatgpt_oauth", state: "authenticated", access: "subscription" },
          capabilities: {
            canExecute: true,
            canEditFiles: true,
            canRunShell: true,
            supportsWorktree: true,
            supportsEventStream: true,
            supportsUsage: true,
            supportsSubscriptionAuth: true,
            supportsDeviceAuth: true,
            supportsApiKeyAuth: true,
            supportsRemoteRelay: true,
            supportsAcp: false
          },
          recommendedAction: "none"
        },
        connections: [{
          backendId: "local",
          mode: "local",
          label: "This computer",
          provider: {
            providerId: "codex",
            kind: "codex",
            label: "Codex",
            connectionKind: "local_cli",
            installed: true,
            configured: true,
            authenticated: true,
            ready: true,
            auth: { kind: "chatgpt_oauth", state: "authenticated", access: "subscription" },
            capabilities: {
              canExecute: true,
              canEditFiles: true,
              canRunShell: true,
              supportsWorktree: true,
              supportsEventStream: true,
              supportsUsage: true,
              supportsSubscriptionAuth: true,
              supportsDeviceAuth: true,
              supportsApiKeyAuth: true,
              supportsRemoteRelay: true,
              supportsAcp: false
            },
            recommendedAction: "none"
          },
          connection: { state: "connected" },
          workspaces: [{
            workspaceId: "roadmap_123",
            roadmapId: "roadmap_123",
            displayName: "my-product",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio", "deactivate"]
          }]
        }],
        workspaces: { active: [], managed: [] },
        account: { signedIn: false }
      }
    }));

    assert.match(html, /Local Bridge/);
    assert.match(html, /Codex ready/);
    assert.match(html, /my-product/);
    assert.match(html, /Remote — Sign in to connect remote workspaces/);
    assert.match(html, /Add workspace/);
  } finally {
    await close();
  }
});

test("Connection footer renders provider setup, no-remote, and empty remote states", async () => {
  const { module, close } = await loadConnectionFooterModule();
  try {
    const react = require("../apps/web/node_modules/react") as { createElement: (type: unknown, props: unknown) => unknown };
    const reactDomServer = require("../apps/web/node_modules/react-dom/server.node.js") as { renderToString: (element: unknown) => string };
    const readyProvider = providerFixture({ ready: true, recommendedAction: "none" });
    const providerNotReady = providerFixture({ ready: false, recommendedAction: "login", safeMessage: "Sign in to Codex." });
    const localConnection = {
      backendId: "local",
      mode: "local",
      label: "This computer",
      provider: readyProvider,
      connection: { state: "connected" },
      workspaces: []
    };

    const setupHtml = reactDomServer.renderToString(react.createElement(module.ConnectionFooter, {
      collapsed: false,
      bridgeStatusState: "online",
      fallbackConnection: { status: "offline", tokenPresent: false },
      onOpen: () => undefined,
      bridgeStatus: {
        provider: providerNotReady,
        connections: [{ ...localConnection, provider: providerNotReady }],
        workspaces: { active: [], managed: [] },
        account: { signedIn: false }
      }
    }));
    assert.match(setupHtml, /This computer · Codex login required/);
    assert.match(setupHtml, /Open Provider Setup/);

    const noRemoteHtml = reactDomServer.renderToString(react.createElement(module.ConnectionFooter, {
      collapsed: false,
      bridgeStatusState: "online",
      fallbackConnection: { status: "offline", tokenPresent: false },
      onOpen: () => undefined,
      bridgeStatus: {
        provider: readyProvider,
        connections: [localConnection],
        workspaces: { active: [], managed: [] },
        account: { signedIn: true, userId: "user_1" }
      }
    }));
    assert.match(noRemoteHtml, /Enable Remote/);

    const emptyRemoteHtml = reactDomServer.renderToString(react.createElement(module.ConnectionFooter, {
      collapsed: false,
      bridgeStatusState: "online",
      fallbackConnection: { status: "offline", tokenPresent: false },
      onOpen: () => undefined,
      bridgeStatus: {
        provider: readyProvider,
        connections: [
          localConnection,
          {
            backendId: "remote:device_1",
            mode: "remote",
            label: "MacBook Pro",
            device: { deviceId: "device_1", name: "MacBook Pro", registered: true, online: true },
            provider: readyProvider,
            connection: { state: "connected" },
            workspaces: []
          }
        ],
        workspaces: { active: [], managed: [] },
        account: { signedIn: true, userId: "user_1" }
      }
    }));
    assert.match(emptyRemoteHtml, /Remote/);
    assert.match(emptyRemoteHtml, /No active remote workspaces/);
  } finally {
    await close();
  }
});

test("Connection footer surfaces selected remote provider readiness", async () => {
  const { module, close } = await loadConnectionFooterModule();
  try {
    const react = require("../apps/web/node_modules/react") as { createElement: (type: unknown, props: unknown) => unknown };
    const reactDomServer = require("../apps/web/node_modules/react-dom/server.node.js") as { renderToString: (element: unknown) => string };
    const localProvider = providerFixture({ ready: true, recommendedAction: "none" });
    const remoteProvider = providerFixture({
      ready: false,
      recommendedAction: "login",
      safeMessage: "Sign in to Codex on Remote Devbox."
    });
    const html = reactDomServer.renderToString(react.createElement(module.ConnectionFooter, {
      collapsed: false,
      bridgeStatusState: "online",
      fallbackConnection: { status: "offline", tokenPresent: false },
      onOpen: () => undefined,
      bridgeStatus: {
        provider: localProvider,
        connections: [
          {
            backendId: "local",
            mode: "local",
            label: "This computer",
            provider: localProvider,
            connection: { state: "connected" },
            workspaces: []
          },
          {
            backendId: "remote:device_1",
            mode: "remote",
            label: "Remote Devbox",
            device: { deviceId: "device_1", name: "Remote Devbox", registered: true, online: true },
            provider: remoteProvider,
            connection: { state: "connected" },
            workspaces: [{
              workspaceId: "roadmap_remote",
              roadmapId: "roadmap_remote",
              displayName: "Remote Workspace",
              lifecycle: "active",
              health: "ok",
              backendId: "remote:device_1",
              connectionMode: "remote",
              provider: { providerId: "codex", label: "Codex", readyForExecute: false },
              actions: ["open_studio"]
            }]
          }
        ],
        workspaces: { active: [], managed: [] },
        account: { signedIn: true, userId: "user_1" }
      }
    }));

    assert.match(html, /Local Bridge/);
    assert.match(html, /This computer · Codex ready/);
    assert.match(html, /Provider/);
    assert.match(html, /Codex · Ready/);
    assert.match(html, /Remote/);
    assert.match(html, /Codex login required/);
    assert.match(html, /Remote Workspace/);
  } finally {
    await close();
  }
});

test("Workspace connection list renders remote backend provider readiness", async () => {
  const { module, close } = await loadWorkspaceConnectionListModule();
  try {
    const react = require("../apps/web/node_modules/react") as { createElement: (type: unknown, props: unknown) => unknown };
    const reactDomServer = require("../apps/web/node_modules/react-dom/server.node.js") as { renderToString: (element: unknown) => string };
    const html = reactDomServer.renderToString(react.createElement(module.WorkspaceConnectionList, {
      compact: false,
      connections: [
        {
          backendId: "local",
          mode: "local",
          label: "This computer",
          provider: providerFixture({ ready: true, recommendedAction: "none" }),
          connection: { state: "connected" },
          workspaces: []
        },
        {
          backendId: "remote:device_1",
          mode: "remote",
          label: "Remote Devbox",
          provider: providerFixture({ ready: false, recommendedAction: "login" }),
          connection: { state: "connected" },
          workspaces: [{
            workspaceId: "remote_workspace",
            roadmapId: "remote_workspace",
            displayName: "Remote Workspace",
            lifecycle: "active",
            health: "ok",
            backendId: "remote:device_1",
            connectionMode: "remote",
            provider: { providerId: "codex", label: "Codex", readyForExecute: false },
            actions: ["open_studio"]
          }]
        }
      ]
    }));

    assert.match(html, /Remote · Remote Devbox/);
    assert.match(html, /Codex login required/);
    assert.match(html, /Remote Workspace/);
  } finally {
    await close();
  }
});

test("Connection Center normal actions use Provider, Workspaces, and Connections language", () => {
  const source = readFileSync(join(process.cwd(), "apps/web/src/features/connection/ConnectionCenter.tsx"), "utf8");
  const actionStart = source.indexOf("<div className=\"flex flex-wrap gap-2\">", source.indexOf("<RemoteBridgeSection"));
  const actionEnd = source.indexOf("<details", actionStart);
  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);
  const normalActions = source.slice(actionStart, actionEnd);
  assert.match(normalActions, /setupPath/);
  assert.match(normalActions, /pushStudioPath\("\/studio"\)/);
  assert.doesNotMatch(normalActions, /download\/bridge|window\.location\.href/);
  assert.doesNotMatch(normalActions, /remote-disable|pairAgainLink|Project Grant|Project access/);
  assert.match(source, /BackendProviderList/);
  assert.match(source, /backend\.provider/);
  assert.doesNotMatch(source, /ProviderStatusCard provider=\{bridgeModel\.data\.provider\}/);
});

test("Web remote Bridge client lists, connects, and routes commands directly through Relay", async () => {
  const calls: Array<{ method: string; url: string; authorization?: string; body?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.relayAccessToken", "relay-token"]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    calls.push({
      method: init?.method ?? "GET",
      url: requestUrl.toString(),
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined
    });
    if (requestUrl.pathname === "/v1/devices") {
      return new Response(JSON.stringify({
        devices: [{
          deviceId: "device_1",
          deviceName: "devbox",
          userId: "user@example.test",
          registeredAt: "2026-07-08T00:00:00.000Z",
          lastSeenAt: "2026-07-08T00:01:00.000Z",
          status: "online",
          bridgeVersion: "0.1.2",
          protocolVersion: "local-bridge-v1"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.pathname === "/v1/project-grants/status") {
      return new Response(JSON.stringify({ projectAccess: "granted" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.pathname === "/v1/commands") {
      return new Response(JSON.stringify({ ok: true, status: 200, body: { roadmaps: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `Unexpected request: ${requestUrl}` }), { status: 500, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    const devices = await module.fetchRemoteBridgeDevices();
    assert.equal(devices[0]?.deviceName, "devbox");

    const connected = await module.postRemoteBridgeConnect({
      deviceId: "device_1",
      webUserId: "user@example.test",
      projectPath: "/tmp/hunsu-project"
    });
    assert.equal(connected.connection.mode, "remote");
    assert.equal(connected.connection.transport, "relay");
    assert.equal(connected.connection.projectAccess, "granted");

    const roadmaps = await module.fetchRoadmapRegistry();
    assert.deepEqual(roadmaps, []);

    assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
      "/v1/devices",
      "/v1/devices",
      "/v1/project-grants/status",
      "/v1/commands"
    ]);
    assert.equal(calls.every(call => call.authorization === "Bearer relay-token"), true);
    assert.equal(calls.some(call => call.url.includes("/api/remote")), false);
    const relayCommand = JSON.parse(calls.at(-1)?.body ?? "{}") as { command?: string; deviceId?: string };
    assert.equal(relayCommand.command, "roadmap.registry.list");
    assert.equal(relayCommand.deviceId, "device_1");
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Studio Bridge-backed routes require a verified Remote Bridge session", async () => {
  const { module, close } = await loadAppModule();
  try {
    for (const routePath of ["/studio", "/studio/roadmaps/roadmap_123"]) {
      const staleInput = {
        routeNeedsBridge: true,
        hasLocalBridgeSession: false,
        hasRemoteBridgeSession: true,
        hasVerifiedRemoteBridgeSession: false,
        bridgeStatus: "offline" as const
      };
      assert.equal(module.shouldRedirectBridgeBackedStudioRoute(staleInput), true, `${routePath} should redirect stale remote sessions to setup`);
      assert.equal(module.shouldRenderBridgeBackedSetup(staleInput), true, `${routePath} should render setup for stale remote sessions`);

      const verifiedInput = {
        ...staleInput,
        hasVerifiedRemoteBridgeSession: true
      };
      assert.equal(module.shouldRedirectBridgeBackedStudioRoute(verifiedInput), false, `${routePath} should not redirect verified remote sessions`);
      assert.equal(module.shouldRenderBridgeBackedSetup(verifiedInput), false, `${routePath} should render verified remote sessions`);
    }
  } finally {
    await close();
  }
});

test("Studio Bridge-backed routes require a usable local Bridge pairing", async () => {
  const { module, close } = await loadAppModule();
  try {
    const pairedInput = {
      routeNeedsBridge: true,
      hasLocalBridgeSession: true,
      hasVerifiedRemoteBridgeSession: false,
      bridgeStatus: "online" as const,
      bridgeConnection: studioConnectionStatus()
    };
    assert.equal(module.shouldRedirectBridgeBackedStudioRoute(pairedInput), false);
    assert.equal(module.shouldRenderBridgeBackedSetup(pairedInput), false);

    for (const auth of ["expired", "invalid", "missing_token"] as const) {
      const rejectedInput = {
        ...pairedInput,
        bridgeConnection: studioConnectionStatus({ auth, health: "error", error: `Pairing ${auth}` })
      };
      assert.equal(module.shouldRedirectBridgeBackedStudioRoute(rejectedInput), true, `${auth} local pairing should redirect to setup`);
      assert.equal(module.shouldRenderBridgeBackedSetup(rejectedInput), true, `${auth} local pairing should render setup`);
    }

    const incompatibleInput = {
      ...pairedInput,
      bridgeConnection: studioConnectionStatus({
        compatibility: { compatible: false, reason: "bridge_update_needed", message: "Bridge is too old." },
        warnings: ["version_mismatch"]
      })
    };
    assert.equal(module.shouldRedirectBridgeBackedStudioRoute(incompatibleInput), true);
    assert.equal(module.shouldRenderBridgeBackedSetup(incompatibleInput), true);
  } finally {
    await close();
  }
});

test("Web remote Bridge client stores a session only after a usable connection", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>();
  const responses = [
    remoteConnectResult({ auth: "account_mismatch", account: { webUserId: "web@example.test", bridgeUserId: "bridge@example.test", sameUser: false } }),
    remoteConnectResult({ projectAccess: "needs_grant" }),
    remoteConnectResult({
      compatibility: { compatible: false, reason: "feature_unavailable", message: "Required feature is unavailable." },
      warnings: ["version_mismatch"]
    }),
    remoteConnectResult({ projectAccess: "granted" })
  ];
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    assert.equal(requestUrl.pathname, "/api/remote/connect");
    const response = responses.shift();
    assert.ok(response);
    return new Response(JSON.stringify(response), { status: 202, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    await module.postRemoteBridgeConnect({ deviceId: "device_1", webUserId: "web@example.test", projectPath: "/tmp/hunsu-project" });
    assert.equal(storage.has("hunsu.remoteBridgeSession"), false);

    await module.postRemoteBridgeConnect({ deviceId: "device_1", webUserId: "web@example.test", projectPath: "/tmp/hunsu-project" });
    assert.equal(storage.has("hunsu.remoteBridgeSession"), false);

    await module.postRemoteBridgeConnect({ deviceId: "device_1", webUserId: "web@example.test", projectPath: "/tmp/hunsu-project" });
    assert.equal(storage.has("hunsu.remoteBridgeSession"), false);

    await module.postRemoteBridgeConnect({ deviceId: "device_1", webUserId: "web@example.test", projectPath: "/tmp/hunsu-project" });
    const stored = JSON.parse(storage.get("hunsu.remoteBridgeSession") ?? "{}") as { deviceId?: string; projectPath?: string; webUserId?: string };
    assert.deepEqual(stored, {
      deviceId: "device_1",
      deviceName: "devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "web@example.test",
      relayAccessToken: ""
    });
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Roadmap workspace APIs route through Relay with no local Bridge token", async () => {
  const commands: Array<{ command: string; payload?: Record<string, unknown>; projectPath?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio/roadmaps/roadmap_123"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.origin, "https://relay.example.test");
    assert.equal(requestUrl.pathname, "/v1/commands");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer relay-token");
    const command = JSON.parse(String(init?.body ?? "{}")) as { command: string; payload?: Record<string, unknown>; projectPath?: string };
    commands.push(command);
    return new Response(JSON.stringify({
      ok: true,
      status: command.command.startsWith("hunsuDraft.") || command.command.startsWith("line.") || command.command === "roadmap.commands" ? 202 : 200,
      body: remoteCommandBody(command.command)
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    const bridgeStatus = await module.fetchBridgeStatus();
    await module.fetchBoard("roadmap_123");
    await module.fetchWorktree("roadmap_123");
    await module.fetchSkills("roadmap_123");
    await module.fetchRuns("roadmap_123");
    await module.fetchArtifactActions("roadmap_123");
    await module.fetchActionRuns("roadmap_123");
    await module.fetchHunsuDrafts("roadmap_123");
    await module.fetchMoveFileTree("roadmap_123", "M0001", "src");
    await module.fetchMoveFileBlob("roadmap_123", "M0001", "src/App.tsx");
    await module.fetchMoveFileDiff("roadmap_123", "M0001");
    await module.postCommands("roadmap_123", []);
    await module.postLineDecision("roadmap_123", "accept", { lineId: "line_1", reason: "Looks good" });
    await module.postRunAction("roadmap_123", "pause", { runId: "run_1" });
    await module.postMoveCompletion("roadmap_123", {
      runId: "run_1",
      fromRef: "HEAD",
      summary: "Done",
      destinationIds: ["destination_1"],
      evidence: ["verified"],
      risks: [],
      approvedRisks: true
    });
    await module.fetchAgentSessions("roadmap_123");
    await module.fetchAgentSession("roadmap_123", "agent_1");
    await module.postHunsuDraftStart("roadmap_123", { sourceNodeId: "node_1", message: "Change plan" });
    await module.postHunsuDraftMessage("roadmap_123", "draft_1", "Please update the TODO");
    await module.fetchHunsuDraftDiffArtifact("roadmap_123", "draft_1", "diff_1");
    await module.postHunsuDraftApprove("roadmap_123", "draft_1", "diff_1", "Team");
    await module.postHunsuDraftDiscard("roadmap_123", "draft_1");

    assert.equal(bridgeStatus.connections[0]?.mode, "remote");
    assert.equal(bridgeStatus.connections[0]?.label, "Remote Devbox");
    assert.equal(bridgeStatus.connections[0]?.workspaces[0]?.path, "/tmp/hunsu-project");
    assert.equal(bridgeStatus.connections[0]?.workspaces[0]?.pathRedacted, undefined);
    assert.equal(bridgeStatus.workspaces.active[0]?.path, "/tmp/hunsu-project");
    assert.equal(bridgeStatus.workspaces.active[0]?.pathRedacted, undefined);
    assert.deepEqual(commands.map(command => command.command), [
      "bridge.status",
      "roadmap.board",
      "roadmap.worktree",
      "roadmap.skills",
      "execute.status",
      "artifactAction.list",
      "artifactAction.runs",
      "hunsuDraft.list",
      "moveFile.tree",
      "moveFile.blob",
      "moveFile.diff",
      "roadmap.commands",
      "line.accept",
      "execute.pause",
      "execute.completeMove",
      "agentSession.list",
      "agentSession.get",
      "hunsuDraft.start",
      "hunsuDraft.message",
      "hunsuDraft.diffArtifact.get",
      "hunsuDraft.approve",
      "hunsuDraft.discard"
    ]);
    assert.equal(commands.filter(command => command.command !== "bridge.status").every(command => command.projectPath === "/tmp/hunsu-project"), true);
    assert.deepEqual(commands.find(command => command.command === "moveFile.blob")?.payload, {
      roadmapId: "roadmap_123",
      moveId: "M0001",
      path: "src/App.tsx"
    });
    assert.deepEqual(commands.find(command => command.command === "hunsuDraft.diffArtifact.get")?.payload, {
      roadmapId: "roadmap_123",
      draftSessionId: "draft_1",
      diffArtifactId: "diff_1"
    });
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Bridge status falls back to Remote Bridge when local status is unavailable", async () => {
  const calls: Array<{ origin: string; pathname: string; command?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.bridgeApiToken", "stale-local-token"],
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    if (requestUrl.pathname === "/api/bridge/status") {
      calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname });
      throw new TypeError("local Bridge is offline");
    }
    const command = JSON.parse(String(init?.body ?? "{}")) as { command: string };
    calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname, command: command.command });
    return new Response(JSON.stringify({
      ok: true,
      status: 200,
      body: remoteCommandBody(command.command)
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    const status = await module.fetchBridgeStatus();
    assert.equal(status.connections[0]?.mode, "remote");
    assert.equal(status.connections[0]?.label, "Remote Devbox");
    assert.deepEqual(calls, [
      { origin: "https://studio.example.test", pathname: "/api/bridge/status" },
      { origin: "https://relay.example.test", pathname: "/v1/commands", command: "bridge.status" }
    ]);
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Execute start uses selected remote backend even when local token exists", async () => {
  const commands: Array<{ command: string; payload?: Record<string, unknown>; projectPath?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.bridgeApiToken", "local-token"],
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio/roadmaps/roadmap_123",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    assert.equal(requestUrl.origin, "https://relay.example.test");
    assert.equal(requestUrl.pathname, "/v1/commands");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer relay-token");
    const command = JSON.parse(String(init?.body ?? "{}")) as { command: string; payload?: Record<string, unknown>; projectPath?: string };
    commands.push(command);
    return new Response(JSON.stringify({
      ok: true,
      status: 202,
      body: { run: { runId: "run_remote", status: "running" } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    await module.postRunAction("roadmap_123", "start", {
      requestId: "request_1",
      lineId: "line_1",
      selectedDestinationIds: ["destination_1"]
    });
    assert.equal(commands[0]?.command, "execute.start");
    assert.equal(commands[0]?.projectPath, "/tmp/hunsu-project");
    assert.equal(commands[0]?.payload?.backendId, "remote:device_1");
    assert.equal(commands[0]?.payload?.connectionMode, "remote");
    assert.deepEqual(commands[0]?.payload?.workspace, {
      workspaceId: "roadmap_123",
      backendId: "remote:device_1",
      connectionMode: "remote"
    });
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web backend-scoped transport lets explicit backend IDs override conflicting connection modes", async () => {
  const calls: Array<{
    transport: "local" | "relay";
    body: Record<string, unknown>;
    command?: string;
  }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio/roadmaps/roadmap_123",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (requestUrl.pathname === "/v1/commands") {
      const command = parsed as { command?: string; payload?: Record<string, unknown> };
      calls.push({ transport: "relay", command: command.command, body: command.payload ?? {} });
      if (command.command === "provider.inventory") {
        return new Response(JSON.stringify({
          ok: true,
          status: 200,
          body: { ok: true, value: { backendId: "remote:device_1", providers: [] } }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        status: 202,
        body: { run: { runId: "run_remote", status: "running" } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push({ transport: "local", body: parsed });
    if (requestUrl.pathname === "/api/providers/inventory") {
      return new Response(JSON.stringify({
        ok: true,
        value: { backendId: "local", providers: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      run: { runId: "run_local", status: "running" }
    }), { status: 202, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  const start = (body: Record<string, unknown>) => module.postRunAction("roadmap_123", "start", {
    requestId: "request_1",
    lineId: "line_1",
    selectedDestinationIds: ["destination_1"],
    ...body
  });
  try {
    await start({ backendId: "local", connectionMode: "remote" });
    await start({
      connectionMode: "remote",
      workspace: { backendId: "local", connectionMode: "remote" }
    });
    await start({ backendId: "remote:device_1", connectionMode: "local" });
    await start({
      connectionMode: "local",
      workspace: { backendId: "remote:device_1", connectionMode: "local" }
    });
    await module.fetchModelInventory("local");
    await module.fetchModelInventory("remote:device_1");

    assert.deepEqual(calls.map(call => call.transport), ["local", "local", "relay", "relay", "local", "relay"]);
    assert.equal(calls.filter(call => call.transport === "local").some(call => call.command), false);
    assert.equal(calls.slice(2, 4).every(call => call.command === "execute.start"), true);
    for (const call of calls.slice(0, 2)) {
      assert.equal(call.body.backendId, "local");
      assert.equal(call.body.connectionMode, "local");
      assert.deepEqual(call.body.workspace, {
        workspaceId: "roadmap_123",
        backendId: "local",
        connectionMode: "local"
      });
    }
    for (const call of calls.slice(2)) {
      if (call.command === "provider.inventory" || call.transport === "local") {
        continue;
      }
      assert.equal(call.body.backendId, "remote:device_1");
      assert.equal(call.body.connectionMode, "remote");
      assert.deepEqual(call.body.workspace, {
        workspaceId: "roadmap_123",
        backendId: "remote:device_1",
        connectionMode: "remote"
      });
    }
    assert.deepEqual(calls[5], {
      transport: "relay",
      command: "provider.inventory",
      body: { backendId: "remote:device_1" }
    });
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Bridge status keeps local and selected remote workspaces together", async () => {
  const calls: Array<{ origin: string; pathname: string; command?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.bridgeApiToken", "local-token"],
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    if (requestUrl.pathname === "/api/bridge/status") {
      calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname });
      return new Response(JSON.stringify({
        provider: providerFixture(),
        connections: [{
          backendId: "local",
          mode: "local",
          label: "This computer",
          provider: providerFixture(),
          connection: { state: "connected" },
          workspaces: [{
            workspaceId: "roadmap_local",
            roadmapId: "roadmap_local",
            displayName: "Local Workspace",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio"]
          }]
        }],
        workspaces: {
          active: [{
            workspaceId: "roadmap_local",
            roadmapId: "roadmap_local",
            displayName: "Local Workspace",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio"]
          }],
          managed: []
        },
        account: { signedIn: false }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const command = JSON.parse(String(init?.body ?? "{}")) as { command: string };
    calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname, command: command.command });
    return new Response(JSON.stringify({
      ok: true,
      status: 200,
      body: remoteCommandBody(command.command)
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    const status = await module.fetchBridgeStatus();
    assert.deepEqual(status.connections.map(connection => connection.mode), ["local", "remote"]);
    assert.equal(status.connections.find(connection => connection.mode === "local")?.workspaces[0]?.displayName, "Local Workspace");
    assert.equal(status.connections.find(connection => connection.mode === "remote")?.workspaces[0]?.displayName, "Remote Workspace");
    assert.deepEqual(status.workspaces.active.map(workspace => workspace.displayName), ["Local Workspace", "Remote Workspace"]);
    assert.deepEqual(calls, [
      { origin: "https://studio.example.test", pathname: "/api/bridge/status" },
      { origin: "https://relay.example.test", pathname: "/v1/commands", command: "bridge.status" }
    ]);
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Bridge status refreshes selected remote status over stale relay snapshot", async () => {
  const calls: Array<{ origin: string; pathname: string; command?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.bridgeApiToken", "local-token"],
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      deviceName: "Remote Devbox",
      projectPath: "/tmp/hunsu-project",
      webUserId: "user_1",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    if (requestUrl.pathname === "/api/bridge/status") {
      calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname });
      const staleWorkspace = {
        workspaceId: "roadmap_stale",
        roadmapId: "roadmap_stale",
        displayName: "Stale Relay Workspace",
        lifecycle: "active",
        health: "ok",
        backendId: "remote:device_1",
        connectionMode: "remote",
        provider: { providerId: "codex", label: "Codex", readyForExecute: false },
        actions: ["open_studio"]
      };
      return new Response(JSON.stringify({
        provider: providerFixture(),
        connections: [
          {
            backendId: "local",
            mode: "local",
            label: "This computer",
            provider: providerFixture(),
            connection: { state: "connected" },
            workspaces: []
          },
          {
            backendId: "remote:device_1",
            mode: "remote",
            label: "Remote Devbox",
            provider: providerFixture({ ready: false, recommendedAction: "recheck" }),
            connection: { state: "connected" },
            workspaces: [staleWorkspace]
          }
        ],
        workspaces: {
          active: [staleWorkspace],
          managed: [staleWorkspace]
        },
        account: { signedIn: true, userId: "user_1" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const command = JSON.parse(String(init?.body ?? "{}")) as { command: string };
    calls.push({ origin: requestUrl.origin, pathname: requestUrl.pathname, command: command.command });
    return new Response(JSON.stringify({
      ok: true,
      status: 200,
      body: remoteCommandBody(command.command)
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const { module, close } = await loadBridgeClientModule();
  try {
    const status = await module.fetchBridgeStatus();
    const remoteConnection = status.connections.find(connection => connection.backendId === "remote:device_1");
    assert.equal(remoteConnection?.workspaces.length, 1);
    assert.equal(remoteConnection?.workspaces[0]?.displayName, "Remote Workspace");
    assert.deepEqual(status.workspaces.active.map(workspace => workspace.displayName), ["Remote Workspace"]);
    assert.deepEqual(calls, [
      { origin: "https://studio.example.test", pathname: "/api/bridge/status" },
      { origin: "https://relay.example.test", pathname: "/v1/commands", command: "bridge.status" }
    ]);
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("Web Roadmap workspace APIs prefer local Bridge when local and remote sessions both exist", async () => {
  const fetches: Array<{ method: string; pathname: string; authorization?: string }> = [];
  const eventSourceUrls: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const globalWithEventSource = globalThis as unknown as { EventSource?: typeof EventSource };
  const previousEventSource = globalWithEventSource.EventSource;
  const storage = new Map<string, string>([
    ["hunsu.bridgeApiToken", "local-token"],
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      projectPath: "/tmp/hunsu-project",
      relayAccessToken: "relay-token"
    })]
  ]);
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      href: "https://studio.example.test/studio/roadmaps/roadmap_123",
      origin: "https://studio.example.test"
    },
    history: {
      replaceState() {}
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      }
    }
  };
  globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url), "https://studio.example.test");
    fetches.push({
      method: init?.method ?? "GET",
      pathname: requestUrl.pathname,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined
    });
    assert.equal(requestUrl.origin, "https://studio.example.test");
    if (requestUrl.pathname === "/api/roadmaps/roadmap_123/board") {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.pathname === "/api/roadmaps/roadmap_123/runs") {
      return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `Unexpected request: ${requestUrl}` }), { status: 500, headers: { "content-type": "application/json" } });
  };
  class TestEventSource {
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string | URL) {
      eventSourceUrls.push(String(url));
    }

    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  globalWithEventSource.EventSource = TestEventSource as unknown as typeof EventSource;

  const { module, close } = await loadBridgeClientModule();
  try {
    await module.fetchBoard("roadmap_123");
    await module.fetchRuns("roadmap_123");
    const unsubscribeRunEvents = module.subscribeRunEvents("roadmap_123", () => {}, () => {});
    const unsubscribeAgentEvents = module.subscribeAgentSessionEvents("roadmap_123", "agent_1", () => {}, () => {});
    unsubscribeRunEvents();
    unsubscribeAgentEvents();

    assert.deepEqual(fetches, [
      { method: "GET", pathname: "/api/roadmaps/roadmap_123/board", authorization: "Bearer local-token" },
      { method: "GET", pathname: "/api/roadmaps/roadmap_123/runs", authorization: "Bearer local-token" }
    ]);
    assert.equal(fetches.some(call => call.pathname === "/v1/commands" || call.pathname.startsWith("/api/remote/")), false);

    assert.equal(eventSourceUrls.length, 2);
    const runEventsUrl = new URL(eventSourceUrls[0] ?? "", "https://studio.example.test");
    assert.equal(runEventsUrl.origin, "https://relay.example.test");
    assert.equal(runEventsUrl.pathname, "/v1/commands/events");
    assert.equal(runEventsUrl.searchParams.get("access_token"), "relay-token");
    const runCommand = JSON.parse(runEventsUrl.searchParams.get("command") ?? "{}") as { command?: string; payload?: { roadmapId?: string } };
    assert.equal(runCommand.command, "live.events");
    assert.equal(runCommand.payload?.roadmapId, "roadmap_123");

    const agentEventsUrl = new URL(eventSourceUrls[1] ?? "", "https://studio.example.test");
    assert.equal(agentEventsUrl.origin, "https://relay.example.test");
    assert.equal(agentEventsUrl.pathname, "/v1/commands/events");
    assert.equal(agentEventsUrl.searchParams.get("access_token"), "relay-token");
    const agentCommand = JSON.parse(agentEventsUrl.searchParams.get("command") ?? "{}") as { command?: string; payload?: { roadmapId?: string; sessionId?: string } };
    assert.equal(agentCommand.command, "agentSession.events");
    assert.equal(agentCommand.payload?.roadmapId, "roadmap_123");
    assert.equal(agentCommand.payload?.sessionId, "agent_1");
  } finally {
    await close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
    if (previousEventSource) {
      globalWithEventSource.EventSource = previousEventSource;
    } else {
      delete globalWithEventSource.EventSource;
    }
  }
});

function studioConnectionStatus(overrides: Partial<StudioConnectionStatus> = {}): StudioConnectionStatus {
  const connection: StudioConnectionStatus = {
    mode: "local",
    transport: "direct",
    health: "connected",
    auth: "paired",
    projectAccess: "granted",
    bridge: {
      id: "local:127.0.0.1:19687",
      name: "Local Bridge",
      version: "0.1.1",
      protocolVersion: "local-bridge-v1"
    },
    endpoint: {
      apiUrl: "http://127.0.0.1:19687"
    },
    warnings: [],
    version: {
      bridgeVersion: "0.1.1",
      protocolVersion: "local-bridge-v1",
      supportedFeatures: []
    },
    compatibility: { compatible: true },
    ...overrides
  };
  return connection;
}

function onlineConnection(overrides: Partial<StudioConnectionStatus>): BridgeConnectionState {
  const connection = studioConnectionStatus(overrides);
  return {
    status: "online",
    tokenPresent: true,
    connection,
    version: connection.version
  };
}

function providerFixture(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "codex",
    kind: "codex",
    label: "Codex",
    connectionKind: "local_cli",
    installed: true,
    configured: true,
    authenticated: true,
    ready: true,
    auth: { kind: "chatgpt_oauth", state: "authenticated", access: "subscription" },
    capabilities: {
      canExecute: true,
      canEditFiles: true,
      canRunShell: true,
      supportsWorktree: true,
      supportsEventStream: true,
      supportsUsage: true,
      supportsSubscriptionAuth: true,
      supportsDeviceAuth: true,
      supportsApiKeyAuth: true,
      supportsRemoteRelay: true,
      supportsAcp: false
    },
    recommendedAction: "none",
    ...overrides
  };
}

function remoteConnectResult(overrides: Partial<StudioConnectionStatus>) {
  const compatibility = overrides.compatibility ?? { compatible: true as const };
  return {
    device: {
      deviceId: "device_1",
      deviceName: "devbox",
      userId: "bridge@example.test",
      registeredAt: "2026-07-08T00:00:00.000Z",
      lastSeenAt: "2026-07-08T00:01:00.000Z",
      status: "online" as const,
      bridgeVersion: "0.1.2",
      protocolVersion: "local-bridge-v1"
    },
    compatibility,
    connection: studioConnectionStatus({
      mode: "remote",
      transport: "relay",
      auth: "paired",
      projectAccess: "granted",
      bridge: {
        id: "device_1",
        name: "devbox",
        version: "0.1.2",
        protocolVersion: "local-bridge-v1",
        lastSeenAt: "2026-07-08T00:01:00.000Z"
      },
      endpoint: {
        relayLabel: "Hunsu Relay"
      },
      account: {
        webUserId: "web@example.test",
        bridgeUserId: "web@example.test",
        sameUser: true
      },
      compatibility,
      ...overrides
    })
  };
}

function remoteCommandBody(command: string): unknown {
  switch (command) {
    case "bridge.status":
      return {
        provider: {
          providerId: "codex",
          kind: "codex",
          label: "Codex",
          ready: true,
          installed: true,
          configured: true,
          authenticated: true,
          auth: { state: "authenticated" },
          capabilities: { canExecute: true }
        },
        connections: [{
          backendId: "local",
          mode: "local",
          label: "This computer",
          connection: { state: "connected" },
          workspaces: [{
            workspaceId: "roadmap_123",
            roadmapId: "roadmap_123",
            displayName: "Remote Workspace",
            path: "/tmp/hunsu-project",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio"]
          }]
        }],
        workspaces: {
          active: [{
            workspaceId: "roadmap_123",
            roadmapId: "roadmap_123",
            displayName: "Remote Workspace",
            path: "/tmp/hunsu-project",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio"]
          }],
          managed: [{
            workspaceId: "roadmap_123",
            roadmapId: "roadmap_123",
            displayName: "Remote Workspace",
            path: "/tmp/hunsu-project",
            lifecycle: "active",
            health: "ok",
            backendId: "local",
            connectionMode: "local",
            provider: { providerId: "codex", label: "Codex", readyForExecute: true },
            actions: ["open_studio"]
          }]
        },
        account: { signedIn: true, userId: "user_1" }
      };
    case "roadmap.skills":
      return { skills: [] };
    case "execute.status":
      return { runs: [] };
    case "artifactAction.list":
      return { actions: [] };
    case "artifactAction.runs":
      return { runs: [] };
    case "hunsuDraft.list":
      return { drafts: [] };
    case "moveFile.tree":
      return { tree: { root: "", entries: [] } };
    case "moveFile.blob":
      return { blob: { path: "src/App.tsx", text: "", binary: false } };
    case "moveFile.diff":
      return { diff: { files: [] } };
    case "roadmap.commands":
    case "line.accept":
      return { acceptedEvents: [], board: {} };
    case "execute.pause":
      return { run: { runId: "run_1" }, board: {} };
    case "execute.completeMove":
      return { run: { runId: "run_1" }, board: {}, moveId: "M0002", commit: "abc123", acceptedEvents: [] };
    case "agentSession.list":
      return { sessions: [] };
    case "agentSession.get":
      return { session: { sessionId: "agent_1" } };
    case "hunsuDraft.diffArtifact.get":
      return { diffArtifact: { diffArtifactId: "diff_1", status: "pass", files: [], errors: [] } };
    case "hunsuDraft.start":
    case "hunsuDraft.message":
    case "hunsuDraft.approve":
    case "hunsuDraft.discard":
      return { draft: { draftSessionId: "draft_1" }, board: {} };
    default:
      return {};
  }
}

async function loadConnectionModule(): Promise<{
  module: { connectionCardLabel: (connection: BridgeConnectionState) => string };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: { connectionCardLabel: (connection: BridgeConnectionState) => string };
  try {
    module = await server.ssrLoadModule("/src/features/connection/ConnectionCenter.tsx") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadConnectionFooterModule(): Promise<{
  module: {
    ConnectionFooter: (props: unknown) => unknown;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadConnectionFooterModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/connection/ConnectionFooter.tsx") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadWorkspaceConnectionListModule(): Promise<{
  module: {
    WorkspaceConnectionList: (props: unknown) => unknown;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadWorkspaceConnectionListModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/connection/WorkspaceConnectionList.tsx") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadPreflightActionsModule(): Promise<{
  module: {
    bridgeActionHref: (action: {
      type:
        | "open_provider_setup"
        | "open_workspaces"
        | "open_connection"
        | "install_provider"
        | "login_provider"
        | "recheck_provider"
        | "activate_workspace"
        | "edit_model_alias";
      label: string;
      href?: string;
      workspaceId?: string;
      providerId?: string;
    }) => string;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    }
  });
  let module: Awaited<ReturnType<typeof loadPreflightActionsModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/roadmap-workspace/preflightActions.ts") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadRoadmapWorkspaceModule(): Promise<{
  module: {
    RoadmapWorkspacePreflightActions: (props: unknown) => unknown;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    }
  });
  let module: Awaited<ReturnType<typeof loadRoadmapWorkspaceModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/roadmap-workspace/RoadmapWorkspace.tsx") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadAppModule(): Promise<{
  module: {
    shouldRedirectBridgeBackedStudioRoute: (input: {
      routeNeedsBridge: boolean;
      hasLocalBridgeSession: boolean;
      hasRemoteBridgeSession?: boolean;
      hasVerifiedRemoteBridgeSession?: boolean;
      bridgeStatus: "idle" | "checking" | "online" | "offline";
      bridgeConnection?: StudioConnectionStatus;
    }) => boolean;
    shouldRenderBridgeBackedSetup: (input: {
      routeNeedsBridge: boolean;
      hasLocalBridgeSession: boolean;
      hasRemoteBridgeSession?: boolean;
      hasVerifiedRemoteBridgeSession?: boolean;
      bridgeStatus: "idle" | "checking" | "online" | "offline";
      bridgeConnection?: StudioConnectionStatus;
    }) => boolean;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify("https://relay.example.test"),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadAppModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/app/App.tsx") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadBridgeClientModule(): Promise<{
  module: {
    fetchRemoteBridgeDevices: () => Promise<Array<{ deviceName: string }>>;
    postRemoteBridgeConnect: (input: { deviceId: string; webUserId?: string; projectPath?: string }) => Promise<{ connection: StudioConnectionStatus }>;
    fetchBridgeStatus: () => Promise<BridgeStatusResponse>;
    fetchModelInventory: (backendId?: string) => Promise<unknown>;
    fetchRoadmapRegistry: () => Promise<unknown[]>;
    fetchBoard: (roadmapId: string) => Promise<unknown>;
    fetchWorktree: (roadmapId: string) => Promise<unknown>;
    fetchSkills: (roadmapId: string) => Promise<unknown[]>;
    fetchRuns: (roadmapId: string) => Promise<unknown[]>;
    fetchArtifactActions: (roadmapId: string) => Promise<unknown[]>;
    fetchActionRuns: (roadmapId: string) => Promise<unknown[]>;
    fetchHunsuDrafts: (roadmapId: string) => Promise<unknown[]>;
    fetchMoveFileTree: (roadmapId: string, moveId: string, path?: string) => Promise<unknown>;
    fetchMoveFileBlob: (roadmapId: string, moveId: string, path: string) => Promise<unknown>;
    fetchMoveFileDiff: (roadmapId: string, moveId: string) => Promise<unknown>;
    postCommands: (roadmapId: string, commands: []) => Promise<unknown>;
    postLineDecision: (roadmapId: string, decision: "accept" | "reject", body: { lineId: string; reason?: string }) => Promise<unknown>;
    postRunAction: (roadmapId: string, action: "start" | "pause" | "resume" | "stop", body: unknown) => Promise<unknown>;
    postMoveCompletion: (roadmapId: string, body: {
      runId: string;
      fromRef: string;
      summary: string;
      destinationIds: string[];
      evidence: string[];
      risks: string[];
      approvedRisks: boolean;
    }) => Promise<unknown>;
    fetchAgentSessions: (roadmapId: string) => Promise<unknown[]>;
    fetchAgentSession: (roadmapId: string, sessionId: string) => Promise<unknown>;
    postHunsuDraftStart: (roadmapId: string, body: { sourceNodeId?: string; message?: string }) => Promise<unknown>;
    postHunsuDraftMessage: (roadmapId: string, draftSessionId: string, message: string) => Promise<unknown>;
    fetchHunsuDraftDiffArtifact: (roadmapId: string, draftSessionId: string, diffArtifactId: string) => Promise<unknown>;
    postHunsuDraftApprove: (roadmapId: string, draftSessionId: string, diffArtifactId: string, teamName: string) => Promise<unknown>;
    postHunsuDraftDiscard: (roadmapId: string, draftSessionId: string) => Promise<unknown>;
    subscribeRunEvents: (roadmapId: string, onEvent: (event: unknown) => void, onError: () => void) => () => void;
    subscribeAgentSessionEvents: (roadmapId: string, sessionId: string, onEvent: (event: unknown) => void, onError: () => void) => () => void;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify("https://relay.example.test"),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadBridgeClientModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/shared/api/bridgeClient.ts") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadModelSelectionAssignmentModule(): Promise<{
  module: {
    assignManagerModelSelection: (manager: any, assignment: any) => any;
    assignMemberModelSelection: (member: any, assignment: any) => any;
    assignExecutorModelSelection: (executor: any, assignment: any) => any;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify("https://relay.example.test"),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadModelSelectionAssignmentModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/model-aliases/modelSelectionAssignment.ts") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadModelConfigDraftStorageModule(): Promise<{
  module: {
    createDefaultWebModelConfigDraft: (now?: string) => any;
    assignWebModelConfigDraft: (draft: any, target: "manager" | "member" | "executor", assignment: any, now?: string) => any;
    readWebModelConfigDraft: () => any;
    writeWebModelConfigDraft: (draft: any) => void;
  };
  close: () => Promise<void>;
}> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_RELAY_API_BASE_URL__: JSON.stringify("https://relay.example.test"),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: {
      middlewareMode: true
    }
  });
  let module: Awaited<ReturnType<typeof loadModelConfigDraftStorageModule>>["module"];
  try {
    module = await server.ssrLoadModule("/src/features/model-aliases/modelConfigDraftStorage.ts") as typeof module;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}
