import type { RegistryResult, RunnerValueSchema } from "./model.ts";
import { REGISTRY_DEFINITION_SCHEMA } from "./model.ts";
import { createDefinitionRegistry, createRegistryEntry } from "./registry.ts";

export const BUNDLED_RUNNER_TYPE_ORIGIN = "hunsu" as const;
export const BUNDLED_PLAYER_TYPE_KEY = "runner.player" as const;
export const BUNDLED_TEAM_TYPE_KEY = "runner.team" as const;
export const BUNDLED_RUNNER_TYPE_VERSION = "1.0.0" as const;

export function createBundledDefinitionRegistry(): RegistryResult<import("./model.ts").DefinitionRegistry> {
  const executor = createRegistryEntry(BUNDLED_RUNNER_TYPE_ORIGIN, {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "resource",
    key: "resource.hunsu-codex-executor",
    version: "1.0.0",
    resource: { type: "plugin", name: "hunsu", version: "0.2.0" }
  });
  if (!executor.ok) return executor;

  const player = createRegistryEntry(BUNDLED_RUNNER_TYPE_ORIGIN, {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "runner_type",
    key: BUNDLED_PLAYER_TYPE_KEY,
    version: BUNDLED_RUNNER_TYPE_VERSION,
    runnerType: {
      displayName: "Player",
      valueSchema: playerValueSchema(),
      executor: {
        schema: "hunsu.runner-executor.v1",
        resource: executor.value.lock,
        entrypoint: "bundled.player.v1"
      }
    }
  });
  if (!player.ok) return player;

  const team = createRegistryEntry(BUNDLED_RUNNER_TYPE_ORIGIN, {
    schema: REGISTRY_DEFINITION_SCHEMA,
    kind: "runner_type",
    key: BUNDLED_TEAM_TYPE_KEY,
    version: BUNDLED_RUNNER_TYPE_VERSION,
    runnerType: {
      displayName: "Team",
      valueSchema: teamValueSchema(),
      executor: {
        schema: "hunsu.runner-executor.v1",
        resource: executor.value.lock,
        entrypoint: "bundled.team.v1"
      }
    }
  });
  if (!team.ok) return team;
  return createDefinitionRegistry([executor.value, player.value, team.value]);
}

export function playerValueSchema(): RunnerValueSchema {
  return objectSchema({
    promptTemplate: textSchema(1, 100_000),
    resources: resourcesSchema(),
    runtimePolicy: runtimePolicySchema()
  });
}

export function teamValueSchema(): RunnerValueSchema {
  return objectSchema({
    strategy: objectSchema({
      mode: enumSchema("sequence", "parallel", "coordinated"),
      promptTemplate: textSchema(1, 100_000),
      maxRounds: integerSchema(1, 100)
    }),
    players: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: false,
      items: objectSchema({
        name: textSchema(1, 256),
        role: textSchema(1, 1_000),
        order: integerSchema(1, 64),
        promptTemplate: textSchema(1, 100_000),
        resources: resourcesSchema(),
        runtimePolicy: runtimePolicySchema()
      })
    }
  });
}

function resourcesSchema(): RunnerValueSchema {
  return {
    type: "array",
    minItems: 0,
    maxItems: 256,
    uniqueItems: true,
    items: objectSchema({
      kind: enumSchema("skill", "plugin"),
      name: textSchema(1, 256),
      reference: textSchema(1, 2_048)
    })
  };
}

function runtimePolicySchema(): RunnerValueSchema {
  return objectSchema({
    filesystem: enumSchema("read_only", "worktree_write"),
    network: enumSchema("disabled", "enabled"),
    approvals: enumSchema("never", "on_request")
  });
}

function objectSchema(properties: Readonly<Record<string, RunnerValueSchema>>): RunnerValueSchema {
  return { type: "object", properties, required: Object.keys(properties).sort(), additionalProperties: false };
}

function textSchema(minLength: number, maxLength: number): RunnerValueSchema {
  return { type: "string", minLength, maxLength };
}

function integerSchema(minimum: number, maximum: number): RunnerValueSchema {
  return { type: "integer", minimum, maximum };
}

function enumSchema(first: string, ...rest: string[]): RunnerValueSchema {
  return { type: "string_enum", values: [first, ...rest] };
}
