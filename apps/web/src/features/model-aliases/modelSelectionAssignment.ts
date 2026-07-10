import type {
  DirectProviderModelSelection,
  ExecutorEntity,
  ManagerConfig,
  MemberConfig,
  ModelSelection
} from "@/shared/api/bridgeTypes";

export type ModelSelectionAssignment =
  | { mode: "alias"; aliasId: string }
  | { mode: "direct"; provider: DirectProviderModelSelection };

export function modelSelectionFromAssignment(assignment: ModelSelectionAssignment): ModelSelection {
  return assignment.mode === "alias"
    ? { kind: "alias", aliasId: assignment.aliasId as Extract<ModelSelection, { kind: "alias" }>["aliasId"] }
    : { kind: "direct", provider: cloneDirectProvider(assignment.provider) };
}

export function assignManagerModelSelection(
  manager: ManagerConfig,
  assignment: ModelSelectionAssignment
): ManagerConfig {
  return {
    ...manager,
    promptTemplate: { ...manager.promptTemplate },
    skills: manager.skills.map(skill => ({ ...skill })),
    plugins: manager.plugins.map(plugin => ({ ...plugin })),
    modelSelection: modelSelectionFromAssignment(assignment)
  };
}

export function assignMemberModelSelection(
  member: MemberConfig,
  assignment: ModelSelectionAssignment
): MemberConfig {
  const modelSelection = modelSelectionFromAssignment(assignment);
  return {
    ...member,
    promptTemplate: { ...member.promptTemplate },
    skills: member.skills.map(skill => ({ ...skill })),
    plugins: member.plugins.map(plugin => ({ ...plugin })),
    ...legacyMemberModelFields(member, modelSelection),
    execution: { ...member.execution },
    approval: { ...member.approval },
    modelSelection
  };
}

export function assignExecutorModelSelection(
  executor: ExecutorEntity,
  assignment: ModelSelectionAssignment
): ExecutorEntity {
  if (executor.kind !== "member") {
    return executor;
  }
  const modelSelection = modelSelectionFromAssignment(assignment);
  return {
    ...executor,
    promptTemplate: { ...executor.promptTemplate },
    resources: executor.resources.map(resource => ({ ...resource })),
    runtimePolicy: {
      ...executor.runtimePolicy,
      ...legacyRuntimePolicyModelFields(executor.runtimePolicy, modelSelection),
      execution: { ...executor.runtimePolicy.execution },
      approval: { ...executor.runtimePolicy.approval },
      modelSelection
    }
  };
}

function legacyMemberModelFields(member: MemberConfig, selection: ModelSelection): Pick<MemberConfig, "model" | "reasoningEffort" | "serviceTier"> {
  if (selection.kind !== "direct") {
    return {
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier
    };
  }
  return {
    model: selection.provider.model as MemberConfig["model"],
    reasoningEffort: (selection.provider.reasoningEffort ?? "default") as MemberConfig["reasoningEffort"],
    serviceTier: (selection.provider.serviceTier ?? "default") as MemberConfig["serviceTier"]
  };
}

function legacyRuntimePolicyModelFields(
  policy: Extract<ExecutorEntity, { kind: "member" }>["runtimePolicy"],
  selection: ModelSelection
): Pick<Extract<ExecutorEntity, { kind: "member" }>["runtimePolicy"], "model" | "reasoningEffort" | "serviceTier"> {
  if (selection.kind !== "direct") {
    return {
      model: policy.model,
      reasoningEffort: policy.reasoningEffort,
      serviceTier: policy.serviceTier
    };
  }
  return {
    model: selection.provider.model as NonNullable<typeof policy.model>,
    reasoningEffort: selection.provider.reasoningEffort ?? "default",
    serviceTier: selection.provider.serviceTier ?? "default"
  };
}

function cloneDirectProvider(provider: DirectProviderModelSelection): DirectProviderModelSelection {
  return JSON.parse(JSON.stringify(provider)) as DirectProviderModelSelection;
}
