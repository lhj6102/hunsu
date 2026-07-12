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
      transport: "p2p",
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

test("Connection Center presents the configured Google identity provider", () => {
  const source = readFileSync(join(WEB_ROOT, "src/features/connection/ConnectionCenter.tsx"), "utf8");
  assert.match(source, /Sign in with Google to connect a Remote Bridge\./u);
  assert.doesNotMatch(source, /Sign in through Cloudflare Access/u);
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
            supportsRemoteAccess: true,
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
              supportsRemoteAccess: true,
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
      supportsRemoteAccess: true,
      supportsAcp: false
    },
    recommendedAction: "none",
    ...overrides
  };
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify("https://connect.example.test"),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify("https://connect.example.test"),
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
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify("https://connect.example.test"),
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
