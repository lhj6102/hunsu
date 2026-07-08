import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BridgeConnectionState } from "../apps/web/src/shared/api/bridgeConnection.ts";
import type { StudioConnectionStatus } from "../apps/web/src/shared/api/bridgeTypes.ts";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");

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
    })), "Project access needed");

    assert.equal(module.connectionCardLabel(onlineConnection({
      projectAccess: "denied"
    })), "Project access denied");

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

    assert.equal(module.connectionCardLabel(onlineConnection({
      mode: "remote",
      transport: "relay",
      compatibility: { compatible: false, reason: "bridge_app_update_needed", message: "Bridge App is too old." },
      warnings: ["version_mismatch"]
    })), "Remote Relay requires newer Bridge App");
  } finally {
    await close();
  }
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
          bridgeAppVersion: "0.1.0",
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

test("Studio Bridge-backed routes render when only a Relay-backed Remote Bridge session is stored", async () => {
  const { module, close } = await loadAppModule();
  try {
    for (const routePath of ["/studio", "/studio/roadmaps/roadmap_123"]) {
      const input = {
        routeNeedsBridge: true,
        hasLocalBridgeSession: false,
        hasRemoteBridgeSession: true,
        bridgeStatus: "offline" as const
      };
      assert.equal(module.shouldRedirectBridgeBackedStudioRoute(input), false, `${routePath} should not redirect to setup`);
      assert.equal(module.shouldRenderBridgeBackedSetup(input), false, `${routePath} should render the Studio route`);
    }
  } finally {
    await close();
  }
});

test("Web Roadmap workspace APIs route through Relay with no local Bridge token", async () => {
  const commands: Array<{ command: string; payload?: Record<string, unknown>; projectPath?: string }> = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const storage = new Map<string, string>([
    ["hunsu.remoteBridgeSession", JSON.stringify({
      deviceId: "device_1",
      projectPath: "/tmp/hunsu-project",
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

    assert.deepEqual(commands.map(command => command.command), [
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
    assert.equal(commands.every(command => command.projectPath === "/tmp/hunsu-project"), true);
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

function onlineConnection(overrides: Partial<StudioConnectionStatus>): BridgeConnectionState {
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
  return {
    status: "online",
    tokenPresent: true,
    connection,
    version: connection.version
  };
}

function remoteCommandBody(command: string): unknown {
  switch (command) {
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

async function loadAppModule(): Promise<{
  module: {
    shouldRedirectBridgeBackedStudioRoute: (input: {
      routeNeedsBridge: boolean;
      hasLocalBridgeSession: boolean;
      hasRemoteBridgeSession: boolean;
      bridgeStatus: "checking" | "online" | "offline";
    }) => boolean;
    shouldRenderBridgeBackedSetup: (input: {
      routeNeedsBridge: boolean;
      hasLocalBridgeSession: boolean;
      hasRemoteBridgeSession: boolean;
      bridgeStatus: "checking" | "online" | "offline";
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
