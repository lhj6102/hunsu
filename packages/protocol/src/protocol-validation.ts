import {
  GUARDRAIL_SCOPES,
  GUARDRAIL_SEVERITIES,
  REASONING_EFFORTS,
  SERVICE_TIERS,
  VOTE_RULES
} from "./constants.ts";
import {
  DomainInvariantError,
  unwrapDomainModelResult,
  type DomainWorkflowError
} from "./errors.ts";
import type {
  ExecutorEntity,
  ExecutorId,
  ExecutorVisibleProfile,
  Harness,
  HarnessPlannerSnapshot,
  HarnessSnapshot,
  HubPackageKind,
  HubPackageLock,
  ManagerConfig,
  Member,
  MemberApprovalConstraint,
  MemberConfig,
  MemberExecutionConstraint,
  MemberPluginBinding,
  Membership,
  ResourceBinding,
  ResourceEntity,
  RuntimePolicy,
  SkillBinding
} from "./model.ts";
import { assertValidPromptTemplate, decodePromptTemplate, promptTemplateFromText, type PromptTemplate } from "./prompt-template.ts";
import { makeNonEmptyText, makePositiveInteger } from "./primitives.ts";
import { err, ok, type Result } from "./result.ts";

export const DEFAULT_TEAM_PROMPT = "Create a closure-free ExecutionPlan using the available Members.";
export const DEFAULT_MANAGER_PROMPT = [
  "Discuss HUNSU changes conversationally and edit only decoded request files under .hunsu-request when a file-backed draft change is needed.",
  "Help the user refine divergent Hunsu changes while preserving the current Execute result as the source of truth."
].join(" ");
export const DEFAULT_MEMBER_EXECUTION: MemberExecutionConstraint = { kind: "read_only", network: "disabled" };
export const DEFAULT_MEMBER_APPROVAL: MemberApprovalConstraint = { policy: "never" };
const MEMBER_EXECUTION_KINDS = ["read_only", "worktree_write", "unrestricted"] as const;
const MEMBER_EXECUTION_NETWORKS = ["disabled", "enabled"] as const;
const MEMBER_APPROVAL_POLICIES = ["never", "on_request"] as const;
const MEMBER_APPROVAL_REVIEWERS = ["user", "auto_review"] as const;
const DEFAULT_ROOT_TEAM_ID = "root-team";

export function validateHarness(value: unknown): Result<HarnessSnapshot, DomainWorkflowError> {
  return parseHarness(value);
}

export function validateHarnessPlanner(value: unknown): Result<HarnessPlannerSnapshot, DomainWorkflowError> {
  return parseHarnessPlanner(value);
}

export function validateHarnessEntity(value: unknown, path = "Harness"): Result<Harness, DomainWorkflowError> {
  const harness = recordResult(value, path);
  if (!harness.ok) return harness;
  if (typeof harness.value.rootTeamId !== "string" || harness.value.rootTeamId.trim() === "") {
    return workflowValidationError(`${path}.rootTeamId must be a non-empty string`);
  }
  if (!Array.isArray(harness.value.executors)) {
    return workflowValidationError(`${path}.executors must be an array`);
  }
  if (!Array.isArray(harness.value.resources)) {
    return workflowValidationError(`${path}.resources must be an array`);
  }
  const executorIds = new Set<string>();
  for (const [index, executor] of harness.value.executors.entries()) {
    const validation = executorEntityResult(executor, `${path}.executors[${index}]`);
    if (!validation.ok) return validation;
    const id = String((executor as { id: unknown }).id);
    if (executorIds.has(id)) {
      return workflowValidationError(`${path}.executors must not include duplicate Executor ${id}`);
    }
    executorIds.add(id);
  }
  const root = harness.value.executors.find(executor => {
    const record = executor as { id?: unknown; kind?: unknown };
    return record.id === harness.value.rootTeamId && record.kind === "team";
  });
  if (!root) {
    return workflowValidationError(`${path}.rootTeamId must reference a Team Executor`);
  }
  const executorKindById = new Map<string, "team" | "member">();
  const teamMemberships = new Map<string, string[]>();
  for (const executor of harness.value.executors) {
    const record = executor as { id?: unknown; kind?: unknown; members?: Membership[] };
    const id = String(record.id);
    const kind = record.kind === "team" ? "team" : "member";
    executorKindById.set(id, kind);
    if (kind === "team") {
      teamMemberships.set(id, (record.members ?? []).map(membership => String(membership.executorId)));
    }
  }
  for (const [index, executor] of harness.value.executors.entries()) {
    const record = executor as { kind?: unknown; members?: unknown };
    if (record.kind !== "team") {
      continue;
    }
    const memberships = record.members as Membership[];
    for (const [membershipIndex, membership] of memberships.entries()) {
      const memberId = String(membership.executorId);
      const memberKind = executorKindById.get(memberId);
      if (!memberKind) {
        return workflowValidationError(`${path}.executors[${index}].members[${membershipIndex}].executorId references unknown Executor ${membership.executorId}`);
      }
      if (membership.visibleProfile.kind !== memberKind) {
        return workflowValidationError(`${path}.executors[${index}].members[${membershipIndex}].visibleProfile.kind must match Executor ${memberId} kind ${memberKind}`);
      }
    }
  }
  const cycle = findTeamCycle(teamMemberships);
  if (cycle) {
    return workflowValidationError(`${path}.executors must not contain cyclic Team Memberships: ${cycle.join(" -> ")}`);
  }
  for (const [index, resource] of harness.value.resources.entries()) {
    const validation = resourceEntityResult(resource, `${path}.resources[${index}]`);
    if (!validation.ok) return validation;
  }
  const guardrails = guardrailsResult(harness.value.guardrails, `${path}.guardrails`);
  if (!guardrails.ok) return guardrails;
  if (!Array.isArray(harness.value.artifactActions)) {
    return workflowValidationError(`${path}.artifactActions must be an array`);
  }
  return ok(cloneHarnessEntity(harness.value as Harness));
}

function findTeamCycle(teamMemberships: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (teamId: string): string[] | undefined => {
    if (visiting.has(teamId)) {
      const start = stack.indexOf(teamId);
      return [...stack.slice(start), teamId];
    }
    if (visited.has(teamId)) {
      return undefined;
    }
    visiting.add(teamId);
    stack.push(teamId);
    for (const childId of teamMemberships.get(teamId) ?? []) {
      if (!teamMemberships.has(childId)) {
        continue;
      }
      const cycle = visit(childId);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(teamId);
    visited.add(teamId);
    return undefined;
  };

  for (const teamId of teamMemberships.keys()) {
    const cycle = visit(teamId);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

export function validateMemberConfig(value: unknown, path = "Member"): Result<MemberConfig, DomainWorkflowError> {
  const member = recordResult(value, path);
  if (!member.ok) return member;
  const validation = memberConfigResult(member.value, path);
  return validation.ok ? ok(cloneMemberConfig(member.value as MemberConfig)) : validation;
}

export function validateManagerConfig(value: unknown, path = "Manager"): Result<ManagerConfig, DomainWorkflowError> {
  const manager = recordResult(value, path);
  if (!manager.ok) return manager;
  const validation = managerConfigResult(manager.value, path);
  return validation.ok ? ok(cloneManagerConfig(manager.value as ManagerConfig)) : validation;
}

function parseHarness(value: unknown): Result<HarnessSnapshot, DomainWorkflowError> {
  const protocol = recordResult(value, "Harness");
  if (!protocol.ok) return protocol;
  const normalized = normalizeHarnessKind(protocol.value);
  switch (normalized.kind) {
    case "team_execution_plan":
      return validateHarnessSnapshotShape({ ...normalized, kind: "team_execution_plan" }, "team_execution_plan", "maxAttemptCount");
    case "role_squad":
      return validateHarnessSnapshotShape(normalized, "role_squad", "maxRoundCount");
    case "council_vote":
      return chainResult(
        allowedResult("council_vote.voteRule", normalized.voteRule, VOTE_RULES),
        () => validateHarnessSnapshotShape(normalized, "council_vote", "maxRoundCount")
      );
    case "court_debate":
      return validateHarnessSnapshotShape(normalized, "court_debate", "maxRoundCount");
    default:
      return workflowValidationError(`Unsupported Harness kind: ${String(normalized.kind)}`);
  }
}

function parseHarnessPlanner(value: unknown): Result<HarnessPlannerSnapshot, DomainWorkflowError> {
  const protocol = recordResult(value, "Planner Harness");
  if (!protocol.ok) return protocol;
  const normalized = normalizeHarnessKind(protocol.value);
  switch (normalized.kind) {
    case "team_execution_plan":
      return validateHarnessPlannerSnapshotShape({ ...normalized, kind: "team_execution_plan" }, "team_execution_plan", "maxAttemptCount");
    case "role_squad":
      return validateHarnessPlannerSnapshotShape(normalized, "role_squad", "maxRoundCount");
    case "council_vote":
      return chainResult(
        allowedResult("council_vote.voteRule", normalized.voteRule, VOTE_RULES),
        () => validateHarnessPlannerSnapshotShape(normalized, "council_vote", "maxRoundCount")
      );
    case "court_debate":
      return validateHarnessPlannerSnapshotShape(normalized, "court_debate", "maxRoundCount");
    default:
      return workflowValidationError(`Unsupported Planner Harness kind: ${String(normalized.kind)}`);
  }
}

export function isExecutableHarness(protocol: HarnessSnapshot): boolean {
  return protocol.kind === "team_execution_plan";
}

export function validateExecutableHarness(protocol: HarnessSnapshot): Result<HarnessSnapshot, DomainWorkflowError> {
  if (!isExecutableHarness(protocol)) {
    return err({ type: "DomainWorkflowError", message: `Harness ${protocol.kind} is not executable yet` });
  }
  return ok(protocol);
}

export function createDefaultHarness(instructions = "", skills: SkillBinding[] = []): HarnessSnapshot {
  return {
    kind: "team_execution_plan",
    maxAttemptCount: unwrapDomainModelResult(makePositiveInteger(5, "team_execution_plan.maxAttemptCount")),
    team: {
      promptTemplate: promptTemplateFromText(instructions || DEFAULT_TEAM_PROMPT)
    },
    members: [
      createDefaultMemberConfig("azir", "Plan briefly, then implement the focused goal in this repository.", skills),
      createDefaultMemberConfig("galio", "Verify the completed work against the focused goal with concrete evidence.", [])
    ]
  };
}

export function createDefaultMemberConfig(
  id: string,
  prompt = "",
  skills: SkillBinding[] = [],
  execution: MemberExecutionConstraint = DEFAULT_MEMBER_EXECUTION,
  approval: MemberApprovalConstraint = DEFAULT_MEMBER_APPROVAL,
  plugins: MemberPluginBinding[] = []
): MemberConfig {
  return {
    id: unwrapDomainModelResult(makeNonEmptyText(id, "executorId")),
    promptTemplate: promptTemplateFromText(prompt),
    skills: cloneSkills(skills),
    plugins: clonePlugins(plugins),
    model: unwrapDomainModelResult(makeNonEmptyText("codex-default", "member.model")),
    reasoningEffort: "default",
    serviceTier: "default",
    execution: cloneMemberExecution(execution),
    approval: cloneMemberApproval(approval)
  };
}

export function createDefaultManagerConfig(
  id = "manager.hunsu.default",
  prompt = DEFAULT_MANAGER_PROMPT,
  skills: SkillBinding[] = [],
  plugins: MemberPluginBinding[] = []
): ManagerConfig {
  return {
    id: unwrapDomainModelResult(makeNonEmptyText(id, "manager.id")),
    promptTemplate: promptTemplateFromText(prompt),
    skills: cloneSkills(skills),
    plugins: clonePlugins(plugins)
  };
}

export function cloneHarness(protocol: HarnessSnapshot): HarnessSnapshot {
  const cloned = JSON.parse(JSON.stringify(protocol)) as HarnessSnapshot;
  return {
    ...cloned,
    guardrails: cloned.guardrails?.map(guardrail => ({ ...guardrail })),
    members: cloned.members.map(cloneMemberConfig)
  };
}

export function cloneHarnessPlanner(protocol: HarnessPlannerSnapshot): HarnessPlannerSnapshot {
  const cloned = JSON.parse(JSON.stringify(protocol)) as HarnessPlannerSnapshot;
  return {
    ...cloned,
    team: { promptTemplate: { ...cloned.team.promptTemplate } },
    guardrails: cloned.guardrails?.map(guardrail => ({ ...guardrail }))
  };
}

export function harnessPlannerFromSnapshot(protocol: HarnessSnapshot): HarnessPlannerSnapshot {
  const cloned = cloneHarness(protocol);
  const { members: _members, ...planner } = cloned;
  return cloneHarnessPlanner(planner as HarnessPlannerSnapshot);
}

export function composeHarnessSnapshot(planner: HarnessPlannerSnapshot, members: MemberConfig[]): HarnessSnapshot {
  const memberValidation = memberArrayResult(members, "members.members", true);
  if (!memberValidation.ok) {
    throw new DomainInvariantError(memberValidation.error.message);
  }
  const clonedPlanner = cloneHarnessPlanner(planner);
  const clonedMembers = members.map(cloneMemberConfig);
  return {
    ...clonedPlanner,
    members: clonedMembers
  } as HarnessSnapshot;
}

export function harnessEntityFromSnapshot(protocol: HarnessSnapshot, rootTeamId = DEFAULT_ROOT_TEAM_ID): Harness {
  const rootId = executorId(rootTeamId, "rootTeamId");
  const planner = harnessPlannerFromSnapshot(protocol);
  const members = protocol.members.map(cloneMemberConfig);
  const rootMemberships: Membership[] = members.map(member => ({
    executorId: member.id,
    visibleProfile: visibleProfileFromMemberConfig(member)
  }));
  return {
    rootTeamId: rootId,
    executors: [
      {
        kind: "team",
        id: rootId,
        planner: {
          promptTemplate: { ...planner.team.promptTemplate },
          maxAttemptCount: "maxAttemptCount" in planner ? planner.maxAttemptCount : undefined,
          guardrails: planner.guardrails?.map(guardrail => ({ ...guardrail }))
        },
        members: rootMemberships
      },
      ...members.map(memberEntityFromConfig)
    ],
    resources: resourceEntitiesFromMembers(members),
    guardrails: planner.guardrails?.map(guardrail => ({ ...guardrail })) ?? [],
    artifactActions: []
  };
}

export function harnessSnapshotForTeam(harness: Harness, teamId: string = harness.rootTeamId): HarnessSnapshot {
  const team = getHarnessTeam(harness, teamId);
  if (!team) {
    throw new DomainInvariantError(`Harness does not define Team ${teamId}`);
  }
  const members = team.members.map(membership => memberConfigForMembership(harness, membership));
  const maxAttemptCount = team.planner.maxAttemptCount
    ?? unwrapDomainModelResult(makePositiveInteger(5, "team.maxAttemptCount"));
  return {
    kind: "team_execution_plan",
    maxAttemptCount,
    guardrails: team.planner.guardrails?.map(guardrail => ({ ...guardrail })),
    team: {
      promptTemplate: { ...team.planner.promptTemplate }
    },
    members
  };
}

export function rootHarnessSnapshot(harness: Harness): HarnessSnapshot {
  return harnessSnapshotForTeam(harness, harness.rootTeamId);
}

export function cloneHarnessEntity(harness: Harness): Harness {
  return {
    rootTeamId: harness.rootTeamId,
    executors: harness.executors.map(cloneExecutorEntity),
    resources: harness.resources.map(cloneResourceEntity),
    guardrails: harness.guardrails.map(guardrail => ({ ...guardrail })),
    artifactActions: JSON.parse(JSON.stringify(harness.artifactActions)) as Harness["artifactActions"]
  };
}

export function getHarnessExecutor(harness: Harness, executorId: string): ExecutorEntity | undefined {
  const executor = harness.executors.find(candidate => candidate.id === executorId);
  return executor ? cloneExecutorEntity(executor) : undefined;
}

export function getHarnessTeam(harness: Harness, executorId: string): Extract<ExecutorEntity, { kind: "team" }> | undefined {
  const executor = harness.executors.find(candidate => candidate.id === executorId && candidate.kind === "team");
  return executor ? cloneExecutorEntity(executor) as Extract<ExecutorEntity, { kind: "team" }> : undefined;
}

export function getHarnessMember(harness: Harness, executorId: string): Member | undefined {
  const executor = harness.executors.find(candidate => candidate.id === executorId && candidate.kind === "member");
  return executor ? cloneMemberEntity(executor as Member) : undefined;
}

export function memberConfigFromMemberEntity(member: Member): MemberConfig {
  return {
    id: member.id,
    promptTemplate: { ...member.promptTemplate },
    skills: member.resources
      .filter((binding): binding is Extract<ResourceBinding, { kind: "skill" }> => binding.kind === "skill")
      .map(binding => cloneSkill(binding.skill)),
    plugins: member.resources
      .filter((binding): binding is Extract<ResourceBinding, { kind: "plugin" }> => binding.kind === "plugin")
      .map(binding => ({ ...binding.plugin })),
    model: member.runtimePolicy.model,
    reasoningEffort: member.runtimePolicy.reasoningEffort,
    serviceTier: member.runtimePolicy.serviceTier,
    execution: cloneMemberExecution(member.runtimePolicy.execution),
    approval: cloneMemberApproval(member.runtimePolicy.approval)
  };
}

export function getHarnessMemberConfig(protocol: HarnessSnapshot, executorId: string): MemberConfig | undefined {
  return protocol.members.find(member => member.id === executorId)
    ? cloneMemberConfig(protocol.members.find(member => member.id === executorId)!)
    : undefined;
}

export function updateHarnessMemberConfig(protocol: HarnessSnapshot, executorId: string, update: (member: MemberConfig) => MemberConfig): HarnessSnapshot {
  if (!protocol.members.some(member => member.id === executorId)) {
    throw new DomainInvariantError(`Unknown Member ${executorId} for Harness ${protocol.kind}`);
  }
  return {
    ...protocol,
    team: { ...protocol.team },
    guardrails: protocol.guardrails?.map(guardrail => ({ ...guardrail })),
    members: protocol.members.map(member => member.id === executorId ? update(cloneMemberConfig(member)) : cloneMemberConfig(member))
  };
}

export function updateHarnessTeamPromptTemplate(protocol: HarnessSnapshot, promptTemplate: PromptTemplate): HarnessSnapshot {
  assertValidPromptTemplate(promptTemplate, "Team prompt template");
  return {
    ...protocol,
    team: { promptTemplate: { ...promptTemplate } },
    guardrails: protocol.guardrails?.map(guardrail => ({ ...guardrail })),
    members: protocol.members.map(cloneMemberConfig)
  };
}

function executorId(value: string, path: string): ExecutorId {
  return unwrapDomainModelResult(makeNonEmptyText(value, path));
}

function runtimePolicyFromMemberConfig(member: MemberConfig): RuntimePolicy {
  return {
    model: member.model,
    reasoningEffort: member.reasoningEffort,
    serviceTier: member.serviceTier,
    execution: cloneMemberExecution(member.execution),
    approval: cloneMemberApproval(member.approval)
  };
}

function resourceBindingsFromMemberConfig(member: MemberConfig): ResourceBinding[] {
  return [
    ...member.skills.map(skill => ({ kind: "skill" as const, skill: cloneSkill(skill) })),
    ...(member.plugins ?? []).map(plugin => ({ kind: "plugin" as const, plugin: { ...plugin } }))
  ];
}

function memberEntityFromConfig(member: MemberConfig): Member {
  return {
    kind: "member",
    id: member.id,
    promptTemplate: { ...member.promptTemplate },
    resources: resourceBindingsFromMemberConfig(member),
    runtimePolicy: runtimePolicyFromMemberConfig(member)
  };
}

function visibleProfileFromMemberConfig(member: MemberConfig): ExecutorVisibleProfile {
  return {
    kind: "member",
    label: member.id,
    summary: unwrapDomainModelResult(makeNonEmptyText(member.promptTemplate.template || `Member ${member.id}`, "visibleProfile.summary")),
    capabilities: member.skills.map(skill => skill.name)
  };
}

function memberConfigForMembership(harness: Harness, membership: Membership): MemberConfig {
  const executor = harness.executors.find(candidate => candidate.id === membership.executorId);
  if (!executor) {
    throw new DomainInvariantError(`Team Membership references unknown Executor ${membership.executorId}`);
  }
  if (executor.kind === "member") {
    return memberConfigFromMemberEntity(executor);
  }
  return createDefaultMemberConfig(
    executor.id,
    visibleProfilePrompt(membership.visibleProfile),
    [],
    DEFAULT_MEMBER_EXECUTION,
    DEFAULT_MEMBER_APPROVAL,
    []
  );
}

function visibleProfilePrompt(profile: ExecutorVisibleProfile): string {
  const capabilities = profile.capabilities?.length ? `\nCapabilities:\n${profile.capabilities.map(capability => `- ${capability}`).join("\n")}` : "";
  return [
    profile.kind === "team" ? "Composite Team Executor." : "Member Executor.",
    profile.label ? `Label: ${profile.label}` : undefined,
    profile.summary ? `Summary: ${profile.summary}` : undefined,
    capabilities || undefined
  ].filter(Boolean).join("\n");
}

function resourceEntitiesFromMembers(members: MemberConfig[]): ResourceEntity[] {
  const resources: ResourceEntity[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const binding of resourceBindingsFromMemberConfig(member)) {
      const id = resourceEntityId(member.id, binding);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      resources.push({
        id: id as ResourceEntity["id"],
        binding
      });
    }
  }
  return resources;
}

function resourceEntityId(memberId: string, binding: ResourceBinding): string {
  if (binding.kind === "skill") {
    return `resource.${memberId}.skill.${binding.skill.name}`;
  }
  if (binding.kind === "plugin") {
    return `resource.${memberId}.plugin.${binding.plugin.id}`;
  }
  return `resource.${memberId}.package.${binding.lock.kind}.${binding.lock.key}.${binding.lock.version}`;
}

function cloneExecutorEntity(executor: ExecutorEntity): ExecutorEntity {
  if (executor.kind === "member") {
    return { ...cloneMemberEntity(executor), packageLock: executor.packageLock ? { ...executor.packageLock } : undefined };
  }
  return {
    ...executor,
    planner: {
      promptTemplate: { ...executor.planner.promptTemplate },
      maxAttemptCount: executor.planner.maxAttemptCount,
      guardrails: executor.planner.guardrails?.map(guardrail => ({ ...guardrail }))
    },
    members: executor.members.map(membership => ({
      executorId: membership.executorId,
      visibleProfile: {
        ...membership.visibleProfile,
        capabilities: membership.visibleProfile.capabilities ? [...membership.visibleProfile.capabilities] : undefined
      }
    })),
    packageLock: executor.packageLock ? { ...executor.packageLock } : undefined
  };
}

function cloneMemberEntity(member: Member): Member {
  return {
    kind: "member",
    id: member.id,
    promptTemplate: { ...member.promptTemplate },
    resources: member.resources.map(cloneResourceBinding),
    runtimePolicy: {
      model: member.runtimePolicy.model,
      reasoningEffort: member.runtimePolicy.reasoningEffort,
      serviceTier: member.runtimePolicy.serviceTier,
      execution: cloneMemberExecution(member.runtimePolicy.execution),
      approval: cloneMemberApproval(member.runtimePolicy.approval)
    }
  };
}

function cloneResourceBinding(binding: ResourceBinding): ResourceBinding {
  if (binding.kind === "skill") {
    return { kind: "skill", skill: cloneSkill(binding.skill) };
  }
  if (binding.kind === "plugin") {
    return { kind: "plugin", plugin: { ...binding.plugin } };
  }
  return { kind: "package", lock: { ...binding.lock } };
}

function cloneResourceEntity(resource: ResourceEntity): ResourceEntity {
  return {
    id: resource.id,
    binding: cloneResourceBinding(resource.binding),
    packageLock: resource.packageLock ? { ...resource.packageLock } : undefined
  };
}

export function validateSkillBinding(value: unknown, path: string): void {
  const validation = validateSkillBindingResult(value, path);
  if (!validation.ok) {
    throw new DomainInvariantError(validation.error.message);
  }
}

function validateHarnessSnapshotShape(
  protocol: Record<string, unknown>,
  kind: HarnessSnapshot["kind"],
  countField: "maxAttemptCount" | "maxRoundCount"
): Result<HarnessSnapshot, DomainWorkflowError> {
  for (const validation of [
    positiveIntegerResult(protocol[countField], `${kind}.${countField}`),
    guardrailsResult(protocol.guardrails, `${kind}.guardrails`),
    teamConfigResult(protocol.team, `${kind}.team`),
    memberArrayResult(protocol.members, `${kind}.members`, true)
  ]) {
    if (!validation.ok) {
      return validation;
    }
  }
  return ok(cloneHarness(protocol as HarnessSnapshot));
}

function normalizeHarnessKind(protocol: Record<string, unknown>): Record<string, unknown> {
  return protocol.kind === "team_execution_plan"
    ? { ...protocol, kind: "team_execution_plan" }
    : protocol;
}

function validateHarnessPlannerSnapshotShape(
  protocol: Record<string, unknown>,
  kind: HarnessPlannerSnapshot["kind"],
  countField: "maxAttemptCount" | "maxRoundCount"
): Result<HarnessPlannerSnapshot, DomainWorkflowError> {
  if (Object.prototype.hasOwnProperty.call(protocol, "members")) {
    return workflowValidationError(`${kind}.members is stored in executors.json, not harness.json`);
  }
  for (const validation of [
    positiveIntegerResult(protocol[countField], `${kind}.${countField}`),
    guardrailsResult(protocol.guardrails, `${kind}.guardrails`),
    teamConfigResult(protocol.team, `${kind}.team`)
  ]) {
    if (!validation.ok) {
      return validation;
    }
  }
  return ok(cloneHarnessPlanner(protocol as HarnessPlannerSnapshot));
}

function validateSkillBindingResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const skill = recordResult(value, path);
  if (!skill.ok) return skill;
  if (skill.value.kind !== "local-snapshot" && skill.value.kind !== "local-root-installed" && skill.value.kind !== "registry-package" && skill.value.kind !== "skillMeta") {
    return workflowValidationError(`${path}.kind must be local-snapshot, local-root-installed, registry-package, or skillMeta`);
  }
  if (typeof skill.value.name !== "string" || skill.value.name.trim() === "") {
    return workflowValidationError(`${path}.name must be a non-empty string`);
  }
  if (skill.value.kind === "skillMeta") {
    const exactKeys = exactKeysResult(skill.value, ["agent", "kind", "name", "source"], path);
    if (!exactKeys.ok) return exactKeys;
    if (typeof skill.value.source !== "string" || skill.value.source.trim() === "") {
      return workflowValidationError(`${path}.source must be a non-empty string`);
    }
    if (skill.value.agent !== "codex") {
      return workflowValidationError(`${path}.agent must be codex`);
    }
    return ok(undefined);
  }
  if (skill.value.kind === "local-root-installed") {
    if (skill.value.sourcePath !== undefined && (typeof skill.value.sourcePath !== "string" || skill.value.sourcePath.trim() === "")) {
      return workflowValidationError(`${path}.sourcePath must be a non-empty string when provided`);
    }
    return ok(undefined);
  }
  if (skill.value.kind === "local-snapshot") {
    for (const key of ["sourcePath", "contentHash", "snapshotRef"]) {
      if (typeof skill.value[key] !== "string" || skill.value[key].trim() === "") {
        return workflowValidationError(`${path}.${key} must be a non-empty string`);
      }
    }
    if (skill.value.snapshotFiles !== undefined) {
      if (!Array.isArray(skill.value.snapshotFiles)) {
        return workflowValidationError(`${path}.snapshotFiles must be an array`);
      }
      for (const [index, file] of skill.value.snapshotFiles.entries()) {
        const snapshotFile = recordResult(file, `${path}.snapshotFiles[${index}]`);
        if (!snapshotFile.ok) return snapshotFile;
        if (typeof snapshotFile.value.path !== "string" || snapshotFile.value.path.trim() === "") {
          return workflowValidationError(`${path}.snapshotFiles[${index}].path must be a non-empty string`);
        }
        if (typeof snapshotFile.value.text !== "string") {
          return workflowValidationError(`${path}.snapshotFiles[${index}].text must be a string`);
        }
      }
    }
    return ok(undefined);
  }
  if (skill.value.registryKind !== "apm") {
    return workflowValidationError(`${path}.registryKind must be apm`);
  }
  for (const key of ["registry", "package", "version", "integrity", "contentHash"]) {
    if (typeof skill.value[key] !== "string" || skill.value[key].trim() === "") {
      return workflowValidationError(`${path}.${key} must be a non-empty string`);
    }
  }
  if (!isExactSemver(String(skill.value.version))) {
    return workflowValidationError(`${path}.version must be an exact semver version`);
  }
  if (skill.value.snapshotFiles !== undefined) {
    return workflowValidationError(`${path}.snapshotFiles is not supported for registry-package skills`);
  }
  return ok(undefined);
}

function validateMemberPluginBindingResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const plugin = recordResult(value, path);
  if (!plugin.ok) return plugin;
  if (plugin.value.kind !== "local-root-installed") {
    return workflowValidationError(`${path}.kind must be local-root-installed`);
  }
  if (typeof plugin.value.id !== "string" || plugin.value.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  return ok(undefined);
}

function teamConfigResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const team = recordResult(value, path);
  if (!team.ok) return team;
  const template = decodePromptTemplate(team.value.promptTemplate, `${path}.promptTemplate`);
  return template.ok ? ok(undefined) : template;
}

function memberArrayResult(value: unknown, path: string, requireNonEmpty: boolean): Result<void, DomainWorkflowError> {
  if (!Array.isArray(value)) {
    return workflowValidationError(`${path} must be an array`);
  }
  if (requireNonEmpty && value.length === 0) {
    return workflowValidationError(`${path} must include at least one Member`);
  }
  const seen = new Set<string>();
  for (const [index, member] of value.entries()) {
    const record = recordResult(member, `${path}[${index}]`);
    if (!record.ok) return record;
    const validation = memberConfigResult(record.value, `${path}[${index}]`);
    if (!validation.ok) return validation;
    const id = String(record.value.id);
    if (seen.has(id)) {
      return workflowValidationError(`${path} must not include duplicate Member ${id}`);
    }
    seen.add(id);
  }
  return ok(undefined);
}

function memberConfigResult(member: Record<string, unknown>, path: string): Result<void, DomainWorkflowError> {
  if (typeof member.id !== "string" || member.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  const promptTemplate = decodePromptTemplate(member.promptTemplate, `${path}.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  if (typeof member.model !== "string" || member.model.trim() === "") {
    return workflowValidationError(`${path}.model must be a non-empty string`);
  }
  for (const validation of [
    allowedResult(`${path}.reasoningEffort`, member.reasoningEffort, REASONING_EFFORTS),
    member.serviceTier === undefined ? ok(undefined) : allowedResult(`${path}.serviceTier`, member.serviceTier, SERVICE_TIERS),
    memberExecutionResult(member.execution, `${path}.execution`),
    memberApprovalResult(member.approval, `${path}.approval`)
  ]) {
    if (!validation.ok) {
      return validation;
    }
  }
  if (!Array.isArray(member.skills)) {
    return workflowValidationError(`${path}.skills must be an array`);
  }
  for (const [index, skill] of member.skills.entries()) {
    const validation = validateSkillBindingResult(skill, `${path}.skills[${index}]`);
    if (!validation.ok) return validation;
  }
  if (member.plugins !== undefined) {
    if (!Array.isArray(member.plugins)) {
      return workflowValidationError(`${path}.plugins must be an array`);
    }
    for (const [index, plugin] of member.plugins.entries()) {
      const validation = validateMemberPluginBindingResult(plugin, `${path}.plugins[${index}]`);
      if (!validation.ok) return validation;
    }
  }
  return ok(undefined);
}

function managerConfigResult(manager: Record<string, unknown>, path: string): Result<void, DomainWorkflowError> {
  const keys = exactKeysResult(manager, ["id", "plugins", "promptTemplate", "skills"], path);
  if (!keys.ok) return keys;
  if (typeof manager.id !== "string" || manager.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  const promptTemplate = decodePromptTemplate(manager.promptTemplate, `${path}.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  if (!Array.isArray(manager.skills)) {
    return workflowValidationError(`${path}.skills must be an array`);
  }
  for (const [index, skill] of manager.skills.entries()) {
    const validation = validateSkillBindingResult(skill, `${path}.skills[${index}]`);
    if (!validation.ok) return validation;
  }
  if (!Array.isArray(manager.plugins)) {
    return workflowValidationError(`${path}.plugins must be an array`);
  }
  for (const [index, plugin] of manager.plugins.entries()) {
    const validation = validateMemberPluginBindingResult(plugin, `${path}.plugins[${index}]`);
    if (!validation.ok) return validation;
  }
  return ok(undefined);
}

function executorEntityResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const executor = recordResult(value, path);
  if (!executor.ok) return executor;
  if (executor.value.kind === "team") {
    return teamExecutorResult(executor.value, path);
  }
  if (executor.value.kind === "member") {
    return memberExecutorResult(executor.value, path);
  }
  return workflowValidationError(`${path}.kind must be team or member`);
}

function teamExecutorResult(team: Record<string, unknown>, path: string): Result<void, DomainWorkflowError> {
  if (typeof team.id !== "string" || team.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  const planner = teamPlannerResult(team.planner, `${path}.planner`);
  if (!planner.ok) return planner;
  if (!Array.isArray(team.members)) {
    return workflowValidationError(`${path}.members must be an array`);
  }
  const seen = new Set<string>();
  for (const [index, membership] of team.members.entries()) {
    const validation = membershipResult(membership, `${path}.members[${index}]`);
    if (!validation.ok) return validation;
    const executorId = String((membership as { executorId: unknown }).executorId);
    if (seen.has(executorId)) {
      return workflowValidationError(`${path}.members must not include duplicate Membership ${executorId}`);
    }
    seen.add(executorId);
  }
  return packageLockResult(team.packageLock, `${path}.packageLock`);
}

function teamPlannerResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const planner = recordResult(value, path);
  if (!planner.ok) return planner;
  const template = decodePromptTemplate(planner.value.promptTemplate, `${path}.promptTemplate`);
  if (!template.ok) return template;
  if (planner.value.maxAttemptCount !== undefined) {
    const maxAttemptCount = positiveIntegerResult(planner.value.maxAttemptCount, `${path}.maxAttemptCount`);
    if (!maxAttemptCount.ok) return maxAttemptCount;
  }
  return guardrailsResult(planner.value.guardrails, `${path}.guardrails`);
}

function membershipResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const membership = recordResult(value, path);
  if (!membership.ok) return membership;
  if (typeof membership.value.executorId !== "string" || membership.value.executorId.trim() === "") {
    return workflowValidationError(`${path}.executorId must be a non-empty string`);
  }
  return visibleProfileResult(membership.value.visibleProfile, `${path}.visibleProfile`);
}

function visibleProfileResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const profile = recordResult(value, path);
  if (!profile.ok) return profile;
  const kind = allowedResult(`${path}.kind`, profile.value.kind, ["team", "member"] as const);
  if (!kind.ok) return kind;
  for (const key of ["label", "summary"]) {
    if (profile.value[key] !== undefined && (typeof profile.value[key] !== "string" || String(profile.value[key]).trim() === "")) {
      return workflowValidationError(`${path}.${key} must be a non-empty string when provided`);
    }
  }
  if (profile.value.capabilities !== undefined) {
    if (!Array.isArray(profile.value.capabilities)) {
      return workflowValidationError(`${path}.capabilities must be an array`);
    }
    for (const [index, capability] of profile.value.capabilities.entries()) {
      if (typeof capability !== "string" || capability.trim() === "") {
        return workflowValidationError(`${path}.capabilities[${index}] must be a non-empty string`);
      }
    }
  }
  return ok(undefined);
}

function memberExecutorResult(member: Record<string, unknown>, path: string): Result<void, DomainWorkflowError> {
  if (typeof member.id !== "string" || member.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  const promptTemplate = decodePromptTemplate(member.promptTemplate, `${path}.promptTemplate`);
  if (!promptTemplate.ok) return promptTemplate;
  if (!Array.isArray(member.resources)) {
    return workflowValidationError(`${path}.resources must be an array`);
  }
  for (const [index, resource] of member.resources.entries()) {
    const validation = resourceBindingResult(resource, `${path}.resources[${index}]`);
    if (!validation.ok) return validation;
  }
  const runtimePolicy = runtimePolicyResult(member.runtimePolicy, `${path}.runtimePolicy`);
  if (!runtimePolicy.ok) return runtimePolicy;
  return packageLockResult(member.packageLock, `${path}.packageLock`);
}

function runtimePolicyResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const policy = recordResult(value, path);
  if (!policy.ok) return policy;
  if (typeof policy.value.model !== "string" || policy.value.model.trim() === "") {
    return workflowValidationError(`${path}.model must be a non-empty string`);
  }
  for (const validation of [
    allowedResult(`${path}.reasoningEffort`, policy.value.reasoningEffort, REASONING_EFFORTS),
    policy.value.serviceTier === undefined ? ok(undefined) : allowedResult(`${path}.serviceTier`, policy.value.serviceTier, SERVICE_TIERS),
    memberExecutionResult(policy.value.execution, `${path}.execution`),
    memberApprovalResult(policy.value.approval, `${path}.approval`)
  ]) {
    if (!validation.ok) {
      return validation;
    }
  }
  return ok(undefined);
}

function resourceEntityResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const resource = recordResult(value, path);
  if (!resource.ok) return resource;
  if (typeof resource.value.id !== "string" || resource.value.id.trim() === "") {
    return workflowValidationError(`${path}.id must be a non-empty string`);
  }
  const binding = resourceBindingResult(resource.value.binding, `${path}.binding`);
  if (!binding.ok) return binding;
  return packageLockResult(resource.value.packageLock, `${path}.packageLock`);
}

function resourceBindingResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const binding = recordResult(value, path);
  if (!binding.ok) return binding;
  if (binding.value.kind === "skill") {
    return validateSkillBindingResult(binding.value.skill, `${path}.skill`);
  }
  if (binding.value.kind === "plugin") {
    return validateMemberPluginBindingResult(binding.value.plugin, `${path}.plugin`);
  }
  if (binding.value.kind === "package") {
    return packageLockResult(binding.value.lock, `${path}.lock`);
  }
  return workflowValidationError(`${path}.kind must be skill, plugin, or package`);
}

function packageLockResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  const lock = recordResult(value, path);
  if (!lock.ok) return lock;
  for (const key of ["origin", "kind", "key", "version", "integrity"]) {
    if (typeof lock.value[key] !== "string" || String(lock.value[key]).trim() === "") {
      return workflowValidationError(`${path}.${key} must be a non-empty string`);
    }
  }
  return ok(undefined);
}

function memberExecutionResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const execution = recordResult(value, path);
  if (!execution.ok) return execution;
  const kind = allowedResult(`${path}.kind`, execution.value.kind, MEMBER_EXECUTION_KINDS);
  if (!kind.ok) return kind;
  const network = allowedResult(`${path}.network`, execution.value.network, MEMBER_EXECUTION_NETWORKS);
  return network.ok ? ok(undefined) : network;
}

function memberApprovalResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  const approval = recordResult(value, path);
  if (!approval.ok) return approval;
  const policy = allowedResult(`${path}.policy`, approval.value.policy, MEMBER_APPROVAL_POLICIES);
  if (!policy.ok) return policy;
  if (approval.value.policy === "on_request") {
    const reviewer = allowedResult(`${path}.reviewer`, approval.value.reviewer, MEMBER_APPROVAL_REVIEWERS);
    return reviewer.ok ? ok(undefined) : reviewer;
  }
  return "reviewer" in approval.value
    ? workflowValidationError(`${path}.reviewer is only allowed when policy is on_request`)
    : ok(undefined);
}

function guardrailsResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!Array.isArray(value)) {
    return workflowValidationError(`${path} must be an array`);
  }
  for (const [index, entry] of value.entries()) {
    const guardrail = recordResult(entry, `${path}[${index}]`);
    if (!guardrail.ok) return guardrail;
    if (typeof guardrail.value.name !== "string" || guardrail.value.name.trim() === "") {
      return workflowValidationError(`${path}[${index}].name must be a non-empty string`);
    }
    const scope = allowedResult(`${path}[${index}].scope`, guardrail.value.scope, GUARDRAIL_SCOPES);
    if (!scope.ok) return scope;
    if (typeof guardrail.value.rule !== "string" || guardrail.value.rule.trim() === "") {
      return workflowValidationError(`${path}[${index}].rule must be a non-empty string`);
    }
    const severity = allowedResult(`${path}[${index}].severity`, guardrail.value.severity, GUARDRAIL_SEVERITIES);
    if (!severity.ok) return severity;
  }
  return ok(undefined);
}

function recordResult(value: unknown, path: string): Result<Record<string, unknown>, DomainWorkflowError> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ok(value as Record<string, unknown>)
    : workflowValidationError(`${path} must be an object`);
}

function exactKeysResult(record: Record<string, unknown>, allowedKeys: readonly string[], path: string): Result<void, DomainWorkflowError> {
  const missing = allowedKeys.filter(key => !(key in record));
  if (missing.length > 0) {
    return workflowValidationError(`${path} is missing required keys: ${missing.join(", ")}`);
  }
  const extra = Object.keys(record).filter(key => !allowedKeys.includes(key));
  return extra.length > 0
    ? workflowValidationError(`${path} has unsupported keys: ${extra.join(", ")}`)
    : ok(undefined);
}

function positiveIntegerResult(value: unknown, path: string): Result<void, DomainWorkflowError> {
  return Number.isInteger(value) && Number(value) >= 1
    ? ok(undefined)
    : workflowValidationError(`${path} must be a positive integer`);
}

function allowedResult<const T extends string>(path: string, value: unknown, allowed: readonly T[]): Result<T, DomainWorkflowError> {
  return typeof value === "string" && allowed.includes(value as T)
    ? ok(value as T)
    : workflowValidationError(`${path} must be one of: ${allowed.join(", ")}`);
}

function chainResult<T, U>(result: Result<T, DomainWorkflowError>, next: () => Result<U, DomainWorkflowError>): Result<U, DomainWorkflowError> {
  return result.ok ? next() : result;
}

function workflowValidationError(message: string): Result<never, DomainWorkflowError> {
  return err({ type: "DomainWorkflowError", message });
}

function requireHarnessMemberConfig(protocol: HarnessSnapshot, executorId: string): MemberConfig {
  const member = getHarnessMemberConfig(protocol, executorId);
  if (!member) {
    throw new DomainInvariantError(`Unknown Member ${executorId} for Harness ${protocol.kind}`);
  }
  return member;
}

function validateHubPackageLock(lock: HubPackageLock, expectedKind: HubPackageKind, label: string): void {
  assertText(lock.origin, `${label} origin must be non-empty`);
  if (lock.kind !== expectedKind) {
    throw new DomainInvariantError(`${label} kind must be ${expectedKind}`);
  }
  assertText(lock.key, `${label} key must be non-empty`);
  assertText(lock.version, `${label} version must be non-empty`);
  assertText(lock.integrity, `${label} integrity must be non-empty`);
}

function validateTeamConfig(value: unknown, path: string): void {
  const team = requireRecord(value, path);
  assertValidPromptTemplate(team.promptTemplate, `${path}.promptTemplate`);
}

function validateMemberArray(value: unknown, path: string, requireNonEmpty: boolean): void {
  if (!Array.isArray(value)) {
    throw new DomainInvariantError(`${path} must be an array`);
  }
  if (requireNonEmpty && value.length === 0) {
    throw new DomainInvariantError(`${path} must include at least one Member`);
  }
  const seen = new Set<string>();
  value.forEach((member, index) => {
    const record = requireRecord(member, `${path}[${index}]`);
    assertValidMemberConfig(record, `${path}[${index}]`);
    const id = String(record.id);
    if (seen.has(id)) {
      throw new DomainInvariantError(`${path} must not include duplicate Member ${id}`);
    }
    seen.add(id);
  });
}

function assertValidMemberConfig(member: Record<string, unknown>, path: string): void {
  if (typeof member.id !== "string" || member.id.trim() === "") {
    throw new DomainInvariantError(`${path}.id must be a non-empty string`);
  }
  assertValidPromptTemplate(member.promptTemplate, `${path}.promptTemplate`);
  if (typeof member.model !== "string" || member.model.trim() === "") {
    throw new DomainInvariantError(`${path}.model must be a non-empty string`);
  }
  assertAllowed(`${path}.reasoningEffort`, member.reasoningEffort, REASONING_EFFORTS);
  if (member.serviceTier !== undefined) {
    assertAllowed(`${path}.serviceTier`, member.serviceTier, SERVICE_TIERS);
  }
  validateMemberExecution(member.execution, `${path}.execution`);
  validateMemberApproval(member.approval, `${path}.approval`);
  if (!Array.isArray(member.skills)) {
    throw new DomainInvariantError(`${path}.skills must be an array`);
  }
  member.skills.forEach((skill, index) => validateSkillBinding(skill, `${path}.skills[${index}]`));
  if (member.plugins !== undefined) {
    if (!Array.isArray(member.plugins)) {
      throw new DomainInvariantError(`${path}.plugins must be an array`);
    }
    member.plugins.forEach((plugin, index) => validateMemberPluginBinding(plugin, `${path}.plugins[${index}]`));
  }
}

function validateMemberPluginBinding(value: unknown, path: string): void {
  const validation = validateMemberPluginBindingResult(value, path);
  if (!validation.ok) {
    throw new DomainInvariantError(validation.error.message);
  }
}

function validateMemberExecution(value: unknown, path: string): void {
  const execution = requireRecord(value, path);
  assertAllowed(`${path}.kind`, execution.kind, MEMBER_EXECUTION_KINDS);
  assertAllowed(`${path}.network`, execution.network, MEMBER_EXECUTION_NETWORKS);
}

function validateMemberApproval(value: unknown, path: string): void {
  const approval = requireRecord(value, path);
  assertAllowed(`${path}.policy`, approval.policy, MEMBER_APPROVAL_POLICIES);
  if (approval.policy === "on_request") {
    assertAllowed(`${path}.reviewer`, approval.reviewer, MEMBER_APPROVAL_REVIEWERS);
    return;
  }
  if ("reviewer" in approval) {
    throw new DomainInvariantError(`${path}.reviewer is only allowed when policy is on_request`);
  }
}

function validateGuardrails(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new DomainInvariantError(`${path} must be an array`);
  }
  value.forEach((entry, index) => {
    const guardrail = requireRecord(entry, `${path}[${index}]`);
    if (typeof guardrail.name !== "string" || guardrail.name.trim() === "") {
      throw new DomainInvariantError(`${path}[${index}].name must be a non-empty string`);
    }
    assertAllowed(`${path}[${index}].scope`, guardrail.scope, GUARDRAIL_SCOPES);
    if (typeof guardrail.rule !== "string" || guardrail.rule.trim() === "") {
      throw new DomainInvariantError(`${path}[${index}].rule must be a non-empty string`);
    }
    assertAllowed(`${path}[${index}].severity`, guardrail.severity, GUARDRAIL_SEVERITIES);
  });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainInvariantError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertPositiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new DomainInvariantError(`${path} must be a positive integer`);
  }
}

function assertAllowed<const T extends string>(path: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainInvariantError(`${path} must be one of: ${allowed.join(", ")}`);
  }
}

function assertText(value: string, message: string): void {
  if (value.trim() === "") {
    throw new DomainInvariantError(message);
  }
}

function assertString(value: unknown, message: string): void {
  if (typeof value !== "string") {
    throw new DomainInvariantError(message);
  }
}

function cloneMemberConfig(member: MemberConfig): MemberConfig {
  return {
    ...member,
    promptTemplate: { ...member.promptTemplate },
    skills: cloneSkills(member.skills),
    plugins: clonePlugins(member.plugins ?? []),
    execution: cloneMemberExecution(member.execution),
    approval: cloneMemberApproval(member.approval)
  };
}

function cloneManagerConfig(manager: ManagerConfig): ManagerConfig {
  return {
    ...manager,
    promptTemplate: { ...manager.promptTemplate },
    skills: cloneSkills(manager.skills),
    plugins: clonePlugins(manager.plugins)
  };
}

function cloneMemberExecution(execution: MemberExecutionConstraint): MemberExecutionConstraint {
  return { ...execution };
}

function cloneMemberApproval(approval: MemberApprovalConstraint): MemberApprovalConstraint {
  return { ...approval };
}

function cloneSkills(skills: SkillBinding[] = []): SkillBinding[] {
  return skills.map(cloneSkill);
}

function cloneSkill(skill: SkillBinding): SkillBinding {
  if (skill.kind === "local-snapshot") {
    return {
      ...skill,
      snapshotFiles: skill.snapshotFiles?.map(file => ({ ...file }))
    };
  }
  return { ...skill };
}

function clonePlugins(plugins: MemberPluginBinding[] = []): MemberPluginBinding[] {
  return plugins.map(plugin => ({ ...plugin }));
}

function isExactSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}
