import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDefaultManagerConfig, emptyBoardProjection, type ArtifactActionDefinition, type BoardProjection } from "../packages/protocol/src/index.ts";
import type * as RoadmapModule from "../apps/web/src/shared/domain/roadmapViewModel.ts";
import type * as StudioDataModule from "../apps/web/src/shared/api/useStudioData.ts";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");

function executeRouteRef(runId: string, executeId: string, routeKind: "Plan" | "Path" = "Plan") {
  return { kind: "Route" as const, routeKind, routeId: executeId, runId, executeId, sourceLineId: "line_main", sourceNodeId: "node_003" };
}

function hunsuDraftRouteRef(draftSessionId: string, sourceLineId = "line_main", sourceNodeId = "node_003") {
  return { kind: "Route" as const, routeKind: "HunsuDraft" as const, routeId: `hunsu-draft:${draftSessionId}`, draftSessionId, sourceLineId, sourceNodeId };
}

test("Roadmap v3 view model preserves the Studio UX selection contract", async () => {
  const { module, close } = await loadRoadmapModule();
  try {
    const activeExecuteModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: module.fallbackRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: module.fallbackArtifactActions("view-model-test-roadmap"),
      actionRuns: []
    });

    assert.equal(activeExecuteModel.selection.selection.kind, "move");
    assert.equal(activeExecuteModel.selection.node?.id, "node_003");
    assert.equal(activeExecuteModel.inspector?.kind, "move");
    assert.equal(activeExecuteModel.selectedNode?.card.hunsuForked, true);
    assert.equal(activeExecuteModel.graph.inlineExecutes.length, 1);
    assert.equal(activeExecuteModel.graph.inlineExecutes[0]?.overlay.points.some(point => point.pathId === "compose"), true);
    assert.equal(activeExecuteModel.graph.playableMoves.length, 0);
    if (activeExecuteModel.inspector?.kind !== "move") {
      throw new Error("Expected fallback selection to resolve to a MOVE inspector");
    }
    assert.equal("run" in activeExecuteModel.inspector, false);

    const executeModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: module.fallbackRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    assert.equal(executeModel.inspector?.kind, "execute");
    assert.equal(executeModel.graph.selectedExecuteId, "execute_handoff");
    assert.equal(executeModel.selection.point, undefined);
    assert.equal(executeModel.selection.planScope?.id, "execute_handoff:plan-scope");
    assert.equal(executeModel.graph.selectedPlanScopeId, "execute_handoff:plan-scope");
    assert.equal(executeModel.graph.selectedPathPointId, undefined);
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.points.some(point => point.kind === "path"), true);
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.points.some(point => point.id === "execute_handoff:plan"), false);
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.edges.some(edge => edge.kind === "path"), true);
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.planScope.width, 34);
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.edges[0]?.toId, "execute_handoff:plan-scope");
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.edges[1]?.fromId, "execute_handoff:plan-scope");
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.edges[1]?.toId, "execute_handoff:design");
    assert.equal(
      (executeModel.graph.inlineExecutes[0]?.overlay.points[0]?.x ?? 0) > (executeModel.graph.inlineExecutes[0]?.overlay.planScope.x ?? 0) + 34,
      true
    );
    assert.equal(executeModel.graph.inlineExecutes[0]?.overlay.points.at(-1)?.kind, "target");
    const executeOverlayBottom = executeModel.graph.inlineExecutes[0]?.overlay.points.reduce((bottom, point) => Math.max(bottom, point.y + 48), 0) ?? 0;
    assert.equal((executeModel.graph.detailPosition?.y ?? 0) > executeOverlayBottom, true);

    const pathModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: module.fallbackRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" },
      panel: "path"
    });
    assert.equal(pathModel.inspector?.kind, "pathPoint");
    assert.deepEqual(pathModel.selection.selection, { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" });
    assert.equal(pathModel.graph.selectedPathPointId, "execute_handoff:compose");
    if (pathModel.inspector?.kind === "pathPoint") {
      assert.deepEqual(pathModel.inspector.dependencies, ["design (a11ce0000)", "model (b10c0000)"]);
    }

    const transitionRuns = structuredClone(module.fallbackRuns);
    transitionRuns[0].planExecutionTransition = {
      path: ".hunsu/current-execution.hunsu",
      previousCommit: "f00dbabe",
      previousState: "none",
      nextState: "present",
      nextCommit: "plan000001"
    };
    transitionRuns[0].memberPathRuns![0]!.currentExecutionTransition = {
      path: ".hunsu/current-execution.hunsu",
      previousCommit: "plan000001",
      previousState: "present",
      nextState: "present",
      nextCommit: "a11ce0000"
    };
    transitionRuns[0].memberPathRuns![2]!.currentExecutionTransition = {
      path: ".hunsu/current-execution.hunsu",
      previousCommit: "b10c0000",
      previousState: "present",
      nextState: "pending"
    };
    const transitionExecuteModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: transitionRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    assert.equal(transitionExecuteModel.inspector?.kind, "execute");
    if (transitionExecuteModel.inspector?.kind === "execute") {
      assert.equal(transitionExecuteModel.inspector.planExecutionTransition?.nextCommit, "plan000001");
    }
    const transitionPathModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: transitionRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "design" },
      panel: "path"
    });
    assert.equal(transitionPathModel.inspector?.kind, "pathPoint");
    if (transitionPathModel.inspector?.kind === "pathPoint") {
      assert.equal(transitionPathModel.inspector.pathRun?.currentExecutionTransition?.previousCommit, "plan000001");
    }
    const pendingPathModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: transitionRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" },
      panel: "path"
    });
    assert.equal(pendingPathModel.inspector?.kind, "pathPoint");
    if (pendingPathModel.inspector?.kind === "pathPoint") {
      assert.equal(pendingPathModel.inspector.pathRun?.currentExecutionTransition?.nextState, "pending");
    }

    const duplicateRunModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: [
        module.fallbackRuns[0],
        {
          ...structuredClone(module.fallbackRuns[0]),
          runId: "run_handoff_rehydrated",
          source: "rehydrated",
          updatedAt: "2026-06-16T00:00:00.000Z"
        }
      ],
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    assert.equal(duplicateRunModel.graph.inlineExecutes.length, 1);
    assert.deepEqual(duplicateRunModel.graph.inlineExecutes.map(execute => execute.overlay.planScope.id), ["execute_handoff:plan-scope"]);

    const plannedRuns = structuredClone(module.fallbackRuns);
    plannedRuns[0].memberPathRuns = [];
    const plannedModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: plannedRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    const plannedPathIds = plannedModel.graph.inlineExecutes[0]?.overlay.points
      .filter(point => point.kind === "path")
      .map(point => point.pathId);
    assert.deepEqual(plannedPathIds, ["design", "model", "compose"]);

    const planningRuns = structuredClone(module.fallbackRuns);
    planningRuns[0].status = "running";
    planningRuns[0].executionPlanPlan = [];
    planningRuns[0].memberPathRuns = [];
    planningRuns[0].liveStatus = {
      phase: "thinking",
      headline: "Planning Member Paths",
      detail: "Team is preparing ExecutionPlan.",
      providerTurnId: "turn-plan",
      updatedAt: new Date().toISOString()
    };
    delete planningRuns[0].codexItems;
    delete planningRuns[0].assistantTranscript;
    const planningSession = {
      sessionId: "execute_handoff:plan:1",
      runId: planningRuns[0].runId,
      executeId: planningRuns[0].executeId,
      routeRef: executeRouteRef(planningRuns[0].runId, planningRuns[0].executeId, "Plan"),
      owner: { kind: "TeamPlan" as const, runId: planningRuns[0].runId, executeId: planningRuns[0].executeId, attempt: 1 },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, activeItemIds: ["plan-log"] },
      provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" },
      messages: [{
        sessionId: "execute_handoff:plan:1",
        messageId: "execute_handoff:plan:1:plan-log",
        itemId: "plan-log",
        role: "assistant" as const,
        type: "plan",
        status: "streaming" as const,
        title: "Planning",
        text: "Plan words are visible before completion",
        revision: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }],
      activeItemIds: ["plan-log"],
      revision: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const planningModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: planningRuns,
      agentSessions: [planningSession],
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    const planningOverlay = planningModel.graph.inlineExecutes[0]?.overlay;
    assert.equal(planningOverlay?.planScope.cssState, "running");
    assert.equal(planningOverlay?.planScope.isStreaming, true);
    assert.equal(planningOverlay?.planScope.width, 34);
    assert.equal(planningOverlay?.points.some(point => point.kind === "path"), false);
    assert.deepEqual(planningOverlay?.points.map(point => point.kind), ["target"]);
    assert.equal(planningOverlay?.edges[0]?.toId, "execute_handoff:plan-scope");
    assert.equal(planningOverlay?.edges[1]?.fromId, "execute_handoff:plan-scope");
    assert.equal(planningOverlay?.edges[1]?.toId, "execute_handoff:target");
    assert.equal(planningModel.inspector?.kind, "execute");
    if (planningModel.inspector?.kind === "execute") {
      assert.equal(planningModel.inspector.planSession?.session.messages[0]?.text, "Plan words are visible before completion");
      assert.equal(planningModel.inspector.planSession?.session.messages[0]?.status, "streaming");
    }

	    const planCompletedRuns = structuredClone(module.fallbackRuns);
	    planCompletedRuns[0].status = "running";
	    const completedPlanSession = {
	      sessionId: "execute_handoff:plan:1",
	      runId: planCompletedRuns[0].runId,
	      executeId: planCompletedRuns[0].executeId,
	      routeRef: executeRouteRef(planCompletedRuns[0].runId, planCompletedRuns[0].executeId, "Plan"),
	      owner: { kind: "TeamPlan" as const, runId: planCompletedRuns[0].runId, executeId: planCompletedRuns[0].executeId, attempt: 1 },
	      state: { type: "completed" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, finalResponse: "[]", completedAt: new Date().toISOString() },
	      provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" },
	      messages: [],
	      activeItemIds: [],
	      finalResponse: "[]",
	      revision: 3,
	      createdAt: new Date().toISOString(),
	      updatedAt: new Date().toISOString()
	    };
	    const planCompletedModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: planCompletedRuns,
	      agentSessions: [completedPlanSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
      actionRuns: [],
	      selection: { kind: "execute", executeId: "execute_handoff" },
	      panel: "execute"
	    });
	    assert.equal(planCompletedModel.graph.inlineExecutes[0]?.overlay.planScope.cssState, "done");
	    assert.equal(planCompletedModel.inspector?.kind, "execute");
	    if (planCompletedModel.inspector?.kind === "execute") {
	      assert.equal(planCompletedModel.inspector.planSession?.status, "done");
	      assert.deepEqual(planCompletedModel.inspector.activeAgentSession, { kind: "TeamPlan", sessionId: "execute_handoff:plan:1", mode: "snapshot" });
	    }

	    const staleRunningPlanSession = {
	      ...completedPlanSession,
	      state: { type: "executing" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, activeItemIds: ["stale-plan-item"] },
	      activeItemIds: ["stale-plan-item"],
	      finalResponse: undefined,
	      revision: 2
	    };
	    const staleRunningPlanModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: planCompletedRuns,
	      agentSessions: [staleRunningPlanSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
      actionRuns: [],
	      selection: { kind: "execute", executeId: "execute_handoff" },
	      panel: "execute"
	    });
	    assert.equal(staleRunningPlanModel.graph.inlineExecutes[0]?.overlay.planScope.cssState, "done");
	    assert.equal(staleRunningPlanModel.graph.inlineExecutes[0]?.overlay.planScope.isStreaming, false);
	    assert.equal(staleRunningPlanModel.inspector?.kind, "execute");
	    if (staleRunningPlanModel.inspector?.kind === "execute") {
	      assert.equal(staleRunningPlanModel.inspector.planSession?.status, "done");
	      assert.deepEqual(staleRunningPlanModel.inspector.activeAgentSession, { kind: "TeamPlan", sessionId: "execute_handoff:plan:1", mode: "snapshot" });
	    }
	
	    const completedRuns = structuredClone(module.fallbackRuns);
    completedRuns[0] = {
      ...completedRuns[0],
      runId: "run_completed",
      executeId: "execute_completed",
      status: "arrived",
      sourceNodeId: "node_001",
      sourceMoveId: "move_001",
      targetMoveOrdinal: 2,
      memberPathRuns: completedRuns[0].memberPathRuns?.map((path, index) => ({
        ...path,
        status: "completed",
        session: "session" in path && path.session ? path.session : { providerThreadId: `thread-completed-${index}`, providerTurnId: `turn-completed-${index}` },
        finalResponse: "finalResponse" in path && path.finalResponse ? path.finalResponse : `${path.pathId} complete`,
        commit: "commit" in path ? path.commit ?? `c0ffee0${index}` : `c0ffee0${index}`,
        completedAt: "completedAt" in path ? path.completedAt : new Date().toISOString()
      }))
    };
    const foldedModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: completedRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: []
    });
    const foldedConnection = foldedModel.graph.connections.find(connection => connection.display.executeId === "execute_completed");
    assert.equal(foldedConnection?.display.connectDisplayType, "Fold");
    assert.equal(foldedConnection?.display.canToggle, true);
    assert.equal(foldedModel.graph.inlineExecutes.some(execute => execute.id === "execute_completed"), false);
    const foldedSource = foldedModel.graph.nodes.find(node => node.id === "node_001");
    const foldedTarget = foldedModel.graph.nodes.find(node => node.id === "node_002");
    assert.equal(Math.round((foldedTarget?.x ?? 0) - (foldedSource?.x ?? 0)), 260);

    const expandedModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: completedRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      expandedConnectionIds: ["execute_completed"]
    });
    const expandedConnection = expandedModel.graph.connections.find(connection => connection.display.executeId === "execute_completed");
    const expandedExecute = expandedModel.graph.inlineExecutes.find(execute => execute.id === "execute_completed");
    const expandedSource = expandedModel.graph.nodes.find(node => node.id === "node_001");
    const expandedTarget = expandedModel.graph.nodes.find(node => node.id === "node_002");
    assert.equal(expandedConnection?.display.connectDisplayType, "Expand");
    assert.equal(Boolean(expandedExecute), true);
    assert.equal(((expandedTarget?.x ?? 0) - (expandedSource?.x ?? 0)) > 260, true);
    assert.equal((expandedExecute?.overlay.planScope.x ?? 0) - ((expandedSource?.x ?? 0) + 151.2) <= 56, true);
    assert.equal(expandedExecute?.overlay.planScope.width, 34);
    assert.equal(Math.round((expandedExecute?.overlay.planScope.y ?? 0) - ((expandedSource?.y ?? 0) + 104.4 / 2 - 17)), 0);
    assert.equal((expandedExecute?.overlay.points[0]?.x ?? 0) > (expandedExecute?.overlay.planScope.x ?? 0) + 34, true);
    assert.equal(expandedExecute?.overlay.points.some(point => point.kind === "target"), false);
    assert.equal(expandedExecute?.overlay.edges.at(-1)?.toId, "node_002");
    assert.deepEqual(expandedExecute?.overlay.edges.at(-1)?.to, {
      x: expandedTarget?.x,
      y: (expandedTarget?.y ?? 0) + 104.4 / 2
    });

    const streamingRuns = structuredClone(module.fallbackRuns);
    if (!streamingRuns[0].liveStatus) {
      throw new Error("Expected fallback run to expose liveStatus");
    }
    streamingRuns[0].liveStatus = {
      ...streamingRuns[0].liveStatus,
      providerTurnId: "turn-compose"
    };
    delete streamingRuns[0].codexItems;
    delete streamingRuns[0].assistantTranscript;
    const streamingPathModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: streamingRuns,
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" },
      panel: "path"
    });
    assert.equal(streamingPathModel.inspector?.kind, "pathPoint");
    if (streamingPathModel.inspector?.kind !== "pathPoint") {
      throw new Error("Expected Path inspector for streaming session regression");
    }
    assert.equal(streamingPathModel.inspector.executionSession?.providerTurnId, "turn-compose");
    assert.equal(streamingPathModel.inspector.executionSession?.providerThreadId, "thread-compose");
    assert.equal(streamingPathModel.inspector.executionSession?.session.messages.length, 0);
    assert.equal(streamingPathModel.inspector.activeAgentSession, undefined);

    const canonicalPathSession = {
      sessionId: "execute_handoff:path:1:compose",
      runId: streamingRuns[0].runId,
      executeId: streamingRuns[0].executeId,
      routeRef: executeRouteRef(streamingRuns[0].runId, streamingRuns[0].executeId, "Path"),
      owner: { kind: "ExecutionPlan" as const, runId: streamingRuns[0].runId, executeId: streamingRuns[0].executeId, attempt: 1, pathId: "compose", executorId: "ruler" },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" }, activeItemIds: [] },
      provider: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" },
      messages: [{
        sessionId: "execute_handoff:path:1:compose",
        messageId: "execute_handoff:path:1:compose:compose-log",
        itemId: "compose-log",
        role: "assistant" as const,
        type: "agentMessage",
        status: "streaming" as const,
        title: "Compose path",
        text: "Path words are visible before completion",
        revision: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }],
      activeItemIds: ["compose-log"],
      revision: 4,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const canonicalPathModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: module.fallbackBoard,
      runs: streamingRuns,
      agentSessions: [canonicalPathSession],
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" },
      panel: "path"
    });
    assert.equal(canonicalPathModel.inspector?.kind, "pathPoint");
    if (canonicalPathModel.inspector?.kind === "pathPoint") {
      assert.deepEqual(canonicalPathModel.inspector.activeAgentSession, { kind: "ExecutionPlan", sessionId: "execute_handoff:path:1:compose", mode: "stream" });
      assert.equal(canonicalPathModel.inspector.executionSession?.session.messages[0]?.text, "Path words are visible before completion");
      assert.equal(canonicalPathModel.inspector.executionSession?.session.messages[0]?.status, "streaming");
    }

	    const hunsuModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "move", nodeId: "node_003" },
      panel: "hunsu"
	    });
	    assert.equal(hunsuModel.inspector?.kind, "hunsu");

	    const typecheckArtifactAction = {
	      id: "typecheck",
	      title: "Typecheck",
	      kind: "check",
	      sourceScope: "move-or-commit",
	      runner: { type: "command", command: "pnpm run typecheck" },
	      displayOrder: 0
	    } as unknown as ArtifactActionDefinition;
	    const changedArtifactActionsFile = {
	      path: ".hunsu-request/artifact-actions.json",
	      kind: "updated" as const,
	      summary: "Artifact Actions 1 added.",
	      diff: "diff --git a/.hunsu-prev/artifact-actions.json b/.hunsu-request/artifact-actions.json\n@@ -1,4 +1,12 @@\n+    \"id\": \"typecheck\""
	    };
	    const draftSession = {
	      draftSessionId: "draft_0001",
	      roadmapId: "view-model-test-roadmap",
	      repositoryPath: "/repo",
	      sourceLineId: "line_main",
	      sourceNodeId: "node_003",
	      sourceMoveId: "move_003",
	      routeId: "hunsu-draft:draft_0001",
	      agentSessionIds: ["hunsu-draft:draft_0001:draft"],
	      activeAgentSessionId: "hunsu-draft:draft_0001:draft",
	      draftAgentSessionId: "hunsu-draft:draft_0001:draft",
	      sourceArtifactId: "hda_source",
	      currentArtifactId: "hda_source",
	      manager: createDefaultManagerConfig(),
	      messages: [{
	        messageId: "draft_0001:msg:0001",
	        role: "user" as const,
	        text: "현재 MOVE를 복제하는 HUNSU를 만들어줘",
	        createdAt: "2026-06-16T00:00:00.000Z"
	      }],
	      readyDraft: {
	        id: "draft_0001",
	        status: "ready",
	        sourceLineId: "line_main",
	        sourceNodeId: "node_003",
	        sourceMoveId: "move_003",
	        target: { type: "node" as const, id: "node_003" },
	        newTeamName: "Faker",
	        summary: "Artifact Actions 1 added.",
	        teamSnapshot: {
	          teamName: "Faker",
	          moveOrdinal: 3,
	          destinations: [],
	          harness: {
	            kind: "team_execution_plan" as const,
	            maxAttemptCount: 1,
	            team: { promptTemplate: "Execute." },
	            members: []
	          },
	          artifactActions: [typecheckArtifactAction]
	        },
	        changedFiles: [changedArtifactActionsFile],
	        hunsuId: "H0002",
	        newLineId: "line_main/fork-H0002",
	        conversationRef: {
	          provider: "codex" as const,
	          conversationHash: "conversation_hash",
	          contextHash: "context_hash",
	          startedAt: "2026-06-16T00:00:00.000Z",
	          endedAt: "2026-06-16T00:00:01.000Z"
	        },
	        createdAt: "2026-06-16T00:00:00.000Z",
	        updatedAt: "2026-06-16T00:00:01.000Z"
	      },
	      latestDiffArtifactId: "hdd_ready",
	      diffArtifacts: {
	        hdd_ready: {
	          diffArtifactId: "hdd_ready",
	          draftSessionId: "draft_0001",
	          status: "pass" as const,
	          summary: "Artifact Actions 1 added.",
	          errors: [],
	          files: [changedArtifactActionsFile],
	          checkedAt: "2026-06-16T00:00:01.000Z",
	          draftSurfaceHash: "hash_ready"
	        }
	      },
	      status: "ready" as const,
	      createdAt: "2026-06-16T00:00:00.000Z",
	      updatedAt: "2026-06-16T00:00:01.000Z"
	    };
	    const draftAgentSession = {
	      sessionId: "hunsu-draft:draft_0001:draft",
	      roadmapId: "view-model-test-roadmap",
	      routeRef: hunsuDraftRouteRef("draft_0001"),
	      owner: { kind: "HunsuDraft" as const, draftSessionId: "draft_0001" },
	      state: { type: "waiting" as const, reason: "Waiting for approval" },
	      messages: [{
	        sessionId: "hunsu-draft:draft_0001:draft",
	        messageId: "draft_0001:msg:0001",
	        itemId: "draft_0001:msg:0001",
	        role: "user" as const,
	        type: "hunsuDraft.user",
	        status: "completed" as const,
	        title: "Prompt",
	        text: "현재 MOVE를 복제하는 HUNSU를 만들어줘",
	        revision: 1,
	        createdAt: "2026-06-16T00:00:00.000Z",
	        updatedAt: "2026-06-16T00:00:00.000Z",
	        completedAt: "2026-06-16T00:00:00.000Z"
	      }],
	      activeItemIds: [],
	      revision: 2,
	      createdAt: "2026-06-16T00:00:00.000Z",
	      updatedAt: "2026-06-16T00:00:01.000Z"
	    };
	    const draftMoveModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
	      agentSessions: [draftAgentSession],
	      hunsuDrafts: [draftSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
      actionRuns: [],
	      selection: { kind: "move", nodeId: "node_003" },
	      panel: "move"
	    });
	    assert.equal(draftMoveModel.graph.routeNodes.some(route => route.kind === "hunsuDraft" && route.draftSessionId === "draft_0001"), true);
	    const readyDraftRoute = draftMoveModel.graph.routeNodes.find(route => route.kind === "hunsuDraft" && route.draftSessionId === "draft_0001");
	    assert.equal(readyDraftRoute?.width, 34);
	    assert.equal(readyDraftRoute?.height, 34);
	    assert.equal(draftMoveModel.inspector?.kind, "move");
	    assert.equal("draft" in (draftMoveModel.inspector ?? {}), false);

	    const secondDraftSession = {
	      ...draftSession,
	      draftSessionId: "draft_0002",
	      routeId: "hunsu-draft:draft_0002",
	      agentSessionIds: ["hunsu-draft:draft_0002:draft"],
	      activeAgentSessionId: "hunsu-draft:draft_0002:draft",
	      draftAgentSessionId: "hunsu-draft:draft_0002:draft",
	      readyDraft: {
	        ...draftSession.readyDraft,
	        id: "draft_0002",
	        hunsuId: "H0003",
	        newLineId: "line_main/fork-H0003"
	      },
	      latestDiffArtifactId: "hdd_ready_2",
	      diffArtifacts: {
	        hdd_ready_2: {
	          ...draftSession.diffArtifacts.hdd_ready,
	          diffArtifactId: "hdd_ready_2",
	          draftSessionId: "draft_0002",
	          draftSurfaceHash: "hash_ready_2"
	        }
	      },
	      createdAt: "2026-06-16T00:00:02.000Z",
	      updatedAt: "2026-06-16T00:00:03.000Z"
	    };
	    const multiDraftModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
	      hunsuDrafts: [draftSession, secondDraftSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
	      actionRuns: [],
	      selection: { kind: "move", nodeId: "node_003" },
	      panel: "move"
	    });
	    const siblingDraftRoutes = multiDraftModel.graph.routeNodes
	      .flatMap(route => route.kind === "hunsuDraft" && route.sourceNodeId === "node_003" ? [route] : [])
	      .sort((left, right) => left.draftSessionId.localeCompare(right.draftSessionId));
	    assert.equal(siblingDraftRoutes.length, 2);
	    assert.notEqual(siblingDraftRoutes[0]?.y, siblingDraftRoutes[1]?.y);
	    assert.equal(siblingDraftRoutes[0]?.x, siblingDraftRoutes[1]?.x);
	    assert.equal((siblingDraftRoutes[0]?.x ?? 0) + (siblingDraftRoutes[0]?.width ?? 0) / 2 < (siblingDraftRoutes[0]?.sourceAnchor.x ?? 0), true);
	    assert.equal((siblingDraftRoutes[1]?.y ?? 0) > (siblingDraftRoutes[0]?.y ?? 0) + (siblingDraftRoutes[0]?.height ?? 0), true);

	    const draftFromNodeWithExistingHunsu = {
	      ...draftSession,
	      draftSessionId: "draft_from_node_001",
	      sourceNodeId: "node_001",
	      sourceMoveId: "move_001",
	      routeId: "hunsu-draft:draft_from_node_001",
	      readyDraft: {
	        ...draftSession.readyDraft,
	        id: "draft_from_node_001",
	        sourceNodeId: "node_001",
	        sourceMoveId: "move_001",
	        hunsuId: "H0004",
	        newLineId: "line_main/fork-H0004"
	      },
	      latestDiffArtifactId: "hdd_ready_3",
	      diffArtifacts: {
	        hdd_ready_3: {
	          ...draftSession.diffArtifacts.hdd_ready,
	          diffArtifactId: "hdd_ready_3",
	          draftSessionId: "draft_from_node_001",
	          draftSurfaceHash: "hash_ready_3"
	        }
	      }
	    };
	    const draftAvoidsExistingMoveModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
	      hunsuDrafts: [draftFromNodeWithExistingHunsu],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
	      actionRuns: [],
	      selection: { kind: "move", nodeId: "node_001" },
	      panel: "move"
	    });
	    const routeAvoidingExistingMove = draftAvoidsExistingMoveModel.graph.routeNodes.find(route => route.kind === "hunsuDraft" && route.draftSessionId === "draft_from_node_001");
	    const existingHunsuMove = draftAvoidsExistingMoveModel.graph.nodes.find(node => node.id === "node_003");
	    assert.equal(routeAvoidingExistingMove?.kind, "hunsuDraft");
	    assert.equal(Boolean(routeAvoidingExistingMove?.targetAnchor), true);
	    assert.equal((routeAvoidingExistingMove?.x ?? 0) + (routeAvoidingExistingMove?.width ?? 0) / 2 < (routeAvoidingExistingMove?.sourceAnchor.x ?? 0), true);
	    assert.equal((routeAvoidingExistingMove?.y ?? 0) > (existingHunsuMove?.y ?? 0) + 104.4, true);

	    const draftRouteModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
	      agentSessions: [draftAgentSession],
	      hunsuDrafts: [draftSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
      actionRuns: [],
	      selection: { kind: "hunsuDraftRoute", draftSessionId: "draft_0001" },
	      panel: "hunsu"
	    });
	    assert.equal(draftRouteModel.selection.selection.kind, "hunsuDraftRoute");
	    assert.equal(draftRouteModel.graph.selectedRouteNodeId, "hunsu-draft:draft_0001");
	    assert.equal(draftRouteModel.graph.routeNodes.find(route => route.kind === "hunsuDraft" && route.draftSessionId === "draft_0001")?.label, "HUNSU Draft");
	    assert.equal(draftRouteModel.inspector?.kind, "hunsuDraftRoute");
	    if (draftRouteModel.inspector?.kind === "hunsuDraftRoute") {
	      assert.equal(draftRouteModel.inspector.route.kind, "hunsuDraft");
	      assert.equal(draftRouteModel.inspector.route.label, "HUNSU Draft");
	      assert.deepEqual(draftRouteModel.inspector.activeAgentSession, { kind: "HunsuDraft", sessionId: "hunsu-draft:draft_0001:draft", mode: "snapshot" });
	    }

	    const confirmedDraftSession = {
	      ...draftSession,
	      draftSessionId: "draft_confirmed",
	      sourceNodeId: "node_001",
	      sourceMoveId: "move_001",
	      routeId: "hunsu-draft:draft_confirmed",
	      agentSessionIds: ["hunsu-draft:draft_confirmed:draft"],
	      activeAgentSessionId: "hunsu-draft:draft_confirmed:draft",
	      draftAgentSessionId: "hunsu-draft:draft_confirmed:draft",
	      confirmedHunsuId: "hunsu_001",
	      confirmedNodeId: "node_003",
	      status: "confirmed" as const,
	      updatedAt: "2026-06-16T00:00:02.000Z"
	    };
	    const confirmedDraftModel = module.buildRoadmapViewModel({
	      roadmapId: "view-model-test-roadmap",
	      board: module.fallbackBoard,
	      runs: [],
	      hunsuDrafts: [confirmedDraftSession],
	      skills: module.fallbackSkills,
	      worktree: module.fallbackWorktree,
	      artifactActions: [],
      actionRuns: [],
	      selection: { kind: "hunsuDraftRoute", draftSessionId: "draft_confirmed" },
	      panel: "hunsu"
	    });
	    const confirmedRoute = confirmedDraftModel.graph.routeNodes.find(route => route.kind === "hunsuDraft" && route.draftSessionId === "draft_confirmed");
	    assert.equal(confirmedRoute?.kind, "hunsuDraft");
	    if (confirmedRoute?.kind === "hunsuDraft") {
	      assert.equal(confirmedRoute.status, "confirmed");
	      assert.equal(confirmedRoute.targetNode?.id, "node_003");
	      assert.deepEqual(confirmedRoute.targetAnchor, {
	        x: (confirmedRoute.targetNode?.x ?? 0) + 151.2 / 2,
	        y: confirmedRoute.targetNode?.y
	      });
	    }
	    assert.equal(confirmedDraftModel.graph.edges.some(edge => edge.id === "hunsu_001"), false);
	    assert.equal(confirmedDraftModel.inspector?.kind, "hunsuDraftRoute");

	    const playableBoard = boardWithPlayableCurrentMove(module.fallbackBoard);
    const playableModel = module.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: playableBoard,
      runs: [],
      skills: module.fallbackSkills,
      worktree: module.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "move", nodeId: "node_003" },
      panel: "move"
    });
    assert.deepEqual(playableModel.graph.playableMoves.map(item => item.nodeId), ["node_003"]);
    assert.deepEqual(playableModel.graph.playableMoves.map(item => item.action.destinationIds), [["destination_003"]]);
    assert.deepEqual(playableModel.graph.playableMoves.map(item => item.action.destinationLabels), [["Project active Execute ExecutionPlan"]]);
    assert.equal(playableModel.actions.canStartExecute, true);
    assert.deepEqual(playableModel.actions.destinationIds, ["destination_003"]);
    assert.equal(playableModel.inspector?.kind, "move");
    assert.equal(playableModel.inspector?.action.canStartExecute, true);
    assert.deepEqual(playableModel.inspector?.action.destinationIds, ["destination_003"]);

    const emptyModel = module.buildRoadmapViewModel({
      roadmapId: "new-roadmap",
      board: emptyBoardProjection(),
      runs: [],
      skills: [],
      artifactActions: [],
      actionRuns: []
    });
    assert.equal(emptyModel.graph.nodes.length, 0);
    assert.equal(emptyModel.graph.inlineExecutes.length, 0);
    assert.equal(emptyModel.selection.selection.kind, "none");
    assert.equal(emptyModel.inspector, undefined);
    assert.equal(emptyModel.selectedNode, undefined);
    assert.equal(emptyModel.currentTeam, "No Team");
    assert.equal(emptyModel.currentMoveLabel, "No MOVE");
  } finally {
    await close();
  }
});

test("AgentSession React Query cache applies streaming deltas by revision", async () => {
  const { module, close } = await loadStudioDataModule();
  try {
    const session = {
      sessionId: "execute_001:plan:1",
      runId: "run_001",
      executeId: "execute_001",
      routeRef: executeRouteRef("run_001", "execute_001", "Plan"),
      owner: { kind: "TeamPlan" as const, runId: "run_001", executeId: "execute_001", attempt: 1 },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, activeItemIds: [] },
      provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" },
      messages: [],
      activeItemIds: [],
      revision: 1,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    };
    const cache = module.applyAgentSessionEventToCache({ ids: [session.sessionId], byId: { [session.sessionId]: session } }, {
      type: "agentMessage.delta",
      sessionId: session.sessionId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: `${session.sessionId}:msg_001`,
      itemId: "msg_001",
      role: "assistant",
      messageType: "agentMessage",
      title: "Assistant",
      field: "text",
      delta: "Hello",
      messageRevision: 2,
      sessionRevision: 2,
      createdAt: "2026-06-16T00:00:00.500Z",
      updatedAt: "2026-06-16T00:00:01.000Z"
    });
    const duplicate = module.applyAgentSessionEventToCache(cache, {
      type: "agentMessage.delta",
      sessionId: session.sessionId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: `${session.sessionId}:msg_001`,
      itemId: "msg_001",
      role: "assistant",
      messageType: "agentMessage",
      title: "Assistant",
      field: "text",
      delta: " DUP",
      messageRevision: 2,
      sessionRevision: 2,
      createdAt: "2026-06-16T00:00:00.500Z",
      updatedAt: "2026-06-16T00:00:02.000Z"
    });
    const completed = module.applyAgentSessionEventToCache(cache, {
      type: "agentMessage.completed",
      sessionId: session.sessionId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: `${session.sessionId}:msg_001`,
      itemId: "msg_001",
      role: "assistant",
      messageType: "agentMessage",
      title: "Assistant",
      status: "completed",
      messageRevision: 3,
      sessionRevision: 3,
      createdAt: "2026-06-16T00:00:00.500Z",
      completedAt: "2026-06-16T00:00:03.000Z",
      durationMs: 2500,
      updatedAt: "2026-06-16T00:00:03.000Z"
    });
    assert.equal(cache.byId[session.sessionId].messages[0].text, "Hello");
    assert.equal(cache.byId[session.sessionId].messages[0].role, "assistant");
    assert.equal(cache.byId[session.sessionId].messages[0].createdAt, "2026-06-16T00:00:00.500Z");
    assert.equal(duplicate.byId[session.sessionId].messages[0].text, "Hello");
    assert.equal(completed.byId[session.sessionId].messages[0].text, "Hello");
    assert.equal(completed.byId[session.sessionId].messages[0].status, "completed");
    assert.equal(completed.byId[session.sessionId].messages[0].durationMs, 2500);
    const completedWithZeroDuration = module.applyAgentSessionEventToCache({ ids: [session.sessionId], byId: { [session.sessionId]: session } }, {
      type: "agentMessage.completed",
      sessionId: session.sessionId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: `${session.sessionId}:msg_zero`,
      itemId: "msg_zero",
      role: "assistant",
      messageType: "agentMessage",
      title: "Assistant",
      status: "completed",
      messageRevision: 2,
      sessionRevision: 2,
      createdAt: "2026-06-16T00:00:01.000Z",
      completedAt: "2026-06-16T00:00:04.000Z",
      durationMs: 0,
      updatedAt: "2026-06-16T00:00:04.000Z"
    });
    assert.equal(completedWithZeroDuration.byId[session.sessionId].messages[0].durationMs, 3000);
  } finally {
    await close();
  }
});

test("AgentChat duration formatting keeps subsecond completed work visible", async () => {
  const { module, close } = await loadAgentChatModule();
  try {
    assert.equal(module.formatDurationMs(0), "<1s");
    assert.equal(module.formatDurationMs(450), "<1s");
    assert.equal(module.formatDurationMs(1_000), "1s");
  } finally {
    await close();
  }
});

test("AgentSession React Query cache preserves reasoning delta identity", async () => {
  const { module, close } = await loadStudioDataModule();
  try {
    const session = {
      sessionId: "execute_001:plan:1",
      runId: "run_001",
      executeId: "execute_001",
      routeRef: executeRouteRef("run_001", "execute_001", "Plan"),
      owner: { kind: "TeamPlan" as const, runId: "run_001", executeId: "execute_001", attempt: 1 },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, activeItemIds: [] },
      provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" },
      messages: [],
      activeItemIds: [],
      revision: 1,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    };
    const cache = module.applyAgentSessionEventToCache({ ids: [session.sessionId], byId: { [session.sessionId]: session } }, {
      type: "agentMessage.delta",
      sessionId: session.sessionId,
      routeRef: session.routeRef,
      runId: session.runId,
      executeId: session.executeId,
      messageId: `${session.sessionId}:reasoning_001`,
      itemId: "reasoning_001",
      role: "reasoning",
      messageType: "reasoning",
      title: "Reasoning",
      field: "summary",
      delta: "Checking the route",
      messageRevision: 2,
      sessionRevision: 2,
      createdAt: "2026-06-16T00:00:01.000Z",
      updatedAt: "2026-06-16T00:00:02.000Z"
    });

    const message = cache.byId[session.sessionId].messages[0];
    assert.equal(message.role, "reasoning");
    assert.equal(message.type, "reasoning");
    assert.equal(message.title, "Reasoning");
    assert.deepEqual(message.summary, ["Checking the route"]);
    assert.equal(message.createdAt, "2026-06-16T00:00:01.000Z");
  } finally {
    await close();
  }
});

test("AgentSession cache keeps streaming detail text when run snapshots contain stale messages", async () => {
  const { module: dataModule, close: closeData } = await loadStudioDataModule();
  const { module: roadmapModule, close: closeRoadmap } = await loadRoadmapModule();
  try {
    const planSessionId = "execute_handoff:plan:1";
    const planLiveSession = {
      sessionId: planSessionId,
      runId: "run_handoff",
      executeId: "execute_handoff",
      routeRef: executeRouteRef("run_handoff", "execute_handoff", "Plan"),
      owner: { kind: "TeamPlan" as const, runId: "run_handoff", executeId: "execute_handoff", attempt: 1 },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" }, activeItemIds: ["plan-msg"] },
      provider: { providerThreadId: "thread-plan", providerTurnId: "turn-plan" },
      messages: [{
        sessionId: planSessionId,
        messageId: "plan-msg",
        itemId: "plan-msg",
        role: "assistant" as const,
        type: "agentMessage",
        status: "streaming" as const,
        title: "Assistant",
        text: "Plan streaming visible before completion",
        revision: 4,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:04.000Z"
      }],
      activeItemIds: ["plan-msg"],
      revision: 4,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:04.000Z"
    };
    const stalePlanSession = {
      ...planLiveSession,
      messages: [{ ...planLiveSession.messages[0], text: "Plan", revision: 2, updatedAt: "2026-06-16T00:00:02.000Z" }],
      revision: 5,
      updatedAt: "2026-06-16T00:00:05.000Z"
    };
    const mergedPlan = dataModule.mergeAgentSessionCaches(
      { ids: [planSessionId], byId: { [planSessionId]: planLiveSession } },
      { ids: [planSessionId], byId: { [planSessionId]: stalePlanSession } }
    );
    const planningRuns = structuredClone(roadmapModule.fallbackRuns);
    planningRuns[0] = {
      ...planningRuns[0],
      status: "running",
      executionPlanPlan: [],
      memberPathRuns: []
    };
    const planModel = roadmapModule.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: roadmapModule.fallbackBoard,
      runs: planningRuns,
      agentSessions: mergedPlan.ids.map(id => mergedPlan.byId[id]).filter(Boolean),
      skills: roadmapModule.fallbackSkills,
      worktree: roadmapModule.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "execute", executeId: "execute_handoff" },
      panel: "execute"
    });
    assert.equal(planModel.inspector?.kind, "execute");
    if (planModel.inspector?.kind === "execute") {
      assert.equal(planModel.inspector.planSession?.session.messages[0]?.text, "Plan streaming visible before completion");
      assert.equal(planModel.inspector.planSession?.session.messages[0]?.status, "streaming");
      assert.deepEqual(planModel.inspector.activeAgentSession, { kind: "TeamPlan", sessionId: planSessionId, mode: "stream" });
    }

    const pathSessionId = "execute_handoff:path:1:compose";
    const pathLiveSession = {
      sessionId: pathSessionId,
      runId: "run_handoff",
      executeId: "execute_handoff",
      routeRef: executeRouteRef("run_handoff", "execute_handoff", "Path"),
      owner: { kind: "ExecutionPlan" as const, runId: "run_handoff", executeId: "execute_handoff", attempt: 1, pathId: "compose", executorId: "ruler" },
      state: { type: "executing" as const, provider: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" }, activeItemIds: ["path-msg"] },
      provider: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" },
      messages: [{
        sessionId: pathSessionId,
        messageId: "path-msg",
        itemId: "path-msg",
        role: "assistant" as const,
        type: "agentMessage",
        status: "streaming" as const,
        title: "Assistant",
        text: "Path detail grows word by word before completion",
        revision: 7,
        createdAt: "2026-06-16T00:01:00.000Z",
        updatedAt: "2026-06-16T00:01:07.000Z"
      }],
      activeItemIds: ["path-msg"],
      revision: 7,
      createdAt: "2026-06-16T00:01:00.000Z",
      updatedAt: "2026-06-16T00:01:07.000Z"
    };
    const stalePathSession = {
      ...pathLiveSession,
      messages: [{ ...pathLiveSession.messages[0], text: "Path", revision: 3, updatedAt: "2026-06-16T00:01:03.000Z" }],
      revision: 8,
      updatedAt: "2026-06-16T00:01:08.000Z"
    };
    const mergedPath = dataModule.mergeAgentSessionCaches(
      { ids: [pathSessionId], byId: { [pathSessionId]: pathLiveSession } },
      { ids: [pathSessionId], byId: { [pathSessionId]: stalePathSession } }
    );
    const pathRuns = structuredClone(roadmapModule.fallbackRuns);
    pathRuns[0] = {
      ...pathRuns[0],
      status: "running",
      memberPathRuns: pathRuns[0].memberPathRuns?.map(path => path.pathId === "compose"
        ? {
            ...path,
            status: "executing" as const,
            agentSessionId: pathSessionId,
            session: { providerThreadId: "thread-compose", providerTurnId: "turn-compose" }
          }
        : path)
    };
    const pathModel = roadmapModule.buildRoadmapViewModel({
      roadmapId: "view-model-test-roadmap",
      board: roadmapModule.fallbackBoard,
      runs: pathRuns,
      agentSessions: mergedPath.ids.map(id => mergedPath.byId[id]).filter(Boolean),
      skills: roadmapModule.fallbackSkills,
      worktree: roadmapModule.fallbackWorktree,
      artifactActions: [],
      actionRuns: [],
      selection: { kind: "pathPoint", executeId: "execute_handoff", pointId: "compose" },
      panel: "path"
    });
    assert.equal(pathModel.inspector?.kind, "pathPoint");
    if (pathModel.inspector?.kind === "pathPoint") {
      assert.equal(pathModel.inspector.executionSession?.session.messages[0]?.text, "Path detail grows word by word before completion");
      assert.equal(pathModel.inspector.executionSession?.session.messages[0]?.status, "streaming");
      assert.deepEqual(pathModel.inspector.activeAgentSession, { kind: "ExecutionPlan", sessionId: pathSessionId, mode: "stream" });
    }
  } finally {
    await closeRoadmap();
    await closeData();
  }
});

async function loadRoadmapModule(): Promise<{ module: typeof RoadmapModule; close: () => Promise<void> }> {
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
	  let module: typeof RoadmapModule;
	  try {
	    module = await server.ssrLoadModule("/src/shared/domain/roadmapViewModel.ts") as typeof RoadmapModule;
	  } catch (error) {
	    await server.close();
	    throw error;
	  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadStudioDataModule(): Promise<{ module: typeof StudioDataModule; close: () => Promise<void> }> {
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
	  let module: typeof StudioDataModule;
	  try {
	    module = await server.ssrLoadModule("/src/shared/api/useStudioData.ts") as typeof StudioDataModule;
	  } catch (error) {
	    await server.close();
	    throw error;
	  }
  return {
    module,
    close: () => server.close()
  };
}

async function loadAgentChatModule(): Promise<{ module: { formatDurationMs: (durationMs: number) => string }; close: () => Promise<void> }> {
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
  let module: { formatDurationMs: (durationMs: number) => string };
  try {
    module = await server.ssrLoadModule("/src/features/inspector/AgentChat.tsx") as { formatDurationMs: (durationMs: number) => string };
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    module,
    close: () => server.close()
  };
}

function boardWithPlayableCurrentMove(source: BoardProjection): BoardProjection {
  const board = structuredClone(source) as BoardProjection;
  const move = board.moves.find(item => String(item.id) === "move_003");
  if (!move) {
    throw new Error("Expected fallback MOVE 3 fixture");
  }
  move.outcome = "arrived";
  delete (move as { failureReason?: string }).failureReason;
  return board;
}
