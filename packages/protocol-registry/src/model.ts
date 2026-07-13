import type {
  CoachPolicy,
  NonEmptyText,
  PositiveInteger,
  PromptTemplate,
  ResourceName,
  Result,
  RuntimePolicy
} from "@hunsu/protocol";

declare const registryBrand: unique symbol;

export const REGISTRY_DEFINITION_SCHEMA = "hunsu.registry-definition.v1" as const;
export const REGISTRY_SNAPSHOT_SCHEMA = "hunsu.registry-snapshot.v1" as const;
export const REGISTRY_INTEGRITY_PREFIX = "hunsu-json-c14n-v1+sha256:" as const;

export type RegistryOrigin = string & { readonly [registryBrand]: "RegistryOrigin" };
export type RegistryKey = string & { readonly [registryBrand]: "RegistryKey" };
export type RegistryVersion = string & { readonly [registryBrand]: "RegistryVersion" };
export type RegistryIntegrity = `${typeof REGISTRY_INTEGRITY_PREFIX}${string}` & {
  readonly [registryBrand]: "RegistryIntegrity";
};

export type DefinitionKind = "player" | "team" | "coach" | "skill" | "resource";
export type RunnerDefinitionKind = "player" | "team";

export type DefinitionLock<Kind extends DefinitionKind = DefinitionKind> = {
  readonly origin: RegistryOrigin;
  readonly kind: Kind;
  readonly key: RegistryKey;
  readonly version: RegistryVersion;
  readonly integrity: RegistryIntegrity;
};

type DefinitionHeader<Kind extends DefinitionKind> = {
  readonly schema: typeof REGISTRY_DEFINITION_SCHEMA;
  readonly kind: Kind;
  readonly key: RegistryKey;
  readonly version: RegistryVersion;
};

export type PlayerDefinition = DefinitionHeader<"player"> & {
  readonly player: {
    readonly promptTemplate: PromptTemplate;
    readonly resources: readonly DefinitionLock<"skill" | "resource">[];
    readonly runtimePolicy: RuntimePolicy;
  };
};

export type TeamPlayerDefinition = {
  readonly player: DefinitionLock<"player">;
  readonly role: NonEmptyText;
  readonly order: PositiveInteger;
};

export type TeamDefinition = DefinitionHeader<"team"> & {
  readonly team: {
    readonly strategy: {
      readonly mode: "sequence" | "parallel" | "coordinated";
      readonly promptTemplate: PromptTemplate;
      readonly maxRounds: PositiveInteger;
    };
    readonly players: readonly [TeamPlayerDefinition, ...TeamPlayerDefinition[]];
  };
};

export type RunnerDefinition = PlayerDefinition | TeamDefinition;

export type CoachDefinition = DefinitionHeader<"coach"> & {
  readonly coach: {
    readonly promptTemplate: PromptTemplate;
    readonly resources: readonly DefinitionLock<"skill" | "resource">[];
    readonly policy: CoachPolicy;
  };
};

export type SkillDefinition = DefinitionHeader<"skill"> & {
  readonly skill: {
    readonly name: ResourceName;
    readonly instructions: NonEmptyText;
    readonly resources: readonly DefinitionLock<"resource">[];
  };
};

export type RegisteredResource =
  | {
      readonly type: "skill";
      readonly name: ResourceName;
      readonly source: NonEmptyText;
    }
  | {
      readonly type: "plugin";
      readonly name: ResourceName;
      readonly version: NonEmptyText;
    };

export type ResourceDefinition = DefinitionHeader<"resource"> & {
  readonly resource: RegisteredResource;
};

export type RegistryDefinition = RunnerDefinition | CoachDefinition | SkillDefinition | ResourceDefinition;

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
  readonly expected: RegistryIntegrity;
  readonly actual: RegistryIntegrity;
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

export type TeamMembershipError = {
  readonly type: "TeamMembershipError";
  readonly path: string;
  readonly message: string;
};

export type RegistryError =
  | RegistryDecodeError
  | RegistryIntegrityError
  | RegistryIdentityError
  | RegistryResolutionError
  | TeamMembershipError;

export type RegistryResult<Value> = Result<Value, RegistryError>;
