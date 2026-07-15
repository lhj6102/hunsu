import type { RunContract } from "@hunsu/plugin-contract";
import {
  decodeRunnerValue,
  type RunnerValue,
  type RunnerValueTypeRegistry
} from "@hunsu/protocol";
import {
  BUNDLED_PLAYER_TYPE_KEY,
  BUNDLED_RUNNER_TYPE_ORIGIN,
  BUNDLED_RUNNER_TYPE_VERSION,
  BUNDLED_TEAM_TYPE_KEY,
  createBundledDefinitionRegistry,
  createRunnerValueTypeRegistry,
  decodeDefinitionRegistry,
  resolveRegistryDefinition,
  resolveRunnerTypeDefinition,
  type DefinitionLock,
  type DefinitionRegistry,
  type RegistryError,
  type RunnerExecutorContract
} from "@hunsu/protocol-registry";

const trustedRunnerRuntimeBrand: unique symbol = Symbol("hunsu.trusted-runner-runtime");

export type RunnerExecution = {
  readonly instructions: string;
  readonly toolPolicy: RunContract["toolPolicy"];
};

export type RunnerAdapterResult =
  | { readonly ok: true; readonly value: RunnerExecution }
  | { readonly ok: false; readonly error: { readonly message: string } };

export type TrustedRunnerExecutorAdapter = {
  /**
   * This is metadata copied from a trusted Registry definition at composition
   * time. The implementation itself is local application code and is never
   * serialized into Hunsu state.
   */
  readonly executor: RunnerExecutorContract;
  readonly execute: (runner: RunnerValue) => RunnerAdapterResult;
};

export type RunnerRuntimeErrorCode =
  | "invalid_registry"
  | "duplicate_executor_adapter"
  | "executor_lock_mismatch"
  | "unregistered_executor_adapter"
  | "missing_executor_adapter"
  | "runner_type_mismatch"
  | "executor_failure"
  | "invalid_executor_output";

export type RunnerRuntimeError = {
  readonly code: RunnerRuntimeErrorCode;
  readonly message: string;
};

export type RunnerRuntimeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: RunnerRuntimeError };

export type TrustedRunnerRuntime = {
  readonly [trustedRunnerRuntimeBrand]: true;
  readonly registry: DefinitionRegistry;
  readonly runnerTypes: RunnerValueTypeRegistry;
  readonly execute: (runner: RunnerValue) => RunnerRuntimeResult<RunnerExecution>;
};

export function runnerAdapterOk(value: RunnerExecution): RunnerAdapterResult {
  return { ok: true, value };
}

export function runnerAdapterFailure(message: string): RunnerAdapterResult {
  return { ok: false, error: { message } };
}

export function createTrustedRunnerRuntime(input: {
  readonly registry: unknown;
  readonly adapters: readonly TrustedRunnerExecutorAdapter[];
}): RunnerRuntimeResult<TrustedRunnerRuntime> {
  const decodedRegistry = decodeDefinitionRegistry(input.registry, "$.registry");
  if (!decodedRegistry.ok) return registryFailure("invalid_registry", decodedRegistry.error);
  const registry = decodedRegistry.value;
  const decodedRunnerTypes = createRunnerValueTypeRegistry(registry);
  if (!decodedRunnerTypes.ok) return registryFailure("invalid_registry", decodedRunnerTypes.error);
  const runnerTypes = decodedRunnerTypes.value;
  const expectedExecutors = uniqueExecutors(registry);
  if (expectedExecutors.length === 0) {
    return failure("invalid_registry", "A trusted Runner runtime requires at least one registered Runner type.");
  }

  const adapters = new Map<string, TrustedRunnerExecutorAdapter>();
  for (let index = 0; index < input.adapters.length; index += 1) {
    const adapter = input.adapters[index]!;
    const validated = validateAdapter(registry, expectedExecutors, adapter, index);
    if (!validated.ok) return validated;
    const key = executorKey(adapter.executor);
    if (adapters.has(key)) {
      return failure("duplicate_executor_adapter", `Trusted Runner executor adapter ${executorLabel(adapter.executor)} is registered more than once.`);
    }
    adapters.set(key, adapter);
  }

  for (const executor of expectedExecutors) {
    if (!adapters.has(executorKey(executor))) {
      return failure("missing_executor_adapter", `No trusted local executor adapter is registered for ${executorLabel(executor)}.`);
    }
  }

  return {
    ok: true,
    value: {
      [trustedRunnerRuntimeBrand]: true,
      registry,
      runnerTypes,
      execute(runner) {
        const resolved = resolveRunnerTypeDefinition(registry, runner.type);
        if (!resolved.ok) return registryFailure("runner_type_mismatch", resolved.error);
        const decodedRunner = decodeRunnerValue(runner, runnerTypes, "runner");
        if (!decodedRunner.ok) {
          return failure("runner_type_mismatch", `${decodedRunner.error.path}: ${decodedRunner.error.message}`);
        }
        const executor = resolved.value.definition.runnerType.executor;
        const adapter = adapters.get(executorKey(executor));
        if (!adapter) {
          return failure("missing_executor_adapter", `No trusted local executor adapter is registered for ${executorLabel(executor)}.`);
        }
        let result: RunnerAdapterResult;
        try {
          result = adapter.execute(decodedRunner.value);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The trusted executor adapter threw an unknown value.";
          return failure("executor_failure", `${executorLabel(executor)} failed: ${message}`);
        }
        if (!result.ok) return failure("executor_failure", `${executorLabel(executor)} failed: ${result.error.message}`);
        return validateExecution(result.value, executor);
      }
    }
  };
}

/**
 * Resolve the built-in adapters only when the supplied Registry contains the
 * exact official Player and Team definition locks. This supports composing
 * the bundled types with additional trusted custom types without weakening
 * either lock boundary.
 */
export function createBundledRunnerExecutorAdapters(
  registryValue: unknown
): RunnerRuntimeResult<readonly TrustedRunnerExecutorAdapter[]> {
  const registry = decodeDefinitionRegistry(registryValue, "$.registry");
  if (!registry.ok) return registryFailure("invalid_registry", registry.error);
  const official = createBundledDefinitionRegistry();
  if (!official.ok) return registryFailure("invalid_registry", official.error);

  const player = exactBundledRunnerDefinition(registry.value, official.value, BUNDLED_PLAYER_TYPE_KEY);
  if (!player.ok) return player;
  const team = exactBundledRunnerDefinition(registry.value, official.value, BUNDLED_TEAM_TYPE_KEY);
  if (!team.ok) return team;

  return {
    ok: true,
    value: [
      {
        executor: player.value,
        execute(runner) {
          const payload = runner.value as PlayerRunnerPayload;
          return runnerAdapterOk({ instructions: payload.promptTemplate, toolPolicy: payload.runtimePolicy });
        }
      },
      {
        executor: team.value,
        execute(runner) {
          const payload = runner.value as TeamRunnerPayload;
          const policies = payload.players.map(playerValue => playerValue.runtimePolicy);
          return runnerAdapterOk({
            instructions: payload.strategy.promptTemplate,
            toolPolicy: {
              filesystem: policies.some(policy => policy.filesystem === "worktree_write") ? "worktree_write" : "read_only",
              network: policies.some(policy => policy.network === "enabled") ? "enabled" : "disabled",
              approvals: policies.some(policy => policy.approvals === "on_request") ? "on_request" : "never"
            }
          });
        }
      }
    ]
  };
}

function createDefaultRuntime(): TrustedRunnerRuntime {
  const registry = createBundledDefinitionRegistry();
  if (!registry.ok) throw new Error(`Bundled Runner Registry is invalid: ${registryErrorMessage(registry.error)}`);
  const adapters = createBundledRunnerExecutorAdapters(registry.value);
  if (!adapters.ok) throw new Error(`Bundled Runner adapters are invalid: ${adapters.error.message}`);
  const runtime = createTrustedRunnerRuntime({ registry: registry.value, adapters: adapters.value });
  if (!runtime.ok) throw new Error(`Bundled Runner runtime is invalid: ${runtime.error.message}`);
  return runtime.value;
}

export const bundledRunnerRuntime: TrustedRunnerRuntime = createDefaultRuntime();

function exactBundledRunnerDefinition(
  registry: DefinitionRegistry,
  official: DefinitionRegistry,
  key: typeof BUNDLED_PLAYER_TYPE_KEY | typeof BUNDLED_TEAM_TYPE_KEY
): RunnerRuntimeResult<RunnerExecutorContract> {
  const expected = runnerDefinition(official, key);
  if (!expected) return failure("invalid_registry", `The official bundled Registry is missing ${key}.`);
  const candidate = registry.entries.find(entry =>
    entry.definition.kind === "runner_type"
    && entry.lock.origin === BUNDLED_RUNNER_TYPE_ORIGIN
    && entry.lock.key === key
    && entry.lock.version === BUNDLED_RUNNER_TYPE_VERSION
  );
  if (!candidate || candidate.definition.kind !== "runner_type") {
    return failure("missing_executor_adapter", `The Registry does not contain the exact bundled Runner type ${key}.`);
  }
  if (candidate.lock.integrity !== expected.lock.integrity) {
    return failure("executor_lock_mismatch", `Bundled Runner type ${key} does not match its official integrity lock.`);
  }
  return { ok: true, value: candidate.definition.runnerType.executor };
}

function runnerDefinition(registry: DefinitionRegistry, key: string) {
  return registry.entries.find(entry =>
    entry.definition.kind === "runner_type"
    && entry.lock.origin === BUNDLED_RUNNER_TYPE_ORIGIN
    && entry.lock.key === key
    && entry.lock.version === BUNDLED_RUNNER_TYPE_VERSION
  );
}

function uniqueExecutors(registry: DefinitionRegistry): readonly RunnerExecutorContract[] {
  const executors = new Map<string, RunnerExecutorContract>();
  for (const entry of registry.entries) {
    if (entry.definition.kind !== "runner_type") continue;
    const executor = entry.definition.runnerType.executor;
    executors.set(executorKey(executor), executor);
  }
  return [...executors.values()];
}

function validateAdapter(
  registry: DefinitionRegistry,
  expectedExecutors: readonly RunnerExecutorContract[],
  adapter: TrustedRunnerExecutorAdapter,
  index: number
): RunnerRuntimeResult<true> {
  if (!isExactExecutorObject(adapter.executor)) {
    return failure("executor_lock_mismatch", `Trusted executor adapter ${index} does not declare an exact hunsu.runner-executor.v1 contract.`);
  }
  const resource = resolveRegistryDefinition(registry, adapter.executor.resource);
  if (!resource.ok) {
    return registryFailure(resource.error.type === "RegistryIntegrityError" ? "executor_lock_mismatch" : "unregistered_executor_adapter", resource.error);
  }
  if (resource.value.kind !== "resource") {
    return failure("executor_lock_mismatch", `Trusted executor adapter ${index} does not lock a resource definition.`);
  }
  if (expectedExecutors.some(expected => sameExecutor(expected, adapter.executor))) return { ok: true, value: true };
  if (expectedExecutors.some(expected => sameExecutorIdentity(expected, adapter.executor))) {
    return failure("executor_lock_mismatch", `Trusted executor adapter ${executorLabel(adapter.executor)} does not match the Registry integrity lock.`);
  }
  return failure("unregistered_executor_adapter", `Trusted executor adapter ${executorLabel(adapter.executor)} is not referenced by a registered Runner type.`);
}

function validateExecution(value: unknown, executor: RunnerExecutorContract): RunnerRuntimeResult<RunnerExecution> {
  if (!isRecord(value) || !hasExactKeys(value, ["instructions", "toolPolicy"])) {
    return failure("invalid_executor_output", `${executorLabel(executor)} must return exactly instructions and toolPolicy.`);
  }
  if (typeof value.instructions !== "string" || value.instructions.trim() === "" || value.instructions.length > 100_000) {
    return failure("invalid_executor_output", `${executorLabel(executor)} returned invalid instructions.`);
  }
  const policy = value.toolPolicy;
  if (!isRecord(policy) || !hasExactKeys(policy, ["approvals", "filesystem", "network"])) {
    return failure("invalid_executor_output", `${executorLabel(executor)} returned an invalid toolPolicy shape.`);
  }
  if (policy.filesystem !== "read_only" && policy.filesystem !== "worktree_write") {
    return failure("invalid_executor_output", `${executorLabel(executor)} returned an invalid filesystem policy.`);
  }
  if (policy.network !== "disabled" && policy.network !== "enabled") {
    return failure("invalid_executor_output", `${executorLabel(executor)} returned an invalid network policy.`);
  }
  if (policy.approvals !== "never" && policy.approvals !== "on_request") {
    return failure("invalid_executor_output", `${executorLabel(executor)} returned an invalid approvals policy.`);
  }
  return {
    ok: true,
    value: {
      instructions: value.instructions,
      toolPolicy: {
        filesystem: policy.filesystem,
        network: policy.network,
        approvals: policy.approvals
      }
    }
  };
}

function isExactExecutorObject(value: RunnerExecutorContract): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["entrypoint", "resource", "schema"])
    && value.schema === "hunsu.runner-executor.v1"
    && typeof value.entrypoint === "string"
    && value.entrypoint.trim() !== ""
    && value.entrypoint.length <= 256;
}

function sameExecutor(left: RunnerExecutorContract, right: RunnerExecutorContract): boolean {
  return left.schema === right.schema
    && left.entrypoint === right.entrypoint
    && left.resource.integrity === right.resource.integrity
    && sameLockIdentity(left.resource, right.resource);
}

function sameExecutorIdentity(left: RunnerExecutorContract, right: RunnerExecutorContract): boolean {
  return left.schema === right.schema
    && left.entrypoint === right.entrypoint
    && sameLockIdentity(left.resource, right.resource);
}

function sameLockIdentity(left: DefinitionLock, right: DefinitionLock): boolean {
  return left.origin === right.origin
    && left.kind === right.kind
    && left.key === right.key
    && left.version === right.version;
}

function executorKey(executor: RunnerExecutorContract): string {
  return JSON.stringify([
    executor.schema,
    executor.resource.origin,
    executor.resource.kind,
    executor.resource.key,
    executor.resource.version,
    executor.resource.integrity,
    executor.entrypoint
  ]);
}

function executorLabel(executor: RunnerExecutorContract): string {
  return `${executor.resource.origin}/${executor.resource.key}@${executor.resource.version}#${executor.entrypoint}`;
}

function registryFailure<Value>(code: RunnerRuntimeErrorCode, error: RegistryError): RunnerRuntimeResult<Value> {
  return failure(code, registryErrorMessage(error));
}

function registryErrorMessage(error: RegistryError): string {
  if (error.type === "RegistryIntegrityError") {
    return `${error.path}: expected ${error.expected} but resolved ${error.actual}`;
  }
  return `${error.path}: ${error.message}`;
}

function failure<Value>(code: RunnerRuntimeErrorCode, message: string): RunnerRuntimeResult<Value> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

type ToolPolicy = RunContract["toolPolicy"];

type PlayerRunnerPayload = {
  readonly promptTemplate: string;
  readonly runtimePolicy: ToolPolicy;
};

type TeamRunnerPayload = {
  readonly strategy: { readonly promptTemplate: string };
  readonly players: readonly { readonly runtimePolicy: ToolPolicy }[];
};
