import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type * as AgentTimelineModule from "../apps/web/src/features/inspector/agentTimeline.ts";
import type * as NodeDetailPanelModule from "../apps/web/src/features/inspector/NodeDetailPanel.tsx";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");

test("Node detail log body deduplicates prompt text echoed through content", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    const prompt = [
      "<member>",
      "Act as Ryze.",
      "</member>",
      "",
      "<goal>",
      "Verify the app.",
      "</goal>"
    ].join("\n");
    const body = module.formatAgentMessageBodyForDisplay({
      sessionId: "F0001:path:1:verify",
      messageId: "F0001:path:1:verify:user",
      itemId: "user",
      role: "user",
      type: "userMessage",
      status: "completed",
      title: "Prompt",
      text: prompt,
      content: [prompt.replace(/\n/g, " ")],
      revision: 1,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    }, "fallback");

    assert.equal(body, prompt);
  } finally {
    await close();
  }
});

test("HUNSU DiffArtifact markers ignore prompt placeholders", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    assert.deepEqual(module.parseHunsuDiffMarkers('::hunsu-diff{draftSessionId="<draftSessionId>" diffArtifactId="<diffArtifactId>" status="pass"}'), []);
    assert.deepEqual(module.parseHunsuDiffMarkers('::hunsu-diff{draftSessionId="hd0001" diffArtifactId="hdd_abc123" status="pass"}'), [{
      draftSessionId: "hd0001",
      diffArtifactId: "hdd_abc123",
      status: "pass"
    }]);
  } finally {
    await close();
  }
});

test("HUNSU Draft hides internal provider prompt when the Director message exists", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    const directorMessage = {
      sessionId: "hd0001",
      messageId: "local-user",
      role: "user",
      type: "hunsuDraft.user",
      status: "completed",
      title: "Prompt",
      text: "할일 추가: 한국시간 표시",
      revision: 1,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    } as const;
    const providerPrompt = {
      sessionId: "hd0001",
      messageId: "provider-user",
      role: "user",
      type: "userMessage",
      status: "completed",
      title: "Prompt",
      text: [
        "<role>",
        "You are the HUNSU Draft agent.",
        "</role>",
        "<draft_check_command>",
        "curl -X POST http://127.0.0.1/diff-artifacts",
        "</draft_check_command>",
        '::hunsu-diff{draftSessionId="<draftSessionId>" diffArtifactId="<diffArtifactId>" status="pass"}'
      ].join("\n"),
      revision: 1,
      createdAt: "2026-06-17T00:00:01.000Z",
      updatedAt: "2026-06-17T00:00:01.000Z"
    } as const;
    const messages = [directorMessage, providerPrompt] as any;

    assert.equal(module.isVisibleAgentMessage(providerPrompt as any, messages), false);
    assert.equal(module.isVisibleAgentMessage(directorMessage as any, messages), true);
  } finally {
    await close();
  }
});

test("HUNSU DiffArtifact confirmation is enabled only for the latest passing artifact", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    const artifact = {
      diffArtifactId: "hdd_old",
      draftSessionId: "hd0001",
      status: "pass" as const,
      files: [],
      errors: [],
      checkedAt: "2026-06-17T00:00:00.000Z",
      draftSurfaceHash: "hash-old"
    };

    assert.equal(module.canConfirmHunsuDiffArtifact(artifact, "ready", "hdd_old"), true);
    assert.equal(module.canConfirmHunsuDiffArtifact(artifact, "ready", "hdd_new"), false);
    assert.equal(module.canConfirmHunsuDiffArtifact(artifact, "confirmed", "hdd_old"), false);
  } finally {
    await close();
  }
});

test("HUNSU Draft review uses the latest DiffArtifact before chat markers", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    const draft = {
      draftSessionId: "hd0001",
      latestDiffArtifactId: "hdd_latest",
      diffArtifacts: {
        hdd_latest: { status: "pass" }
      }
    } as any;

    assert.deepEqual(module.hunsuDraftCurrentReviewArtifactRef(draft, [{
      draftSessionId: "hd0001",
      diffArtifactId: "hdd_old",
      status: "pass"
    }]), {
      draftSessionId: "hd0001",
      diffArtifactId: "hdd_latest",
      status: "pass",
      source: "latest"
    });
  } finally {
    await close();
  }
});

test("wrapped runtime diff lines keep diff markers in a gutter", async () => {
  const { module, close } = await loadNodeDetailPanelModule();
  try {
    assert.deepEqual(module.splitRuntimeDiffLine("+      \"id\": \"a-very-long-value-that-should-wrap\""), {
      gutter: "+",
      content: "      \"id\": \"a-very-long-value-that-should-wrap\""
    });
    assert.deepEqual(module.splitRuntimeDiffLine("diff --git a/file b/file"), {
      gutter: "",
      content: "diff --git a/file b/file"
    });
    assert.deepEqual(module.splitWrappedTextLines("first\nsecond"), [
      { lineNumber: 1, text: "first" },
      { lineNumber: 2, text: "second" }
    ]);
  } finally {
    await close();
  }
});

test("Agent timeline projection preserves legacy message detail surfaces", async () => {
  const { module, close } = await loadAgentTimelineModule();
  try {
    const result = module.projectAgentTimeline({
      messages: [{
        id: "m_detail",
        speaker: "Draft Agent",
        title: "Reply",
        text: "Diff ready.",
        status: "Done",
        role: "assistant",
        detail: "DETAIL CARD"
      }]
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.detail, "DETAIL CARD");
  } finally {
    await close();
  }
});

test("Agent timeline projection turns raw AgentSession messages into stable rows", async () => {
  const { module, close } = await loadAgentTimelineModule();
  try {
    const result = module.projectAgentTimeline({
      session: {
        sessionId: "session_001",
        routeRef: { kind: "Route", routeKind: "Path", routeId: "route_001", sourceLineId: "line_001", sourceNodeId: "node_001" },
        owner: { kind: "ExecutionPlan", runId: "run_001", executeId: "execute_001", attempt: 1, pathId: "path_001", executorId: "ryze" },
        state: { type: "failed", error: "Tool failed", completedAt: "2026-06-17T00:00:05.000Z" },
        messages: [
          agentMessage({ messageId: "m_internal", role: "system", type: "system", title: "Runtime", text: "Read .hunsu/state.hunsu" }),
          agentMessage({ messageId: "m_user", role: "user", type: "userMessage", title: "Prompt", text: "Refactor the timeline" }),
          agentMessage({ messageId: "m_reasoning", role: "reasoning", type: "reasoning", title: "Reasoning", text: "Need a projection layer." }),
          agentMessage({ messageId: "m_command", role: "tool", type: "command", title: "Command", command: "pnpm test", output: "ok" }),
          agentMessage({ messageId: "m_change", role: "assistant", type: "fileChange", title: "Files", changes: { files: ["apps/web/src/features/inspector/AgentChat.tsx"] } })
        ],
        activeItemIds: [],
        error: "Tool failed",
        revision: 1,
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:05.000Z"
      }
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.map(row => row.kind), ["UserTurn", "Reasoning", "CommandRun", "FileChange", "Error"]);
    assert.equal(result.value.some(row => row.text?.includes(".hunsu")), false);
  } finally {
    await close();
  }
});

function agentMessage(input: Record<string, unknown> & { messageId: string; role: string; type: string; title: string }) {
  return {
    sessionId: "session_001",
    itemId: input.messageId,
    status: "completed",
    revision: 1,
    createdAt: `2026-06-17T00:00:0${input.messageId === "m_internal" ? "0" : input.messageId === "m_user" ? "1" : input.messageId === "m_reasoning" ? "2" : input.messageId === "m_command" ? "3" : "4"}.000Z`,
    updatedAt: "2026-06-17T00:00:05.000Z",
    ...input
  } as any;
}

async function loadNodeDetailPanelModule(): Promise<{ module: typeof NodeDetailPanelModule; close: () => Promise<void> }> {
  return loadWebModule<typeof NodeDetailPanelModule>("/src/features/inspector/NodeDetailPanel.tsx");
}

async function loadAgentTimelineModule(): Promise<{ module: typeof AgentTimelineModule; close: () => Promise<void> }> {
  return loadWebModule<typeof AgentTimelineModule>("/src/features/inspector/agentTimeline.ts");
}

async function loadWebModule<T>(path: string): Promise<{ module: T; close: () => Promise<void> }> {
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
  let module: T;
  try {
    module = await server.ssrLoadModule(path) as T;
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}
