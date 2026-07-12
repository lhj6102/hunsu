import { existsSync } from "node:fs";
import type { BridgeRuntimeConfig } from "@hunsu/config";
import { HUNSU_BRIDGE_PROTOCOL_VERSION, HUNSU_BRIDGE_VERSION } from "../version.ts";

export type BridgeVersionInfo = {
  bridgeVersion: string;
  protocolVersion: string;
  minSupportedStudioVersion?: string;
  supportedFeatures: string[];
};

export type StudioBridgeRequirement = {
  minBridgeVersion: string;
  requiredProtocolVersion: string;
  requiredFeatures: string[];
};

export type BridgeCompatibility =
  | { compatible: true }
  | { compatible: false; reason: "bridge_update_needed" | "studio_update_needed" | "feature_unavailable"; message: string };

export type StudioConnectionStatus = {
  mode: "none" | "local" | "remote";
  transport: "direct" | "peer" | "unreachable";
  health: "checking" | "connected" | "disconnected" | "error";
  auth: "paired" | "missing_token" | "expired" | "invalid" | "account_mismatch" | "unknown";
  projectAccess: "granted" | "needs_grant" | "denied" | "not_applicable";
  bridge?: {
    id?: string;
    name?: string;
    version?: string;
    protocolVersion?: string;
    startedAt?: string;
    lastSeenAt?: string;
  };
  endpoint?: {
    apiUrl?: string;
    connectLabel?: string;
  };
  account?: {
    webUserId?: string;
    bridgeUserId?: string;
    sameUser?: boolean;
  };
  project?: {
    roadmapId?: string;
    displayName?: string;
    repositoryPath?: string;
  };
  warnings: Array<
    | "public_bind"
    | "version_mismatch"
    | "origin_not_allowed"
    | "remote_unavailable"
    | "project_missing"
  >;
  error?: string;
  version: BridgeVersionInfo;
  compatibility?: BridgeCompatibility;
};

const HUNSU_BRIDGE_SUPPORTED_FEATURES = [
  "local-pairing",
  "project-finder",
  "roadmap-registry",
  "artifact-actions",
  "connection-status",
  "headless-daemon",
  "remote-ready"
];

export const DEFAULT_STUDIO_BRIDGE_REQUIREMENT: StudioBridgeRequirement = {
  minBridgeVersion: HUNSU_BRIDGE_VERSION,
  requiredProtocolVersion: HUNSU_BRIDGE_PROTOCOL_VERSION,
  requiredFeatures: ["local-pairing", "connection-status"]
};

export function bridgeVersionInfo(): BridgeVersionInfo {
  return {
    bridgeVersion: HUNSU_BRIDGE_VERSION,
    protocolVersion: HUNSU_BRIDGE_PROTOCOL_VERSION,
    supportedFeatures: [...HUNSU_BRIDGE_SUPPORTED_FEATURES]
  };
}

export function evaluateBridgeCompatibility(
  version: BridgeVersionInfo,
  requirement: StudioBridgeRequirement,
  studioVersion = "0.1.0"
): BridgeCompatibility {
  if (compareDottedVersions(version.bridgeVersion, requirement.minBridgeVersion) < 0) {
    return {
      compatible: false,
      reason: "bridge_update_needed",
      message: `Bridge ${version.bridgeVersion} is older than required ${requirement.minBridgeVersion}.`
    };
  }
  if (version.protocolVersion !== requirement.requiredProtocolVersion) {
    return {
      compatible: false,
      reason: "bridge_update_needed",
      message: `Bridge protocol ${version.protocolVersion} does not match required ${requirement.requiredProtocolVersion}.`
    };
  }
  const missingFeature = requirement.requiredFeatures.find(feature => !version.supportedFeatures.includes(feature));
  if (missingFeature) {
    return {
      compatible: false,
      reason: "feature_unavailable",
      message: `Bridge feature is unavailable: ${missingFeature}.`
    };
  }
  if (version.minSupportedStudioVersion && compareDottedVersions(studioVersion, version.minSupportedStudioVersion) < 0) {
    return {
      compatible: false,
      reason: "studio_update_needed",
      message: `Studio ${studioVersion} is older than Bridge requires ${version.minSupportedStudioVersion}.`
    };
  }
  return { compatible: true };
}

export function createStudioConnectionStatus(input: {
  bridgeApiUrl: string;
  repositoryPath?: string;
  roadmapId?: string;
  roadmapDisplayName?: string;
  runtimeConfig: BridgeRuntimeConfig;
  startedAt?: string;
  auth?: StudioConnectionStatus["auth"];
  projectAccess?: StudioConnectionStatus["projectAccess"];
  bridgeVersion?: BridgeVersionInfo;
  requirement?: StudioBridgeRequirement;
  studioVersion?: string;
  error?: string;
}): StudioConnectionStatus {
  const warnings: StudioConnectionStatus["warnings"] = [];
  if (isWildcardHost(input.runtimeConfig.bridgeApi.host)) {
    warnings.push("public_bind");
  }
  if (input.repositoryPath && !existsSync(input.repositoryPath)) {
    warnings.push("project_missing");
  }
  const version = input.bridgeVersion ?? bridgeVersionInfo();
  const compatibility = evaluateBridgeCompatibility(version, input.requirement ?? DEFAULT_STUDIO_BRIDGE_REQUIREMENT, input.studioVersion);
  if (!compatibility.compatible) {
    warnings.push("version_mismatch");
  }
  const error = input.error ?? (compatibility.compatible ? undefined : compatibility.message);
  const healthy = error === undefined;
  return {
    mode: "local",
    transport: "direct",
    health: healthy ? "connected" : "error",
    auth: input.auth ?? "paired",
    projectAccess: input.projectAccess ?? (input.repositoryPath ? "granted" : "not_applicable"),
    bridge: {
      id: `local:${input.runtimeConfig.bridgeApi.host}:${input.runtimeConfig.bridgeApi.port}`,
      name: "Local Bridge",
      version: version.bridgeVersion,
      protocolVersion: version.protocolVersion,
      startedAt: input.startedAt,
      lastSeenAt: new Date().toISOString()
    },
    endpoint: {
      apiUrl: input.bridgeApiUrl
    },
    project: input.repositoryPath ? {
      roadmapId: input.roadmapId,
      displayName: input.roadmapDisplayName,
      repositoryPath: input.repositoryPath
    } : undefined,
    warnings,
    error,
    version,
    compatibility
  };
}

export function createDisconnectedStudioConnectionStatus(error?: string): StudioConnectionStatus {
  return {
    mode: "none",
    transport: "unreachable",
    health: "disconnected",
    auth: "unknown",
    projectAccess: "not_applicable",
    warnings: [],
    error,
    version: bridgeVersionInfo(),
    compatibility: { compatible: true }
  };
}

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}
