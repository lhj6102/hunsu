import type { RuntimeProviderStatus } from "@hunsu/bridge";
import type { BridgeCommandScope, ProjectGrant } from "../relay.ts";
import type { BridgeAppState, BridgeRoadmapAccessSnapshot } from "../state/appState.ts";
import type { RoadmapRegistryEntry } from "@hunsu/bridge";

const PROJECT_GRANT_SCOPE_VALUES = ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"] as const satisfies readonly BridgeCommandScope[];

type ParsedWorkspaceArgs = {
  rest: string[];
};

type WorkspaceCommandContext = {
  hasFlag: (parsed: any, name: string) => boolean;
  getFlag: (parsed: any, name: string) => string | undefined;
  resolvePath: (path: string) => string;
  basename: (path: string) => string;
  readState: () => BridgeAppState;
  createStudioState: () => any;
  runtimeProvidersSnapshot: () => Promise<{ current: RuntimeProviderStatus }>;
  roadmapRegistryOptions: () => { roadmapRegistryPath?: string };
  listManagedRoadmaps: (options: { roadmapRegistryPath?: string }) => RoadmapRegistryEntry[];
  listRecentRoadmaps: (options: { roadmapRegistryPath?: string }) => RoadmapRegistryEntry[];
  inspectProject: (request: { path: string }, options: { roadmapRegistryPath?: string }) => { kind: string; path?: string; reason?: string };
  openStudioRoadmap: (request: { path: string }, state: any, options: { persist: boolean; roadmapRegistryPath?: string }) => { roadmap: { displayName: string } };
  applyStudioPort: (request: { path: string; title: string; goal: string }, state: any, options: { roadmapRegistryPath?: string }) => { roadmap: { displayName: string } };
  createStudioRoadmap: (request: { path: string }, state: any, options: { persist: boolean; roadmapRegistryPath?: string }) => { roadmap: { displayName: string } };
  setRoadmapLifecycle: (request: { roadmapId: string }, lifecycle: "active" | "inactive", options: { roadmapRegistryPath?: string }) => { roadmap?: { displayName: string } };
  removeRoadmapRegistryEntry: (request: { roadmapId?: string; path?: string }, options: { roadmapRegistryPath?: string }) => { removed: boolean };
  setRoadmapRemoteAccessCommand: (roadmapId: string, enabled: boolean, parsed: any) => Promise<void>;
  publishProjectGrantsToRelay: (state: BridgeAppState) => Promise<void>;
  printManagedRoadmaps: (roadmaps: BridgeRoadmapAccessSnapshot[], provider: RuntimeProviderStatus) => void;
  normalizeGrantPath: (path: string) => string;
  looksLikeProjectPath: (value: string) => boolean;
  projectGrantScopesForCommand: (parsed: any, state: BridgeAppState) => BridgeCommandScope[];
  writeState: (state: BridgeAppState) => void;
};

export function snapshotProjectGrants(projectGrants: ProjectGrant[]): ProjectGrant[] {
  return projectGrants.map(grant => ({
    path: grant.path,
    grantedAt: grant.grantedAt,
    scopes: [...grant.scopes],
    active: grant.active === false ? false : undefined
  }));
}

export function projectGrantsWithRemoteRelay(projectGrants: ProjectGrant[]): ProjectGrant[] {
  return snapshotProjectGrants(projectGrants).map(grant => ({
    ...grant,
    scopes: grant.scopes.includes("remoteRelay.access")
      ? grant.scopes
      : uniqueScopeList([...grant.scopes, "remoteRelay.access"])
  }));
}

export function projectGrantsWithoutRemoteRelay(projectGrants: ProjectGrant[]): ProjectGrant[] {
  return snapshotProjectGrants(projectGrants)
    .map(grant => ({
      ...grant,
      scopes: grant.scopes.filter(scope => scope !== "remoteRelay.access"),
      active: false
    }))
    .filter(grant => grant.scopes.length > 0);
}

export function activeManagedProjectGrantsForRoadmaps(
  roadmaps: RoadmapRegistryEntry[],
  projectGrants: ProjectGrant[],
  normalizeGrantPath: (path: string) => string
): ProjectGrant[] {
  const activePaths = new Set(
    roadmaps
      .filter(roadmap => roadmap.lifecycle === "active")
      .map(roadmap => normalizeGrantPath(roadmap.repositoryPath))
  );
  return snapshotProjectGrants(projectGrants)
    .filter(grant => grant.active !== false
      && grant.scopes.includes("remoteRelay.access")
      && activePaths.has(normalizeGrantPath(grant.path)));
}

export function roadmapAccessSnapshots(
  roadmaps: RoadmapRegistryEntry[],
  projectGrants: ProjectGrant[],
  provider: RuntimeProviderStatus,
  options: {
    scopeValues: readonly BridgeCommandScope[];
    normalizeGrantPath: (path: string) => string;
  }
): BridgeRoadmapAccessSnapshot[] {
  return roadmaps.map(roadmap => {
    const grant = projectGrantForRoadmap(roadmap, projectGrants, options.normalizeGrantPath);
    const scopes = uniqueScopeList([...(grant?.scopes ?? roadmap.remoteAccess?.scopes ?? [])]);
    const active = roadmap.lifecycle === "active";
    const enabled = active && grant?.active !== false && scopes.includes("remoteRelay.access");
    return {
      ...roadmap,
      provider: {
        providerId: provider.providerId,
        label: provider.label,
        readyForExecute: provider.ready
      },
      codex: { readyForExecute: provider.providerId === "codex" && provider.ready },
      projectGrant: grant,
      remoteAccess: {
        available: active,
        enabled,
        reason: active ? undefined : remoteAccessUnavailableReason(roadmap.lifecycle),
        scopes,
        scopeState: scopeState(scopes, options.scopeValues)
      }
    };
  });
}

export function projectGrantForRoadmap(
  roadmap: Pick<RoadmapRegistryEntry, "repositoryPath">,
  projectGrants: ProjectGrant[],
  normalizeGrantPath: (path: string) => string
): ProjectGrant | undefined {
  const targetPath = normalizeGrantPath(roadmap.repositoryPath);
  return snapshotProjectGrants(projectGrants).find(grant => normalizeGrantPath(grant.path) === targetPath);
}

export function remoteAccessUnavailableReason(lifecycle: RoadmapRegistryEntry["lifecycle"] | undefined): string {
  if (lifecycle === "inactive") return "Roadmap is inactive.";
  if (lifecycle === "missing") return "Roadmap path is missing.";
  if (lifecycle === "needs_upgrade") return "Roadmap needs upgrade.";
  if (lifecycle === "error") return "Roadmap is unavailable.";
  return "Roadmap is not active.";
}

export async function runRoadmapsCommand(parsed: ParsedWorkspaceArgs, context: WorkspaceCommandContext): Promise<void> {
  const action = parsed.rest[0] ?? "list";
  if (action === "list") {
    const state = context.readState();
    const runtimeProviders = await context.runtimeProvidersSnapshot();
    const roadmaps = roadmapAccessSnapshots(context.listManagedRoadmaps(context.roadmapRegistryOptions()), state.projectGrants, runtimeProviders.current, {
      scopeValues: PROJECT_GRANT_SCOPE_VALUES,
      normalizeGrantPath: context.normalizeGrantPath
    });
    if (context.hasFlag(parsed, "json")) {
      console.log(JSON.stringify({ roadmaps }, null, 2));
      return;
    }
    context.printManagedRoadmaps(roadmaps, runtimeProviders.current);
    return;
  }
  if (action === "add") {
    const path = parsed.rest[1];
    if (!path?.trim()) {
      throw new Error("Usage: hunsu-bridge roadmaps add /path/to/project");
    }
    const project = context.inspectProject({ path: context.resolvePath(path) }, context.roadmapRegistryOptions());
    const state = context.createStudioState();
    const options = context.roadmapRegistryOptions();
    if (project.kind === "hunsu-roadmap" && project.path) {
      const result = context.openStudioRoadmap({ path: project.path }, state, { persist: true, roadmapRegistryPath: options.roadmapRegistryPath });
      console.log(`Activated Roadmap: ${result.roadmap.displayName}`);
      return;
    }
    if (project.kind === "git-project" && project.path) {
      const name = context.basename(project.path);
      const result = context.applyStudioPort({ path: project.path, title: name, goal: `Port ${name} into Hunsu.` }, state, options);
      console.log(`Ported and activated Roadmap: ${result.roadmap.displayName}`);
      return;
    }
    if (project.kind === "new-project" && project.path) {
      const result = context.createStudioRoadmap({ path: project.path }, state, { persist: true, roadmapRegistryPath: options.roadmapRegistryPath });
      console.log(`Created and activated Roadmap: ${result.roadmap.displayName}`);
      return;
    }
    throw new Error(project.reason ?? "Project cannot be added as a Roadmap.");
  }
  if (action === "activate" || action === "deactivate") {
    const roadmapId = parsed.rest[1];
    if (!roadmapId?.trim()) {
      throw new Error(`Usage: hunsu-bridge roadmaps ${action} <roadmapId>`);
    }
    const result = context.setRoadmapLifecycle({ roadmapId }, action === "activate" ? "active" : "inactive", context.roadmapRegistryOptions());
    await context.publishProjectGrantsToRelay(context.readState());
    console.log(`${action === "activate" ? "Activated" : "Deactivated"} Roadmap: ${result.roadmap?.displayName ?? roadmapId}`);
    return;
  }
  if (action === "remote") {
    const mode = parsed.rest[1];
    const roadmapId = parsed.rest[2];
    if ((mode !== "enable" && mode !== "disable") || !roadmapId?.trim()) {
      throw new Error("Usage: hunsu-bridge roadmaps remote enable|disable <roadmapId> [--scopes all|remoteRelay.access,execute.start,artifactAction.run,env.read,hostAlias.expose]");
    }
    await context.setRoadmapRemoteAccessCommand(roadmapId, mode === "enable", parsed);
    return;
  }
  if (action === "remove") {
    const roadmapId = parsed.rest[1] ?? context.getFlag(parsed, "roadmap-id");
    if (!roadmapId?.trim()) {
      throw new Error("Usage: hunsu-bridge roadmaps remove <roadmapId>");
    }
    const result = context.removeRoadmapRegistryEntry({ roadmapId }, context.roadmapRegistryOptions());
    console.log(result.removed ? "Removed Roadmap from Bridge App. Local files were not deleted." : "Roadmap was not registered.");
    return;
  }
  throw new Error("Usage: hunsu-bridge roadmaps list|add <path>|activate <roadmapId>|deactivate <roadmapId>|remote enable|disable <roadmapId>|remove <roadmapId>");
}

export async function runProjectsCommand(parsed: ParsedWorkspaceArgs, context: WorkspaceCommandContext): Promise<void> {
  const subcommand = parsed.rest[0] ?? "list";
  if (["add", "activate", "deactivate"].includes(subcommand)) {
    await runRoadmapsCommand(parsed, context);
    return;
  }
  if (subcommand === "list") {
    const grants = context.readState().projectGrants;
    if (grants.length === 0) {
      console.log("No Project Grants.");
      return;
    }
    for (const grant of grants) {
      console.log(`${grant.path}\t${grant.scopes.join(",")}\t${grant.grantedAt}`);
    }
    return;
  }
  if (subcommand === "recent") {
    for (const project of context.listRecentRoadmaps(context.roadmapRegistryOptions())) {
      console.log(`${project.displayName}\t${project.health}\t${project.repositoryPath}`);
    }
    return;
  }
  if (subcommand === "remove") {
    const target = parsed.rest[1];
    const explicitRoadmapId = context.getFlag(parsed, "roadmap-id");
    const explicitPath = context.getFlag(parsed, "path");
    const inferredPath = target && context.looksLikeProjectPath(target) ? target : undefined;
    const inferredRoadmapId = target && !context.looksLikeProjectPath(target) ? target : undefined;
    const roadmapId = explicitRoadmapId ?? inferredRoadmapId;
    const path = explicitPath ?? inferredPath;
    if (!roadmapId && !path) {
      throw new Error("Roadmap ID or project path is required.");
    }
    const result = context.removeRoadmapRegistryEntry({
      roadmapId,
      path: path ? context.resolvePath(path) : undefined
    }, context.roadmapRegistryOptions());
    console.log(result.removed ? "Removed from recent Roadmaps." : "No matching recent Roadmap was found.");
    return;
  }
  const targetPath = parsed.rest[1] ? context.normalizeGrantPath(parsed.rest[1]) : undefined;
  if (!targetPath) {
    throw new Error("Project path is required.");
  }
  const state = context.readState();
  if (subcommand === "grant") {
    const scopes = context.projectGrantScopesForCommand(parsed, state);
    const grant: ProjectGrant = {
      path: targetPath,
      grantedAt: new Date().toISOString(),
      scopes
    };
    const nextState = {
      ...state,
      projectGrants: [grant, ...state.projectGrants.filter(item => item.path !== targetPath)]
    };
    context.writeState(nextState);
    await context.publishProjectGrantsToRelay(nextState);
    console.log(`Granted project access: ${targetPath}`);
    return;
  }
  if (subcommand === "revoke") {
    const nextState = {
      ...state,
      projectGrants: state.projectGrants.filter(item => item.path !== targetPath)
    };
    context.writeState(nextState);
    await context.publishProjectGrantsToRelay(nextState);
    console.log(`Revoked project access: ${targetPath}`);
    return;
  }
  throw new Error(`Unknown projects command: ${subcommand}`);
}

function scopeState(scopes: BridgeCommandScope[], scopeValues: readonly BridgeCommandScope[]): Record<BridgeCommandScope, boolean> {
  return Object.fromEntries(scopeValues.map(scope => [scope, scopes.includes(scope)])) as Record<BridgeCommandScope, boolean>;
}

function uniqueScopeList(scopes: BridgeCommandScope[]): BridgeCommandScope[] {
  return [...new Set(scopes)];
}
