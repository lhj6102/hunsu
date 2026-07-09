import type { BridgeAppState } from "../state/appState.ts";
import {
  createDefaultCredentialStore,
  createPkceAuthorizationRequest,
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  startLocalDevAuthServer,
  type BridgeAccountCredentials
} from "../auth.ts";
import type { ProjectGrant } from "../relay.ts";
import { currentProcessEnv, resolveRelayClientConfig, unwrapConfigResult } from "@hunsu/config";

type ParsedAuthArgs = {
  rest: string[];
};

type AuthCommandContext = {
  hasFlag: (parsed: any, name: string) => boolean;
  getFlag: (parsed: any, name: string) => string | undefined;
  numericFlag: (parsed: any, name: string) => number | undefined;
  credentialPath: () => string;
  readState: () => BridgeAppState;
  writeState: (state: BridgeAppState) => void;
  credentialsForDevUser: (userId: string, state: BridgeAppState) => BridgeAccountCredentials;
  openBrowser: (url: string) => void;
  disableAllManagedRoadmapRemoteAccess: () => void;
  projectGrantsWithoutRemoteRelay: (projectGrants: ProjectGrant[]) => ProjectGrant[];
};

export async function runLoginCommand(parsed: ParsedAuthArgs, context: AuthCommandContext): Promise<void> {
  const state = context.readState();
  const credentialStore = createDefaultCredentialStore({ path: context.credentialPath() });
  const devUser = nonEmptyFlagValue(currentProcessEnv().HUNSU_BRIDGE_DEV_USER);
  if (devUser) {
    credentialStore.write(context.credentialsForDevUser(devUser, state));
    context.writeState({
      ...state,
      account: { status: "signed-in", userId: devUser, email: devUser.includes("@") ? devUser : undefined },
      device: { ...state.device, registered: true }
    });
    console.log(`Signed in as ${devUser}.`);
    return;
  }
  if (context.hasFlag(parsed, "gui")) {
    const authBaseUrl = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv())).authBaseUrl;
    const request = createPkceAuthorizationRequest({
      authBaseUrl,
      clientId: "hunsu-bridge-app",
      redirectUri: "hunsu://pair",
      scope: "bridge device relay"
    });
    context.writeState({
      ...state,
      pendingAuth: {
        state: request.state,
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUri,
        authBaseUrl,
        startedAt: new Date().toISOString()
      }
    });
    console.log("Open this URL in your browser:");
    console.log(request.authorizationUrl);
    console.log("");
    console.log("Authorization Code + PKCE is ready for the GUI Bridge App callback.");
    if (!context.hasFlag(parsed, "no-open")) {
      context.openBrowser(request.authorizationUrl);
    }
    return;
  }
  const configuredAuthBaseUrl = context.getFlag(parsed, "auth-url") ?? unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv())).authBaseUrl;
  const localDev = configuredAuthBaseUrl === "local-dev" || context.hasFlag(parsed, "local-dev");
  const localDevServer = localDev
    ? await startLocalDevAuthServer({
        userId: context.getFlag(parsed, "user") ?? "local-dev@example.test",
        email: context.getFlag(parsed, "email") ?? context.getFlag(parsed, "user") ?? "local-dev@example.test"
      })
    : undefined;
  const authBaseUrl = localDevServer?.authBaseUrl ?? configuredAuthBaseUrl;
  try {
    const request = await startDeviceAuthorization({
      authBaseUrl,
      clientId: "hunsu-bridge-headless",
      scope: "bridge device relay",
      deviceId: state.device.id,
      deviceName: state.device.name
    });
    console.log("Open this URL on another device:");
    console.log(request.verificationUriComplete ?? request.verificationUri);
    console.log("");
    console.log("Enter code:");
    console.log(request.userCode);
    console.log("");
    if (localDevServer && (context.hasFlag(parsed, "auto-approve") || currentProcessEnv().HUNSU_BRIDGE_AUTH_LOCAL_DEV_AUTO_APPROVE === "1")) {
      await fetch(request.verificationUriComplete ?? `${request.verificationUri}?user_code=${encodeURIComponent(request.userCode)}`);
    }
    const credentials = await pollDeviceAuthorization({
      authBaseUrl,
      clientId: "hunsu-bridge-headless",
      deviceCode: request.deviceCode,
      deviceId: state.device.id,
      deviceName: state.device.name,
      intervalSeconds: request.intervalSeconds,
      expiresAt: request.expiresAt,
      maxWaitMs: context.numericFlag(parsed, "poll-timeout-ms")
    });
    credentialStore.write(credentials);
    context.writeState({
      ...state,
      account: { status: "signed-in", userId: credentials.userId, email: credentials.email },
      device: { ...state.device, registered: true },
      pendingAuth: undefined
    });
    console.log(`Signed in as ${credentials.email ?? credentials.userId}.`);
  } finally {
    await localDevServer?.close();
  }
}

export async function runAuthCallbackCommand(parsed: ParsedAuthArgs, context: AuthCommandContext): Promise<void> {
  const code = context.getFlag(parsed, "code") ?? parsed.rest[0];
  const stateParam = context.getFlag(parsed, "state");
  if (!code?.trim() || !stateParam?.trim()) {
    throw new Error("Authorization callback requires code and state.");
  }
  const state = context.readState();
  if (!state.pendingAuth) {
    throw new Error("No pending Bridge App sign-in request was found.");
  }
  if (state.pendingAuth.state !== stateParam) {
    throw new Error("Authorization callback state did not match the pending Bridge App sign-in.");
  }
  const credentials = await exchangeAuthorizationCode({
    authBaseUrl: state.pendingAuth.authBaseUrl,
    clientId: "hunsu-bridge-app",
    code,
    codeVerifier: state.pendingAuth.codeVerifier,
    redirectUri: state.pendingAuth.redirectUri,
    deviceId: state.device.id,
    deviceName: state.device.name
  });
  createDefaultCredentialStore({ path: context.credentialPath() }).write(credentials);
  context.writeState({
    ...state,
    pendingAuth: undefined,
    account: { status: "signed-in", userId: credentials.userId, email: credentials.email },
    device: { ...state.device, registered: true }
  });
  console.log(`Signed in as ${credentials.email ?? credentials.userId}.`);
}

export function runLogoutCommand(context: AuthCommandContext): void {
  const state = context.readState();
  createDefaultCredentialStore({ path: context.credentialPath() }).clear();
  context.disableAllManagedRoadmapRemoteAccess();
  context.writeState({
    ...state,
    account: { status: "signed-out" },
    pendingAuth: undefined,
    remoteAccess: "off",
    projectGrants: context.projectGrantsWithoutRemoteRelay(state.projectGrants)
  });
  console.log("Signed out. Local Bridge remains available.");
}

function nonEmptyFlagValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
