import type {
  CanonicalJsonValue,
  Result,
  RunnerTypeIntegrity,
  RunnerTypeLock,
  RunnerValueTypeDecoder,
  RunnerValueTypeRegistry
} from "@hunsu/protocol";

declare const registryBrand: unique symbol;

export const REGISTRY_DEFINITION_SCHEMA = "hunsu.registry-definition.v2" as const;
export const REGISTRY_SNAPSHOT_SCHEMA = "hunsu.registry-snapshot.v2" as const;
export const REGISTRY_INTEGRITY_PREFIX = "hunsu-registry-definition-v2:sha256:" as const;
export const RUNNER_TYPE_INTEGRITY_PREFIX = "hunsu-runner-type-v1:sha256:" as const;
export const RUNNER_VALUE_SCHEMA_SCHEMA = "hunsu.runner-value-schema.v1" as const;
export const RUNNER_VALUE_SCHEMA_DIGEST_PREFIX = "hunsu-runner-value-schema-v1:sha256:" as const;

export type RegistryOrigin = string & { readonly [registryBrand]: "RegistryOrigin" };
export type RegistryKey = string & { readonly [registryBrand]: "RegistryKey" };
export type RegistryVersion = string & { readonly [registryBrand]: "RegistryVersion" };
export type RegistryIntegrity = `${typeof REGISTRY_INTEGRITY_PREFIX}${string}` & {
  readonly [registryBrand]: "RegistryIntegrity";
};
export type RunnerValueSchemaDigest = `${typeof RUNNER_VALUE_SCHEMA_DIGEST_PREFIX}${string}` & {
  readonly [registryBrand]: "RunnerValueSchemaDigest";
};
export type DefinitionIntegrity = RegistryIntegrity | RunnerTypeIntegrity;

export type DefinitionKind = "runner_type" | "coach" | "skill" | "resource";

export type DefinitionLock<Kind extends DefinitionKind = DefinitionKind> = {
  readonly origin: RegistryOrigin;
  readonly kind: Kind;
  readonly key: RegistryKey;
  readonly version: RegistryVersion;
  readonly integrity: DefinitionIntegrity;
};

type DefinitionHeader<Kind extends DefinitionKind> = {
  readonly schema: typeof REGISTRY_DEFINITION_SCHEMA;
  readonly kind: Kind;
  readonly key: RegistryKey;
  readonly version: RegistryVersion;
};

export type RunnerObjectValueSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, RunnerValueSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};

export type RunnerValueSchema =
  | RunnerObjectValueSchema
  | {
      readonly type: "array";
      readonly items: RunnerValueSchema;
      readonly minItems: number;
      readonly maxItems: number;
      readonly uniqueItems: boolean;
    }
  | {
      readonly type: "contiguous_ordered_array";
      readonly items: RunnerObjectValueSchema;
      readonly minItems: number;
      readonly maxItems: number;
      readonly orderField: string;
      readonly startAt: number;
    }
  | {
      readonly type: "string";
      readonly minLength: number;
      readonly maxLength: number;
    }
  | {
      readonly type: "string_enum";
      readonly values: readonly [string, ...string[]];
    }
  | {
      readonly type: "integer";
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly type: "number";
      readonly minimum: number;
      readonly maximum: number;
    }
  | { readonly type: "boolean" }
  | { readonly type: "null" };

export type RunnerExecutorContract = {
  readonly schema: "hunsu.runner-executor.v1";
  readonly resource: DefinitionLock<"resource">;
  readonly entrypoint: string;
};

export type RunnerTypeDefinition = DefinitionHeader<"runner_type"> & {
  readonly runnerType: {
    readonly displayName: string;
    readonly valueSchema: RunnerValueSchema;
    readonly executor: RunnerExecutorContract;
  };
};

/**
 * The public, non-executable portion of one integrity-locked Runner type.
 * Executor resources, entrypoints, Coach prompts, and Skill instructions are
 * deliberately absent from this DTO.
 */
export type RunnerTypeCapabilityDefinition = {
  readonly type: RunnerTypeLock;
  readonly displayName: string;
  readonly valueSchema: {
    readonly schema: typeof RUNNER_VALUE_SCHEMA_SCHEMA;
    readonly digest: RunnerValueSchemaDigest;
    readonly root: RunnerValueSchema;
  };
};

export type CoachDefinition = DefinitionHeader<"coach"> & {
  readonly coach: {
    readonly promptTemplate: string;
    readonly resources: readonly DefinitionLock<"skill" | "resource">[];
    readonly policy: {
      readonly transitions: "propose_only";
      readonly selection: "user_only";
      readonly rejection: "user_only";
    };
  };
};

export type SkillDefinition = DefinitionHeader<"skill"> & {
  readonly skill: {
    readonly name: string;
    readonly instructions: string;
    readonly resources: readonly DefinitionLock<"resource">[];
  };
};

export type RegisteredResource =
  | {
      readonly type: "skill";
      readonly name: string;
      readonly source: string;
    }
  | {
      readonly type: "plugin";
      readonly name: string;
      readonly version: string;
    };

export type ResourceDefinition = DefinitionHeader<"resource"> & {
  readonly resource: RegisteredResource;
};

export type RegistryDefinition = RunnerTypeDefinition | CoachDefinition | SkillDefinition | ResourceDefinition;

export type RegistryEntry = {
  readonly lock: DefinitionLock;
  readonly definition: RegistryDefinition;
};

export type DefinitionRegistry = {
  readonly schema: typeof REGISTRY_SNAPSHOT_SCHEMA;
  readonly entries: readonly RegistryEntry[];
};

export type RegistryDecodeError = {
  readonly type: "RegistryDecodeError";
  readonly path: string;
  readonly message: string;
};

export type RegistryIntegrityError = {
  readonly type: "RegistryIntegrityError";
  readonly path: string;
  readonly expected: DefinitionIntegrity;
  readonly actual: DefinitionIntegrity;
};

export type RegistryIdentityError = {
  readonly type: "RegistryIdentityError";
  readonly path: string;
  readonly message: string;
};

export type RegistryResolutionError = {
  readonly type: "RegistryResolutionError";
  readonly path: string;
  readonly message: string;
};

export type RegistryError =
  | RegistryDecodeError
  | RegistryIntegrityError
  | RegistryIdentityError
  | RegistryResolutionError;

export type RegistryResult<Value> = Result<Value, RegistryError>;

export type ResolvedRunnerType = {
  readonly lock: RunnerTypeLock;
  readonly definition: RunnerTypeDefinition;
};

export type { CanonicalJsonValue, RunnerTypeLock, RunnerValueTypeDecoder, RunnerValueTypeRegistry };
