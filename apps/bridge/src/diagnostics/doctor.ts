import { access } from "node:fs/promises";
import type { HeadlessProviderService } from "../provider/providerRegistry.ts";
import {
  createConfigStore,
  createCredentialStore,
  createRuntimeStore,
  createWorkspaceStore,
  type HunsuPaths
} from "../state/index.ts";
import { createWorkspaceService, toWorkspaceSafeMetadata } from "../workspaces/workspaceService.ts";
import { HUNSU_BRIDGE_PROTOCOL_VERSION, HUNSU_BRIDGE_VERSION } from "../version.ts";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "./redaction.ts";

export type BridgeDoctorReport = {
  schema: "hunsu.bridge.doctor.v1";
  mode: "online" | "offline";
  version: string;
  protocolVersion: string;
  home: string;
  state: {
    config: "valid" | "invalid";
    credentialsPresent: boolean;
    runtimePresent: boolean;
    workspaceCount: number;
  };
  provider?: {
    providerId: string;
    installed: boolean;
    configured: boolean;
    authenticated: boolean | "unknown";
    ready: boolean;
    message?: string;
  };
  workspaces: unknown[];
  issues: Array<{ code: string; message: string }>;
};

export async function createDoctorReport(input: {
  paths: HunsuPaths;
  providerService?: HeadlessProviderService;
  online?: boolean;
}): Promise<BridgeDoctorReport> {
  const issues: Array<{ code: string; message: string }> = [];
  let configValid = true;
  try {
    await createConfigStore(input.paths).read();
  } catch (_error) {
    configValid = false;
    issues.push({ code: "BRIDGE_STATE_INVALID", message: "Bridge configuration is invalid." });
  }
  const credentialsPresent = await fileExists(input.paths.credentialsFile);
  if (credentialsPresent) {
    try {
      await createCredentialStore(input.paths).read();
    } catch (_error) {
      issues.push({ code: "BRIDGE_STATE_INVALID", message: "Bridge credentials file is invalid or inaccessible." });
    }
  }
  const runtime = await createRuntimeStore(input.paths).read().catch(() => undefined);
  const workspaceResult = await createWorkspaceService({ store: createWorkspaceStore(input.paths) }).list();
  const workspaces = workspaceResult.ok ? workspaceResult.value.map(toWorkspaceSafeMetadata) : [];
  if (!workspaceResult.ok) issues.push({ code: workspaceResult.error.code, message: workspaceResult.error.message });
  const providerStatus = input.providerService
    ? await input.providerService.status(false).catch(() => undefined)
    : undefined;
  const report: BridgeDoctorReport = {
    schema: "hunsu.bridge.doctor.v1",
    mode: input.online === false ? "offline" : "online",
    version: HUNSU_BRIDGE_VERSION,
    protocolVersion: HUNSU_BRIDGE_PROTOCOL_VERSION,
    home: input.paths.home,
    state: {
      config: configValid ? "valid" : "invalid",
      credentialsPresent,
      runtimePresent: runtime !== undefined,
      workspaceCount: workspaces.length
    },
    ...(providerStatus ? {
      provider: {
        providerId: providerStatus.providerId,
        installed: providerStatus.installed,
        configured: providerStatus.configured,
        authenticated: providerStatus.authenticated,
        ready: providerStatus.ready,
        ...(providerStatus.safeMessage ? { message: providerStatus.safeMessage } : {})
      }
    } : {}),
    workspaces,
    issues
  };
  const safe = sanitizeDiagnostics(report) as BridgeDoctorReport;
  assertDiagnosticsSafe(safe);
  return safe;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (_error) {
    return false;
  }
}
