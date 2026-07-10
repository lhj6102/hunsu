const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const diagnostics = document.querySelector("#diagnostics");
const actionStatus = document.querySelector("#action-status");
const providerConfigStatus = document.querySelector("#provider-config-status");
const copyDiagnosticsButton = document.querySelector("#copy-diagnostics");
const startBridgeButton = document.querySelector("#start-bridge");
const stopBridgeButton = document.querySelector("#stop-bridge");
const bridgeControlReason = document.querySelector("#bridge-control-reason");
const statusEls = {
  localBridge: document.querySelector("#local-bridge"),
  codexSummary: document.querySelector("#codex-summary"),
  activeRoadmaps: document.querySelector("#active-roadmaps"),
  account: document.querySelector("#account"),
  remoteAccess: document.querySelector("#remote-access"),
  device: document.querySelector("#device"),
  service: document.querySelector("#service"),
  quitBehavior: document.querySelector("#quit-behavior")
};
const activeRoadmapList = document.querySelector("#active-roadmap-list");
const inactiveRoadmapList = document.querySelector("#inactive-roadmap-list");
const codexCard = document.querySelector("#codex-card");
const gitCard = document.querySelector("#git-card");
const nodeCard = document.querySelector("#node-card");
const remoteRoadmapList = document.querySelector("#remote-roadmap-list");
const projectGrants = document.querySelector("#project-grants");
const runtimeProviderList = document.querySelector("#runtime-provider-list");
const connectionEls = {
  localStatus: document.querySelector("#connection-local-status"),
  remoteStatus: document.querySelector("#connection-remote-status"),
  remoteDetail: document.querySelector("#connection-remote-detail"),
  primaryAction: document.querySelector("#connection-primary-action"),
  secondaryAction: document.querySelector("#connection-secondary-action")
};
const selectedProject = document.querySelector("#selected-project");
const selectedProjectAction = document.querySelector("#selected-project-action");
const providerConfigForm = document.querySelector("#provider-config-form");
const providerConfigDialog = document.querySelector("#provider-config-dialog");
const providerConfigClose = document.querySelector("#close-provider-config");
const providerConfigSettingsOpen = document.querySelector("#open-provider-config-settings");
const codexInstallChannel = document.querySelector("#codex-install-channel");
const quitBehaviorSelect = document.querySelector("#quit-behavior-select");
const versionEls = {
  bridgeApp: document.querySelector("#bridge-app-version"),
  bridgeRuntime: document.querySelector("#bridge-runtime-version"),
  protocol: document.querySelector("#protocol-version"),
  embeddedNode: document.querySelector("#embedded-node-version"),
  codexCli: document.querySelector("#codex-cli-version")
};
let codexBinaryPath = undefined;
let codexEnvHome = undefined;
let latestProviderConfigMetadata = undefined;
const providerConfigFieldElements = new Map();
let latestSnapshot = undefined;
let selectedInspection = undefined;
let lastHandledUiIntentId = undefined;
let latestCodexDeviceLoginResult = undefined;
const pendingUiActions = new Set();
const projectGrantScopes = ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"];
const sensitiveDiagnosticKeys = new Set([
  "hunsubridgetoken",
  "hunsurelaytoken",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "authtoken",
  "controltoken"
]);
const sensitiveQueryPattern = /([?&](?:hunsuBridgeToken|hunsuRelayToken|token|access_token|refresh_token|authorization|code|state)=)([^&#\s"']*)/giu;
const redactedValues = new Set(["", "[redacted]", "%5bredacted%5d", "redacted", "***"]);
const uiErrorMessages = {
  BRIDGE_ALREADY_RUNNING_UNMANAGED: "Bridge is already running outside this app.",
  BRIDGE_PORT_IN_USE: "The local Bridge port is in use by another process.",
  BRIDGE_START_COORDINATION_TIMEOUT: "Bridge startup coordination timed out.",
  BRIDGE_START_TIMEOUT: "Bridge did not become connected in time.",
  BRIDGE_CONTROL_UNAVAILABLE: "Bridge ownership could not be verified.",
  BRIDGE_NOT_OWNED: "This Bridge process is not managed by this app.",
  BRIDGE_STOP_TIMEOUT: "Bridge did not stop in time.",
  PAIRING_ROTATION_FAILED: "Hunsu Web could not be opened because pairing failed.",
  BROWSER_OPEN_FAILED: "The browser could not be opened.",
  ROADMAP_NOT_FOUND: "That Workspace could not be found.",
  DIAGNOSTICS_SENSITIVE_DATA_DETECTED: "Diagnostics were not copied because sensitive data was detected.",
  PROVIDER_CONFIG_INVALID: "Configuration is invalid.",
  PROVIDER_RECHECK_FAILED: "Recheck failed."
};

async function open(url) {
  if (invoke) await invoke("open_external", { url });
  else window.location.href = url;
}

class UiCommandError extends Error {
  constructor(result) {
    super(safeFailureMessage(result));
    this.name = "UiCommandError";
    this.code = result?.code ?? "COMMAND_FAILED";
    this.result = result;
  }
}

async function runCommand(args) {
  if (!invoke) {
    return {
      ok: false,
      code: "TAURI_UNAVAILABLE",
      message: "The desktop command service is unavailable."
    };
  }
  try {
    const output = await invoke("run_bridge_app_command", { input: { args } });
    return normalizeCommandOutput(output, args);
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? "COMMAND_INVOKE_FAILED",
      message: safeDiagnosticText(error?.message ?? String(error))
    };
  }
}

async function run(args) {
  const result = await runCommand(args);
  if (!result.ok) {
    throw new UiCommandError(result);
  }
  if (typeof result.stdout === "string") {
    return result.stdout;
  }
  return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "");
}

function normalizeCommandOutput(output, args) {
  if (isUiCommandResult(output)) {
    return normalizeUiCommandResult(output);
  }
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const stderr = typeof output?.stderr === "string" ? output.stderr : "";
  const parsed = parseJsonResult(stdout);
  if (isUiCommandResult(parsed)) {
    return {
      ...normalizeUiCommandResult(parsed),
      stdout
    };
  }
  if (Number(output?.status ?? 0) !== 0) {
    return {
      ok: false,
      code: "COMMAND_FAILED",
      message: safeDiagnosticText(stderr || stdout || `Command failed: ${args[0] ?? "unknown"}`),
      stdout
    };
  }
  return {
    ok: true,
    code: "OK",
    message: "Command completed.",
    value: parsed ?? stdout,
    stdout
  };
}

function isUiCommandResult(value) {
  return value && typeof value === "object" && typeof value.ok === "boolean";
}

function normalizeUiCommandResult(result) {
  if (result.ok) {
    return {
      ok: true,
      code: typeof result.code === "string" ? result.code : "OK",
      message: safeDiagnosticText(result.message ?? "Command completed."),
      value: result.value
    };
  }
  return {
    ok: false,
    code: typeof result.code === "string" ? result.code : "COMMAND_FAILED",
    message: safeDiagnosticText(result.message ?? "The command failed."),
    recovery: result.recovery
  };
}

async function spawn(args) {
  if (!invoke) {
    await open(`hunsu://${args[0]}`);
    return;
  }
  await invoke("spawn_bridge_app_command", { input: { args } });
}

async function refresh(options = {}) {
  try {
    const stdout = await run(["snapshot"]);
    latestSnapshot = JSON.parse(stdout);
    renderSnapshot(latestSnapshot);
    await handleUiIntent(latestSnapshot.uiIntent);
    return latestSnapshot;
  } catch (error) {
    statusEls.localBridge.textContent = "Error";
    statusEls.localBridge.className = "status-error";
    diagnostics.textContent = JSON.stringify({ error: safeDiagnosticText(error?.message ?? String(error)) }, null, 2);
    if (options.rethrow) {
      throw error;
    }
    return undefined;
  }
}

async function runUiAction({
  id,
  pendingMessage,
  successMessage,
  failureMessage,
  execute,
  refreshAfter = true,
  controls = [],
  feedbackElement,
  includeCompletionTime = false
}) {
  if (pendingUiActions.has(id)) {
    return {
      ok: false,
      code: "UI_ACTION_PENDING",
      message: "This action is already in progress."
    };
  }
  pendingUiActions.add(id);
  const controlStates = controls.filter(Boolean).map(control => ({
    control,
    disabled: control.disabled,
    title: control.title
  }));
  for (const { control } of controlStates) {
    control.disabled = true;
  }
  showActionFeedback("pending", pendingMessage, feedbackElement);
  try {
    const rawResult = await execute();
    const result = isUiCommandResult(rawResult)
      ? normalizeUiCommandResult(rawResult)
      : { ok: true, code: "OK", message: "Command completed.", value: rawResult };
    if (!result.ok) {
      throw new UiCommandError(result);
    }
    if (refreshAfter) {
      await refresh({ rethrow: true });
    }
    const resolvedSuccessMessage = typeof successMessage === "function"
      ? successMessage(result)
      : successMessage || result.message;
    showActionFeedback(
      "success",
      withCompletionTime(safeDiagnosticText(resolvedSuccessMessage), includeCompletionTime),
      feedbackElement
    );
    return result;
  } catch (error) {
    const result = error instanceof UiCommandError
      ? error.result
      : {
          ok: false,
          code: error?.code ?? "UI_ACTION_FAILED",
          message: safeDiagnosticText(error?.message ?? String(error))
        };
    const reason = safeFailureMessage(result);
    const message = failureMessage
      ? `${failureMessage}${reason && reason !== failureMessage ? `\n${reason}` : ""}`
      : reason;
    showActionFeedback("error", message, feedbackElement);
    return { ...result, ok: false };
  } finally {
    pendingUiActions.delete(id);
    for (const { control, disabled, title } of controlStates) {
      control.disabled = disabled;
      control.title = title;
    }
    if (latestSnapshot) {
      renderBridgeControls(latestSnapshot.localBridgeControl, latestSnapshot.status);
    }
  }
}

function showActionFeedback(state, message, feedbackElement) {
  const safeMessage = safeDiagnosticText(message ?? "");
  const targets = [actionStatus, feedbackElement].filter((target, index, all) => target && all.indexOf(target) === index);
  for (const target of targets) {
    target.textContent = safeMessage;
    target.className = `message action-status status-${state}`;
    target.dataset.state = state;
  }
}

function withCompletionTime(message, includeCompletionTime) {
  if (!includeCompletionTime) return message;
  return `${message}\nCompleted ${new Date().toLocaleTimeString()}`;
}

function safeFailureMessage(result) {
  const codeMessage = uiErrorMessages[result?.code];
  const message = codeMessage ?? safeDiagnosticText(result?.message ?? "The operation failed.");
  const recovery = result?.recovery?.label ? safeDiagnosticText(result.recovery.label) : undefined;
  return [message, recovery].filter(Boolean).join("\n");
}

function safeDiagnosticText(value) {
  return String(value ?? "")
    .replace(sensitiveQueryPattern, (_match, prefix) => `${prefix}[redacted]`)
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(["']?(?:authToken|controlToken|hunsuBridgeToken|hunsuRelayToken|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/giu, "$1[redacted]");
}

function assertDiagnosticsSafe(value, path = "diagnostics") {
  if (typeof value === "string") {
    assertDiagnosticTextSafe(value);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDiagnosticsSafe(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveDiagnosticKeys.has(key.toLowerCase()) && !isRedactedDiagnosticValue(item)) {
      throw diagnosticsSafetyError(path);
    }
    assertDiagnosticsSafe(item, `${path}.${key}`);
  }
}

function assertDiagnosticTextSafe(value) {
  sensitiveQueryPattern.lastIndex = 0;
  for (const match of value.matchAll(sensitiveQueryPattern)) {
    if (!redactedValues.has(String(match[2] ?? "").toLowerCase())) {
      throw diagnosticsSafetyError("diagnostics text");
    }
  }
  if (/Authorization\s*[:=]\s*Bearer\s+(?!\[redacted\])[^\s"']+/iu.test(value)) {
    throw diagnosticsSafetyError("diagnostics text");
  }
  const sensitiveFieldPattern = /["']?(?:hunsuBridgeToken|hunsuRelayToken|authToken|controlToken|access_token|refresh_token|authorization|token)["']?\s*[:=]\s*["']?([^\s,"'}&]+)/giu;
  for (const match of value.matchAll(sensitiveFieldPattern)) {
    if (!redactedValues.has(String(match[1] ?? "").toLowerCase())) {
      throw diagnosticsSafetyError("diagnostics text");
    }
  }
}

function isRedactedDiagnosticValue(value) {
  if (value === undefined || value === null || value === false) return true;
  return typeof value === "string" && redactedValues.has(value.toLowerCase());
}

function diagnosticsSafetyError(_path) {
  const error = new Error(uiErrorMessages.DIAGNOSTICS_SENSITIVE_DATA_DETECTED);
  error.code = "DIAGNOSTICS_SENSITIVE_DATA_DETECTED";
  return error;
}

async function handleUiIntent(intent) {
  if (!intent?.id || intent.id === lastHandledUiIntentId) {
    return;
  }
  lastHandledUiIntentId = intent.id;
  selectTab(intent.tab);
  if (intent.focus === "codex") {
    codexCard?.scrollIntoView({ block: "start" });
  }
  if (intent.focus === "remote") {
    connectionEls.remoteStatus?.scrollIntoView({ block: "center" });
  }
  if (intent.action === "add-roadmap") {
    await chooseProjectFolder();
  }
  if (intent.action === "add-workspace") {
    await chooseProjectFolder();
  }
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  const status = snapshot.status ?? {};
  const bridgeControl = resolvedBridgeControl(snapshot.localBridgeControl, status);
  const localBridgeState = bridgeControl.state;
  const localBridgeDisplayState = snapshot.localBridgeControl ? localBridgeState : localBridgeState === "not-running" ? "connecting" : localBridgeState;
  statusEls.localBridge.textContent = providerConnectionSummary({ ...status, localBridge: localBridgeDisplayState });
  statusEls.localBridge.className = localBridgeState === "connected" ? "status-connected" : localBridgeState === "error" ? "status-error" : "status-warning";
  const codex = snapshot.prerequisites?.codex;
  const currentProvider = currentRuntimeProvider(snapshot.providers ?? snapshot.runtimeProviders, codex);
  statusEls.codexSummary.textContent = `${currentProvider.label} · ${providerStatusSummary(currentProvider)}`;
  statusEls.codexSummary.className = currentProvider.ready ? "status-connected" : currentProvider.recommendedAction === "install" || currentProvider.recommendedAction === "login" || currentProvider.recommendedAction === "select_binary" ? "status-warning" : "status-error";
  const managed = snapshot.workspaces?.managed ?? snapshot.managedRoadmaps ?? snapshot.recentProjects ?? [];
  const activeRoadmaps = snapshot.workspaces?.active ?? managed.filter(project => project.lifecycle === "active");
  const inactiveRoadmaps = snapshot.workspaces?.inactive ?? managed.filter(project => project.lifecycle !== "active");
  statusEls.activeRoadmaps.textContent = `${activeRoadmaps.length} active`;
  statusEls.account.textContent = status.account ?? "Unknown";
  statusEls.remoteAccess.textContent = status.remoteAccess ?? "Unknown";
  statusEls.device.textContent = `${status.device?.name ?? "Unknown"}${status.device?.registered ? " (registered)" : ""}`;
  statusEls.service.textContent = status.service?.installed ? `Installed (${status.service.manager})` : "Not installed";
  statusEls.quitBehavior.textContent = formatQuitBehavior(status.quitBehavior);
  if (quitBehaviorSelect) {
    quitBehaviorSelect.value = status.quitBehavior ?? "keep-background";
  }
  renderDiagnostics(snapshot);
  if (snapshot.codexLogin) {
    latestCodexDeviceLoginResult = snapshot.codexLogin;
  } else if (currentProvider.ready || currentProvider.auth?.state === "authenticated") {
    latestCodexDeviceLoginResult = undefined;
  }
  renderProviderCard(currentProvider);
  renderToolCards(snapshot.prerequisites?.tools);
  renderVersions(snapshot);
  activeRoadmapList.replaceChildren(...roadmapRows(activeRoadmaps, "active", snapshot.projectGrants ?? []));
  inactiveRoadmapList.replaceChildren(...roadmapRows(inactiveRoadmaps, "inactive", snapshot.projectGrants ?? []));
  remoteRoadmapList.replaceChildren(...roadmapRows(managed, "remote", snapshot.projectGrants ?? [], { advanced: true }));
  projectGrants.replaceChildren(...projectGrantRows(snapshot.projectGrants ?? []));
  renderConnection(snapshot);
  renderBridgeControls(bridgeControl, status);
  renderRuntimeProviders(snapshot.providers ?? snapshot.runtimeProviders, codex);
  renderCodexSettings(snapshot.providerConfig, snapshot.codexSettings, snapshot.diagnostics?.app?.codex);
}

function renderDiagnostics(snapshot) {
  const payload = {
    diagnostics: snapshot.diagnostics,
    logs: snapshot.logLines
  };
  try {
    assertDiagnosticsSafe(payload);
    diagnostics.textContent = JSON.stringify(payload, null, 2);
    if (!pendingUiActions.has("copy-diagnostics")) {
      copyDiagnosticsButton.disabled = false;
    }
    copyDiagnosticsButton.title = "Request fresh, filtered diagnostics and copy them.";
  } catch (_error) {
    diagnostics.textContent = JSON.stringify({
      error: "Diagnostics hidden because sensitive data was detected. Refresh after updating Hunsu Bridge."
    }, null, 2);
    copyDiagnosticsButton.disabled = true;
    copyDiagnosticsButton.title = uiErrorMessages.DIAGNOSTICS_SENSITIVE_DATA_DETECTED;
  }
}

function resolvedBridgeControl(control, status = {}) {
  if (control?.state) {
    return control;
  }
  const state = status.localBridge ?? "error";
  const running = state === "connected" || state === "starting";
  const managed = Boolean(status.supervisorPid || status.pid);
  return {
    state,
    ownership: running ? managed ? "managed" : "unknown" : "unknown",
    canStart: state === "not-running" || (state === "error" && !status.pid),
    canStop: state === "connected" && managed,
    startReason: running ? "Bridge is already connected." : state === "error" && status.pid ? "Bridge ownership is being checked." : undefined,
    stopReason: !running ? "Bridge is not running." : managed ? undefined : "Bridge ownership is being checked.",
    daemonPid: status.pid,
    supervisorPid: status.supervisorPid
  };
}

function renderBridgeControls(control, status = {}) {
  const current = resolvedBridgeControl(control, status);
  const transitionPending = pendingUiActions.has("start-bridge") || pendingUiActions.has("stop-bridge");
  const lifecycleAllowsStart = (current.state === "not-running" || current.state === "error") && current.canStart === true;
  const lifecycleAllowsStop = current.state === "connected" && current.ownership === "managed" && current.canStop === true;
  startBridgeButton.disabled = transitionPending || !lifecycleAllowsStart;
  stopBridgeButton.disabled = transitionPending || !lifecycleAllowsStop;
  const startReason = transitionPending
    ? "Bridge lifecycle transition in progress."
    : lifecycleAllowsStart ? "" : current.startReason || defaultStartReason(current);
  const stopReason = transitionPending
    ? "Bridge lifecycle transition in progress."
    : lifecycleAllowsStop ? "" : current.stopReason || defaultStopReason(current);
  startBridgeButton.title = startReason;
  stopBridgeButton.title = stopReason;
  bridgeControlReason.textContent = [
    startReason ? `Start disabled: ${startReason}` : undefined,
    stopReason ? `Stop disabled: ${stopReason}` : undefined
  ].filter(Boolean).join("\n");
}

function defaultStartReason(control) {
  if (control.state === "connected") return "Bridge is already connected.";
  if (control.state === "starting") return "Bridge is starting.";
  if (control.state === "stopping") return "Bridge is stopping.";
  return "Bridge ownership is being checked.";
}

function defaultStopReason(control) {
  if (control.state === "not-running") return "Bridge is not running.";
  if (control.ownership === "unmanaged") return "This Bridge process is not managed by this app.";
  if (control.state === "starting") return "Bridge is starting.";
  if (control.state === "stopping") return "Bridge is stopping.";
  return "Bridge ownership is being checked.";
}

function roadmapRows(projects, lifecycle, grants, options = {}) {
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-row";
    empty.textContent = lifecycle === "active" ? "No active Workspaces." : lifecycle === "remote" ? "No managed Workspaces." : "No inactive Workspaces.";
    return [empty];
  }
  return projects.map(project => projectRow(project, grants, options));
}

function projectRow(project, grants = [], options = {}) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = project.displayName;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  const grant = project.projectGrant ?? grantForProject(project, grants);
  const remote = remoteAccessState(project, grant);
  meta.textContent = (options.advanced ? [
    `Local: ${project.lifecycle === "active" ? "Active" : "Inactive"}`,
    `Provider: ${workspaceProviderLabel(project)}`,
    `Remote: ${remote.label}`,
    project.health,
    project.lastKnownBranch,
    project.lastOpenedAt ? new Date(project.lastOpenedAt).toLocaleString() : undefined,
    project.repositoryPath
  ] : [
    project.lifecycle === "active" ? "Active" : "Inactive",
    `Provider: ${workspaceProviderLabel(project)}`,
    project.health
  ]).filter(Boolean).join(" · ");
  body.append(title, meta);
  if (options.advanced) {
    body.append(scopeControls(project, grant, remote));
  }
  const buttons = document.createElement("div");
  buttons.className = "actions";
  const action = project.primaryAction || (project.health === "ok" ? "open" : "remove");
  if (project.lifecycle === "active" || action === "repair") {
    const button = document.createElement("button");
    button.textContent = actionLabel(action);
    button.addEventListener("click", () => void runUiAction({
      id: `workspace-${action}-${project.roadmapId}`,
      pendingMessage: action === "open" ? "Opening Workspace…" : `${actionLabel(action)} in progress…`,
      successMessage: action === "open" ? "Workspace opened." : `${actionLabel(action)} complete.`,
      failureMessage: action === "open" ? "Workspace could not be opened." : `${actionLabel(action)} failed.`,
      controls: [button],
      execute: () => runCommand(action === "open"
        ? ["open-roadmap", project.roadmapId, "--json"]
        : action === "repair"
          ? ["create", project.repositoryPath, "--json"]
          : ["projects", "remove", "--roadmap-id", project.roadmapId])
    }));
    buttons.append(button);
  }
  const lifecycleButton = document.createElement("button");
  lifecycleButton.textContent = project.lifecycle === "inactive" ? "Activate" : "Deactivate";
  lifecycleButton.addEventListener("click", () => void runUiAction({
    id: `workspace-lifecycle-${project.roadmapId}`,
    pendingMessage: `${lifecycleButton.textContent} Workspace…`,
    successMessage: `Workspace ${project.lifecycle === "inactive" ? "activated" : "deactivated"}.`,
    controls: [lifecycleButton],
    execute: () => runCommand(["roadmaps", project.lifecycle === "inactive" ? "activate" : "deactivate", project.roadmapId])
  }));
  buttons.append(lifecycleButton);
  if (options.advanced) {
    const remoteButton = document.createElement("button");
    remoteButton.textContent = remote.enabled ? "Disable Remote Access" : "Enable Remote Access";
    remoteButton.disabled = !remote.available;
    remoteButton.title = remote.available ? remoteButton.textContent : remote.reason;
    remoteButton.className = remote.enabled ? "" : remote.available ? "primary" : "";
    remoteButton.addEventListener("click", () => void runUiAction({
      id: `workspace-remote-${project.roadmapId}`,
      pendingMessage: `${remoteButton.textContent}…`,
      successMessage: `Remote access ${remote.enabled ? "disabled" : "enabled"}.`,
      controls: [remoteButton],
      execute: () => runCommand(["roadmaps", "remote", remote.enabled ? "disable" : "enable", project.roadmapId])
    }));
    buttons.append(remoteButton);
  }
  const removeButton = document.createElement("button");
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => void runUiAction({
    id: `workspace-remove-${project.roadmapId}`,
    pendingMessage: "Removing Workspace…",
    successMessage: "Workspace removed.",
    controls: [removeButton],
    execute: () => runCommand(["roadmaps", "remove", project.roadmapId])
  }));
  buttons.append(removeButton);
  row.append(body, buttons);
  return row;
}

function renderConnection(snapshot) {
  const status = snapshot.status ?? {};
  const localBridgeState = resolvedBridgeControl(snapshot.localBridgeControl, status).state;
  const localBridgeDisplayState = snapshot.localBridgeControl ? localBridgeState : localBridgeState === "not-running" ? "connecting" : localBridgeState;
  const signedIn = !String(status.account ?? "").toLowerCase().includes("signed out");
  connectionEls.localStatus.textContent = `This computer · ${labelLocalBridge(localBridgeDisplayState)}`;
  connectionEls.localStatus.className = localBridgeState === "connected" ? "project-meta status-connected" : localBridgeState === "error" ? "project-meta status-error" : "project-meta status-warning";
  const remoteAccess = status.remoteAccess ?? "Off";
  const remoteOn = remoteAccess === "On" || remoteAccess === "Registered but offline";
  if (!signedIn) {
    connectionEls.remoteStatus.textContent = "Sign in to use this computer from Hunsu Web when away.";
    connectionEls.remoteStatus.className = "project-meta";
    connectionEls.remoteDetail.textContent = "";
    configureConnectionButton(connectionEls.primaryAction, "Sign in to Hunsu", "sign-in", true);
    configureConnectionButton(connectionEls.secondaryAction, "", "", false);
    return;
  }
  if (remoteOn) {
    const publishedCount = publishedWorkspaceCount(snapshot);
    connectionEls.remoteStatus.textContent = `Remote · ${remoteAccess === "On" ? "On" : "Registered but offline"}`;
    connectionEls.remoteStatus.className = remoteAccess === "On" ? "project-meta status-connected" : "project-meta status-warning";
    connectionEls.remoteDetail.textContent = [
      `Device: ${status.device?.name ?? "This computer"}`,
      `Published workspaces: ${publishedCount}`
    ].join("\n");
    configureConnectionButton(connectionEls.primaryAction, "Disable Remote Access", "disable-remote", true);
    configureConnectionButton(connectionEls.secondaryAction, "Sign out", "sign-out", true);
    return;
  }
  connectionEls.remoteStatus.textContent = "Remote · Off";
  connectionEls.remoteStatus.className = "project-meta";
  connectionEls.remoteDetail.textContent = "Use this computer from Hunsu Web when away.";
  configureConnectionButton(connectionEls.primaryAction, "Enable Remote Access", "enable-remote", true);
  configureConnectionButton(connectionEls.secondaryAction, "Sign out", "sign-out", true);
}

function publishedWorkspaceCount(snapshot) {
  const activeWorkspaces = snapshot.workspaces?.active
    ?? (snapshot.managedRoadmaps ?? []).filter(project => project.lifecycle === "active")
    ?? [];
  return activeWorkspaces.length;
}

function configureConnectionButton(button, label, action, visible) {
  button.textContent = label;
  button.dataset.action = action;
  button.hidden = !visible;
  button.disabled = !visible;
}

function renderRuntimeProviders(runtimeProviders, codex) {
  const currentProviderId = runtimeProviders?.currentProviderId ?? "codex";
  const providers = (runtimeProviders?.providers?.length ? runtimeProviders.providers : [{
    providerId: "codex",
    label: "Codex",
    ready: codex?.ready,
    recommendedAction: providerRecommendedActionFromCodex(codex),
    safeMessage: codexSummary(codex)
  }]).map(provider => ({
    group: provider.providerId === currentProviderId ? "Current" : "Coming later",
    label: provider.label,
    status: provider.providerId === currentProviderId
      ? providerStatusSummary(provider)
      : provider.safeMessage ?? providerStatusSummary(provider)
  }));
  runtimeProviderList.replaceChildren(...providers.map(provider => runtimeProviderRow(provider)));
}

function currentRuntimeProvider(runtimeProviders, codex) {
  const currentProviderId = runtimeProviders?.currentProviderId ?? "codex";
  if (runtimeProviders?.current?.providerId === currentProviderId) {
    return runtimeProviders.current;
  }
  const current = runtimeProviders?.providers?.find(provider => provider.providerId === currentProviderId);
  if (current) return current;
  return {
    providerId: "codex",
    label: "Codex",
    ready: codex?.ready,
    recommendedAction: providerRecommendedActionFromCodex(codex),
    safeMessage: codexSummary(codex)
  };
}

function workspaceProviderLabel(project) {
  const provider = project.provider ?? {
    providerId: "codex",
    label: "Codex",
    readyForExecute: project.codex?.readyForExecute
  };
  return `${provider.label} ${provider.readyForExecute ? "Ready" : "Not Ready"}`;
}

function providerRecommendedActionFromCodex(codex) {
  if (codex?.recommendedAction === "install_codex") return "install";
  if (codex?.recommendedAction === "select_binary") return "select_binary";
  if (codex?.recommendedAction === "login_codex") return "login";
  if (codex?.recommendedAction === "recheck") return "recheck";
  return codex?.ready ? "none" : "recheck";
}

function providerStatusSummary(provider) {
  if (provider?.usage?.rateLimited) return "Rate Limited";
  if (provider?.ready) return "Ready";
  if (provider?.recommendedAction === "install") return "Not Found";
  if (provider?.recommendedAction === "select_binary") return "Select Binary";
  if (provider?.recommendedAction === "login") return "Login Required";
  if (provider?.recommendedAction === "configure") return "Setup Required";
  if (provider?.recommendedAction === "recheck") return "Needs Attention";
  return provider?.safeMessage ?? "Unknown";
}

function runtimeProviderRow(provider) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = provider.label;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = `${provider.group} · ${provider.status}`;
  body.append(title, meta);
  row.append(body);
  return row;
}

function grantForProject(project, grants) {
  return grants.find(grant => normalizePath(grant.path) === normalizePath(project.repositoryPath));
}

function remoteAccessState(project, grant) {
  const available = project.lifecycle === "active";
  const scopes = scopesForProject(project, grant);
  const enabled = available && scopes.includes("remoteRelay.access") && grant?.active !== false;
  const reason = available ? undefined : project.remoteAccess?.reason ?? "Inactive Workspaces are not available for Remote Access.";
  return {
    available,
    enabled,
    reason,
    label: enabled ? "On" : available ? "Off" : "Unavailable"
  };
}

function scopesForProject(project, grant) {
  return grant?.scopes ?? project.remoteAccess?.scopes ?? [];
}

function scopeControls(project, grant, remote) {
  const scopes = scopesForProject(project, grant);
  const checks = document.createElement("div");
  checks.className = "scope-checks";
  for (const scope of projectGrantScopes) {
    const item = document.createElement("label");
    const enabled = scopes.includes(scope);
    const scopeManageable = remote.available && (remote.enabled || scope === "remoteRelay.access");
    item.className = enabled ? "scope-on" : "scope-off";
    item.title = scopeManageable ? scope : remote.available ? "Enable Remote Access before changing this scope." : remote.reason;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.disabled = !scopeManageable;
    input.addEventListener("change", () => void runUiAction({
      id: `workspace-scope-${project.roadmapId}-${scope}`,
      pendingMessage: "Updating Workspace access…",
      successMessage: "Workspace access updated.",
      controls: [input],
      execute: () => setRoadmapScope(project, grant, scope, input.checked)
    }));
    item.append(input, document.createTextNode(scope));
    checks.append(item);
  }
  return checks;
}

async function setRoadmapScope(project, grant, scope, enabled) {
  const currentScopes = new Set(scopesForProject(project, grant));
  if (enabled) currentScopes.add(scope);
  else currentScopes.delete(scope);
  if (scope === "remoteRelay.access" && !enabled) {
    return runCommand(["roadmaps", "remote", "disable", project.roadmapId]);
  }
  currentScopes.add("remoteRelay.access");
  const scopes = projectGrantScopes.filter(candidate => currentScopes.has(candidate));
  return runCommand(["roadmaps", "remote", "enable", project.roadmapId, "--scopes", scopes.join(",")]);
}

function normalizePath(path) {
  return String(path ?? "").replace(/\/+$/, "");
}

function renderProviderCard(provider) {
  codexCard.replaceChildren();
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = provider?.label ?? "Provider";
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = providerStatusSummary(provider);
  body.append(title, meta, providerStatusDetails(provider), codexDeviceLoginStatus());
  const buttons = document.createElement("div");
  buttons.className = "actions";
  const configure = document.createElement("button");
  configure.textContent = "Configure";
  configure.addEventListener("click", openProviderConfigDialog);
  buttons.append(configure);
  if (provider?.recommendedAction === "install") {
    const install = document.createElement("button");
    install.className = "primary";
    install.textContent = `Install ${provider.label}`;
    const packageManager = latestSnapshot?.prerequisites?.tools?.packageManager;
    install.disabled = packageManager?.installed !== true;
    install.title = install.disabled
      ? "A package manager is required to install Codex. Select an existing Codex binary instead."
      : "Install Codex through the detected package manager.";
    install.addEventListener("click", () => void runUiAction({
      id: "install-codex",
      pendingMessage: "Installing Codex…",
      successMessage: result => result.code === "CANCELED" ? result.message : "Codex installed.",
      failureMessage: "Codex was not installed.",
      controls: [install],
      execute: async () => {
      if (provider.providerId !== "codex") {
        selectTab("advanced");
        return { ok: true, code: "OK", message: "Provider details opened." };
      }
      const confirmed = window.confirm("Install Codex with the OpenAI Codex npm package now?");
      if (!confirmed) {
        return { ok: true, code: "CANCELED", message: "Codex install was not started." };
      }
        const installArgs = ["codex", "install", "--confirm"];
        return runCommand([...installArgs, "--json"]);
      }
    }));
    buttons.append(install);
    const existing = document.createElement("button");
    existing.textContent = `Select Existing ${provider.label}`;
    existing.addEventListener("click", () => void selectExistingCodex(existing));
    buttons.append(existing);
  }
  if (provider?.recommendedAction === "select_binary") {
    const existing = document.createElement("button");
    existing.className = "primary";
    existing.textContent = `Select Existing ${provider.label}`;
    existing.addEventListener("click", () => void selectExistingCodex(existing));
    buttons.append(existing);
  }
  if (provider?.recommendedAction === "login" && provider.providerId === "codex") {
    const login = document.createElement("button");
    login.className = "primary";
    login.textContent = "Sign in with ChatGPT";
    login.addEventListener("click", () => void startCodexChatGptLogin());
    buttons.append(login);
    const device = document.createElement("button");
    device.textContent = "Use Device Code";
    device.addEventListener("click", () => void startCodexDeviceLogin());
    buttons.append(device);
  }
  const homeDiagnostic = provider?.auth?.homeDiagnostic ?? provider?.diagnostics?.codexHome;
  if (homeDiagnostic?.likelyHomeMismatch && homeDiagnostic?.remediation?.suggestedCodexHome) {
    const useDefaultHome = document.createElement("button");
    useDefaultHome.className = "primary";
    useDefaultHome.textContent = "Use Codex Home";
    useDefaultHome.addEventListener("click", () => void runUiAction({
      id: "use-default-codex-home",
      pendingMessage: "Updating Codex Home…",
      successMessage: "Codex Home updated.",
      controls: [useDefaultHome],
      execute: () => runCommand(["codex", "home", "set", homeDiagnostic.remediation.suggestedCodexHome])
    }));
    buttons.append(useDefaultHome);
  }
  if (providerNeedsAttention(provider)) {
    const recheck = document.createElement("button");
    recheck.className = "primary";
    recheck.textContent = "Recheck";
    recheck.addEventListener("click", () => void runProviderRecheck(provider, recheck));
    buttons.append(recheck);
  }
  if (provider?.recommendedAction === "none") {
    const recheck = document.createElement("button");
    recheck.textContent = "Recheck";
    recheck.addEventListener("click", () => void runProviderRecheck(provider, recheck));
    buttons.append(recheck);
  }
  row.append(body, buttons);
  codexCard.append(row);
  const advancedDetails = providerAdvancedDetails(provider);
  if (advancedDetails) {
    codexCard.append(advancedDetails);
  }
}

function selectExistingCodex(button) {
  return runUiAction({
    id: "select-existing-codex",
    pendingMessage: "Selecting Codex…",
    successMessage: result => result.code === "CANCELED" ? result.message : "Codex binary selected.",
    failureMessage: "Codex binary could not be selected.",
    controls: [button],
    execute: chooseCodexBinary
  });
}

function providerStatusDetails(provider) {
  const container = document.createElement("div");
  container.className = "message";
  const codexHome = provider?.auth?.homeDiagnostic ?? provider?.diagnostics?.codexHome;
  const effectiveEnv = provider?.diagnostics?.effectiveEnv ?? {};
  container.textContent = [
    provider?.safeMessage,
    effectiveEnv.CODEX_HOME ? `Codex Home: ${effectiveEnv.CODEX_HOME}` : codexHome?.effectiveCodexHome ? `Codex Home: ${codexHome.effectiveCodexHome}` : undefined,
    codexHome ? `Auth file at Codex Home: ${codexHome.authFileExistsAtEffectiveHome ? "Present" : "Missing"}` : undefined,
    codexHome?.likelyHomeMismatch ? codexHome.remediation?.message : undefined,
    provider?.recommendedAction === "install" && latestSnapshot?.prerequisites?.tools?.packageManager?.installed !== true
      ? "A package manager is not installed. It is optional for Bridge, but required to install Codex through npm. You can select an existing Codex binary instead."
      : undefined
  ].filter(Boolean).join("\n");
  return container;
}

function providerNeedsAttention(provider) {
  return provider
    && !provider.ready
    && provider.recommendedAction !== "install"
    && provider.recommendedAction !== "select_binary"
    && provider.recommendedAction !== "login";
}

function runProviderRecheck(provider, button) {
  return runUiAction({
    id: `recheck-${provider?.providerId ?? "provider"}`,
    pendingMessage: provider?.providerId === "codex" ? "Rechecking Codex…" : "Rechecking provider…",
    successMessage: () => recheckSuccessMessage(provider?.providerId),
    failureMessage: provider?.providerId === "codex" ? "Recheck failed." : "Provider recheck failed.",
    controls: [button],
    includeCompletionTime: true,
    execute: () => runCommand(provider?.providerId === "codex" ? ["codex", "recheck", "--json"] : ["snapshot"])
  });
}

function recheckSuccessMessage(providerId) {
  const codex = latestSnapshot?.prerequisites?.codex;
  const current = currentRuntimeProvider(latestSnapshot?.providers ?? latestSnapshot?.runtimeProviders, codex);
  if (providerId !== "codex") {
    return current.ready ? "Recheck complete: Provider is ready." : "Recheck complete: Provider needs attention.";
  }
  if (current.ready) return "Recheck complete: Codex is ready.";
  if (current.recommendedAction === "login" || codex?.recommendedAction === "login_codex") {
    return "Recheck complete: Login required.";
  }
  return "Recheck complete: Codex needs attention.";
}

function providerAdvancedDetails(provider) {
  if (provider?.providerId !== "codex") {
    return undefined;
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Advanced provider details";
  const detailRows = document.createElement("div");
  detailRows.className = "project-meta";
  detailRows.textContent = [
    provider?.install?.binaryPath ? `Binary path: ${provider.install.binaryPath}` : "Binary path: Auto-detect",
    provider?.install?.source ? `Source: ${provider.install.source}` : undefined,
    provider?.install?.version ? `Version: ${provider.install.version}` : undefined,
    provider?.diagnostics?.effectiveEnv?.CODEX_HOME ? `Effective CODEX_HOME: ${provider.diagnostics.effectiveEnv.CODEX_HOME}` : undefined,
    provider?.diagnostics?.effectiveEnv?.HUNSU_CODEX_APP_SERVER_COMMAND ? `App-server command: ${provider.diagnostics.effectiveEnv.HUNSU_CODEX_APP_SERVER_COMMAND}` : undefined,
    `Auth access: ${formatProviderAccess(provider)}`,
    `Rate limit summary: ${formatProviderRateLimit(provider)}`
  ].filter(Boolean).join("\n");
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.setAttribute("style", "margin-top: 10px;");
  const apiKey = document.createElement("button");
  apiKey.textContent = "Use API Key - Advanced";
  apiKey.addEventListener("click", () => void startCodexApiKeyLogin());
  actions.append(apiKey);
  details.append(summary, detailRows, actions);
  return details;
}

async function startCodexChatGptLogin() {
  latestCodexDeviceLoginResult = {
    kind: "chatgpt",
    status: "pending",
    message: "Codex login started.",
    lastOutput: "Browser login started. Complete sign-in, then click Recheck."
  };
  renderProviderCard(currentRuntimeProvider(latestSnapshot?.providers ?? latestSnapshot?.runtimeProviders, latestSnapshot?.prerequisites?.codex));
  try {
    await spawn(["codex", "login"]);
  } catch (error) {
    latestCodexDeviceLoginResult = {
      kind: "chatgpt",
      status: "failed",
      message: "Codex login failed to start.",
      error: safeDiagnosticText(error?.message ?? String(error))
    };
  }
  await refresh();
}

async function startCodexDeviceLogin() {
  latestCodexDeviceLoginResult = {
    state: "pending",
    message: "Starting Codex device login..."
  };
  renderProviderCard(currentRuntimeProvider(latestSnapshot?.providers ?? latestSnapshot?.runtimeProviders, latestSnapshot?.prerequisites?.codex));
  try {
    await spawn(["codex", "login", "--device", "--background"]);
    latestCodexDeviceLoginResult = {
      state: "pending",
      message: "Codex device login started."
    };
  } catch (error) {
    latestCodexDeviceLoginResult = {
      state: "failed",
      message: safeDiagnosticText(error?.message ?? String(error))
    };
  }
  renderProviderCard(currentRuntimeProvider(latestSnapshot?.providers ?? latestSnapshot?.runtimeProviders, latestSnapshot?.prerequisites?.codex));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(750);
    await refresh();
    if (latestCodexDeviceLoginResult?.state === "device_code" || latestCodexDeviceLoginResult?.state === "failed") {
      break;
    }
  }
}

async function startCodexApiKeyLogin() {
  latestCodexDeviceLoginResult = {
    kind: "api_key",
    status: "pending",
    message: "Codex API-key configuration started.",
    lastOutput: "Complete API-key configuration, then click Recheck."
  };
  renderProviderCard(currentRuntimeProvider(latestSnapshot?.providers ?? latestSnapshot?.runtimeProviders, latestSnapshot?.prerequisites?.codex));
  try {
    diagnostics.textContent = await run(["codex", "login", "--api-key"]);
  } catch (error) {
    latestCodexDeviceLoginResult = {
      kind: "api_key",
      status: "failed",
      message: "Codex API-key configuration failed to start.",
      error: safeDiagnosticText(error?.message ?? String(error))
    };
  }
  await refresh();
}

function codexDeviceLoginStatus() {
  const result = latestCodexDeviceLoginResult;
  const container = document.createElement("div");
  if (!result) {
    return container;
  }
  container.className = "message";
  if (result.kind === "chatgpt" || result.kind === "api_key") {
    const failed = result.status === "failed" || result.state === "failed";
    const lines = [
      failed ? result.message || "Codex login failed to start." : result.message || "Codex login started.",
      failed ? result.error : result.kind === "api_key" ? "Complete API-key configuration, then click Recheck." : "Complete sign-in in your browser, then click Recheck."
    ].filter(Boolean);
    container.textContent = lines.join("\n");
    if (failed) {
      container.className = "message status-error";
    }
    return container;
  }
  const failed = result.state === "failed" || result.status === "failed";
  const lines = [
    failed ? result.message || "Codex device login failed. Start device login again or run Recheck after completing sign-in." : result.message,
    failed && result.error ? `Error: ${result.error}` : undefined,
    result.verificationUriComplete || result.verificationUri ? `Verification URL: ${result.verificationUriComplete || result.verificationUri}` : undefined,
    result.userCode ? `Code: ${result.userCode}` : undefined,
    result.state ? `Status: ${formatDeviceLoginState(result.state)}` : undefined,
    failed && result.lastOutput ? `Last output: ${result.lastOutput}` : undefined
  ].filter(Boolean);
  container.textContent = lines.join("\n");
  if (failed) {
    container.className = "message status-error";
  }
  return container;
}

function parseJsonResult(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return undefined;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDeviceLoginState(state) {
  if (state === "device_code") return "Waiting for authorization";
  if (state === "pending") return "Pending";
  if (state === "failed") return "Failed";
  return state;
}

function renderToolCards(tools) {
  gitCard.replaceChildren(toolRow("Git", tools?.git));
  nodeCard.replaceChildren(
    embeddedRuntimeRow(tools?.embeddedRuntime),
    optionalSystemNodeRow(tools?.systemNode),
    optionalPackageManagerRow(tools?.packageManager)
  );
}

function embeddedRuntimeRow(runtime) {
  return labeledToolRow(
    "Embedded runtime",
    [`Node ${runtime?.version ?? "version unavailable"}`, "Bundled with Hunsu Bridge"].join(" · ")
  );
}

function optionalSystemNodeRow(systemNode) {
  const status = systemNode?.installed
    ? [`Node ${systemNode.version ?? "version unavailable"}`, "Optional"].join(" · ")
    : "Not installed · Optional";
  return labeledToolRow("System Node", status);
}

function optionalPackageManagerRow(packageManager) {
  const installedLabel = packageManager?.installed
    ? [packageManager.name ?? "Installed", packageManager.version].filter(Boolean).join(" ")
    : "Not installed";
  return labeledToolRow(
    "Package manager",
    `${installedLabel} · Optional unless installing Codex through npm`
  );
}

function labeledToolRow(titleText, text) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = titleText;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = text;
  body.append(title, meta);
  row.append(body);
  return row;
}

function toolRow(titleText, tool) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = titleText;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = [
    tool?.installed ? "Installed" : "Missing",
    tool?.version,
    tool?.binaryPath,
    tool?.error
  ].filter(Boolean).join(" · ");
  body.append(title, meta);
  row.append(body);
  return row;
}

function renderVersions(snapshot) {
  const versions = snapshot.versions ?? {};
  versionEls.bridgeApp.textContent = versionLabel(versions.bridgeApp);
  versionEls.bridgeRuntime.textContent = versionLabel(versions.bridgeRuntime);
  versionEls.protocol.textContent = versionLabel(versions.protocol);
  versionEls.embeddedNode.textContent = versionLabel(versions.embeddedNode);
  versionEls.codexCli.textContent = versionLabel(versions.codexCli);
}

function versionLabel(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.version === "string") return value.version;
  return "Unavailable";
}

function codexSummary(codex) {
  if (!codex) return "Unknown";
  if (codex.usage?.rateLimited) return "Rate Limited";
  if (codex.ready) return "Ready";
  if (codex.recommendedAction === "install_codex") return "Not Found";
  if (codex.recommendedAction === "select_binary") return "Select Binary";
  if (codex.recommendedAction === "login_codex") return "Login Required";
  if (!codex.appServer?.available) return "App Server Unavailable";
  return "Needs Attention";
}

function formatCodexAccess(codex) {
  if (codex?.usage?.rateLimited) return "Temporarily unavailable";
  if (codex?.auth?.access === "subscription") return "Subscription";
  if (codex?.auth?.access === "usage_based") return "Usage-based";
  return "Unknown";
}

function formatProviderAccess(provider) {
  if (provider?.usage?.rateLimited) return "Temporarily unavailable";
  if (provider?.auth?.access === "subscription") return "Subscription";
  if (provider?.auth?.access === "usage_based") return "Usage-based";
  if (provider?.auth?.access === "gateway") return "Gateway";
  if (provider?.auth?.access === "local") return "Local";
  return "Unknown";
}

function formatProviderRateLimit(provider) {
  const summary = provider?.usage?.summary;
  if (!provider?.usage?.available && !summary) return "Unavailable";
  return [
    summary?.label ?? "Available",
    summary?.remainingLabel,
    summary?.resetAt ? `Reset ${summary.resetAt}` : undefined
  ].filter(Boolean).join(", ");
}

function formatRateLimit(codex) {
  const summary = codex?.usage?.rateLimitSummary;
  if (!summary) return codex?.usage?.rateLimitsAvailable ? "Available" : "Unavailable";
  return [
    summary.label,
    summary.remainingLabel,
    summary.resetAt ? `Reset ${summary.resetAt}` : undefined
  ].filter(Boolean).join(", ");
}

function formatUsage(usage) {
  return `input ${usage.inputTokens}, cached ${usage.cachedInputTokens}, output ${usage.outputTokens}, reasoning ${usage.reasoningTokens}`;
}

function renderCodexSettings(providerConfig, settings, legacyCodexSettings) {
  codexInstallChannel.value = settings?.installChannel ?? "stable";
  const metadata = providerConfig?.metadata;
  if (!metadata?.configKeys?.length || !providerConfigForm) {
    return;
  }
  latestProviderConfigMetadata = metadata;
  const savedFields = new Map((providerConfig.fields ?? []).map(field => [field.key, field]));
  providerConfigFieldElements.clear();
  const sections = [];
  const primaryKeys = metadata.configKeys.filter(key => key.primary);
  const authenticationKeys = metadata.configKeys.filter(key => key.name === "authenticationPreference");
  const advancedKeys = metadata.configKeys.filter(key => key.advanced);
  if (primaryKeys.length > 0) {
    sections.push(providerConfigSection("Primary", primaryKeys, savedFields, settings, legacyCodexSettings));
  }
  if (authenticationKeys.length > 0) {
    sections.push(providerConfigSection("Authentication", authenticationKeys, savedFields, settings, legacyCodexSettings));
  }
  if (advancedKeys.length > 0) {
    sections.push(providerConfigSection("Advanced", advancedKeys, savedFields, settings, legacyCodexSettings, { collapsed: true }));
  }
  providerConfigForm.replaceChildren(...sections);
  codexBinaryPath = providerConfigFieldElements.get("binaryPath");
  codexEnvHome = providerConfigFieldElements.get("codexHome");
}

function providerConfigSection(titleText, keys, savedFields, settings, legacyCodexSettings, options = {}) {
  const section = options.collapsed ? document.createElement("details") : document.createElement("div");
  section.className = "grid";
  const title = options.collapsed ? document.createElement("summary") : document.createElement("h3");
  title.textContent = titleText;
  section.append(title, ...keys.flatMap(key => providerConfigControls(key, savedFields, settings, legacyCodexSettings)));
  return section;
}

function providerConfigControls(key, savedFields, settings, legacyCodexSettings) {
  const label = document.createElement("label");
  const meta = document.createElement("span");
  meta.className = "project-meta";
  meta.textContent = key.envName ? `${key.label} · ${key.envName}` : key.label;
  const control = providerConfigControl(key);
  control.value = providerConfigFieldValue(key, savedFields, settings, legacyCodexSettings);
  label.append(meta, control);
  providerConfigFieldElements.set(key.name, control);
  const controls = [label];
  const picker = providerConfigPicker(key);
  if (picker) {
    controls.push(picker);
  }
  return controls;
}

function providerConfigControl(key) {
  if (key.kind === "select") {
    const select = document.createElement("select");
    select.id = codexConfigElementId(key.name);
    select.dataset.providerConfigKey = key.name;
    for (const option of key.options ?? []) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    return select;
  }
  const input = document.createElement("input");
  input.id = codexConfigElementId(key.name);
  input.dataset.providerConfigKey = key.name;
  input.type = key.secret ? "password" : "text";
  input.placeholder = key.placeholder ?? key.default ?? "";
  return input;
}

function providerConfigPicker(key) {
  if (key.kind !== "file" && key.kind !== "directory") {
    return undefined;
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.id = key.name === "binaryPath" ? "choose-codex-binary" : key.name === "codexHome" ? "choose-codex-home" : `choose-${key.name}`;
  button.textContent = key.kind === "directory" ? `Choose ${key.label}` : `Choose ${key.label}`;
  button.addEventListener("click", () => void runUiAction({
    id: `choose-provider-config-${key.name}`,
    pendingMessage: `Choosing ${key.label}…`,
    successMessage: `${key.label} selected. Save to apply it.`,
    failureMessage: `${key.label} could not be selected.`,
    refreshAfter: false,
    feedbackElement: providerConfigStatus,
    controls: [button],
    execute: async () => {
      if (key.name === "codexHome") await chooseCodexHome();
      else await chooseCodexBinaryForSettings();
      return { ok: true, code: "OK", message: `${key.label} selected.` };
    }
  }));
  actions.append(button);
  return actions;
}

function providerConfigFieldValue(key, savedFields, settings, legacyCodexSettings) {
  const saved = savedFields.get(key.name);
  if (typeof saved?.value === "string") {
    return saved.value;
  }
  if (typeof saved?.value === "boolean") {
    return String(saved.value);
  }
  if (key.name === "binaryPath") {
    return settings?.binaryPath ?? legacyCodexSettings?.binaryPath ?? "";
  }
  if (key.name === "codexHome") {
    return settings?.codexHome ?? settings?.environment?.CODEX_HOME ?? "";
  }
  if (key.name === "appServerCommand") {
    return settings?.appServerCommand ?? settings?.environment?.HUNSU_CODEX_APP_SERVER_COMMAND ?? "";
  }
  if (key.name === "appServerArgs") {
    return settings?.appServerArgs ?? settings?.environment?.HUNSU_CODEX_APP_SERVER_ARGS ?? "";
  }
  if (key.name === "authenticationPreference") {
    return settings?.authenticationPreference ?? key.default ?? "";
  }
  return key.default ?? "";
}

function codexConfigElementId(key) {
  if (key === "binaryPath") return "codex-binary-path";
  if (key === "codexHome") return "codex-env-home";
  if (key === "appServerCommand") return "codex-env-command";
  if (key === "appServerArgs") return "codex-env-args";
  if (key === "authenticationPreference") return "codex-auth-preference";
  return `provider-config-${key}`;
}

function codexProviderConfigFields() {
  return (latestProviderConfigMetadata?.configKeys ?? []).map(key => {
    const control = providerConfigFieldElements.get(key.name);
    const raw = control?.type === "checkbox" ? control.checked : control?.value;
    const value = String(raw ?? "").trim();
    return {
      key: key.name,
      value,
      isSet: value !== "",
      isSecret: key.secret === true
    };
  });
}

async function validateCodexConfig() {
  const result = await runCommand(["provider", "config", "validate-json", JSON.stringify(codexProviderConfigFields()), "--json"]);
  if (!result.ok) return result;
  applyProviderValidationErrors(result.value);
  if (result.value?.valid === false) {
    return {
      ok: false,
      code: "PROVIDER_CONFIG_INVALID",
      message: result.value.provider?.safeMessage ?? "Review the highlighted provider settings."
    };
  }
  return result;
}

function applyProviderValidationErrors(validation) {
  for (const control of providerConfigFieldElements.values()) {
    control.setAttribute("aria-invalid", "false");
    control.title = "";
  }
  const errors = Array.isArray(validation?.errors)
    ? validation.errors
    : Array.isArray(validation?.issues)
      ? validation.issues
      : validation?.fieldErrors && typeof validation.fieldErrors === "object"
        ? Object.entries(validation.fieldErrors).map(([field, message]) => ({ field, message }))
        : [];
  for (const error of errors) {
    const key = error?.field ?? error?.key ?? error?.path;
    const control = providerConfigFieldElements.get(key);
    if (!control) continue;
    control.setAttribute("aria-invalid", "true");
    control.title = safeDiagnosticText(error?.message ?? "Review this value.");
  }
}

async function saveCodexConfig() {
  const saved = await runCommand(["provider", "config", "save-json", JSON.stringify(codexProviderConfigFields()), "--json"]);
  if (!saved.ok) return saved;
  const settings = await runCommand([
    "codex",
    "settings",
    "set",
    "--install-channel",
    codexInstallChannel.value
  ]);
  return settings.ok ? saved : settings;
}

function openProviderConfigDialog() {
  if (providerConfigDialog) {
    providerConfigDialog.hidden = false;
  }
  const focusTarget = codexBinaryPath ?? providerConfigForm?.querySelector("input, select, button");
  focusTarget?.focus();
}

function closeProviderConfigDialog() {
  if (providerConfigDialog) {
    providerConfigDialog.hidden = true;
  }
}

function projectGrantRows(grants) {
  if (!grants.length) {
    const empty = document.createElement("div");
    empty.className = "empty-row";
    empty.textContent = "No Project Grants.";
    return [empty];
  }
  return grants.map(projectGrantRow);
}

function projectGrantRow(grant) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = grant.path;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = [
    Array.isArray(grant.scopes) ? grant.scopes.join(", ") : undefined,
    grant.grantedAt ? new Date(grant.grantedAt).toLocaleString() : undefined
  ].filter(Boolean).join(" · ");
  body.append(title, meta);
  row.append(body);
  return row;
}

function actionLabel(action) {
  if (action === "open") return "Open";
  if (action === "port") return "Port";
  if (action === "create") return "Create";
  if (action === "repair") return "Repair";
  if (action === "explain") return "Explain";
  return "Remove";
}

function labelLocalBridge(value) {
  if (value === "connected") return "Connected";
  if (value === "starting") return "Starting";
  if (value === "stopping") return "Stopping";
  if (value === "not-running") return "Not running";
  if (value === "connecting") return "Connecting";
  if (value === "error") return "Error";
  return "Unknown";
}

function providerConnectionSummary(status) {
  const local = `Local · ${labelLocalBridge(status?.localBridge)}`;
  const remoteAccess = status?.remoteAccess ?? "Off";
  const remote = `Remote · ${remoteAccess === "On" ? "On" : remoteAccess === "Registered but offline" ? "Registered but offline" : "Off"}`;
  return `${local}\n${remote}`;
}

function formatQuitBehavior(value) {
  return value === "stop-background" ? "Stop background service on quit" : "Keep background service running";
}

async function inspectSelectedFolder(path) {
  const stdout = await run(["inspect", path, "--json"]);
  selectedInspection = JSON.parse(stdout).project;
  renderSelectedInspection(path);
  renderSelectedProjectAction();
}

function renderSelectedInspection(fallbackPath) {
  if (!selectedInspection) {
    selectedProject.textContent = "No folder selected.";
    return;
  }
  const details = [
    formatProjectKind(selectedInspection.kind),
    selectedInspection.path || fallbackPath,
    selectedInspection.branch ? `Branch: ${selectedInspection.branch}` : undefined,
    selectedInspection.clean === undefined ? undefined : selectedInspection.clean ? "Clean" : "Dirty",
    selectedInspection.health ? `Health: ${selectedInspection.health}` : undefined,
    selectedInspection.stackHints?.length ? `Stack: ${selectedInspection.stackHints.join(", ")}` : undefined,
    selectedInspection.reason
  ].filter(Boolean);
  selectedProject.textContent = details.join(" · ");
}

function renderSelectedProjectAction() {
  if (!selectedInspection) {
    selectedProjectAction.textContent = "Select a Folder";
    selectedProjectAction.disabled = true;
    selectedProjectAction.className = "";
    return;
  }
  selectedProjectAction.textContent = actionLabel(selectedInspection.recommendedAction);
  selectedProjectAction.disabled = false;
  selectedProjectAction.className = "primary";
}

function formatProjectKind(kind) {
  if (kind === "hunsu-roadmap") return "Existing Hunsu Roadmap";
  if (kind === "git-project") return "Git project";
  if (kind === "new-project") return "New project folder";
  if (kind === "missing-roadmap") return "Missing Roadmap";
  return "Unsupported folder";
}

async function runSelectedAction() {
  if (!selectedInspection) {
    await open("hunsu://open-project");
    return { ok: true, code: "OK", message: "Workspace chooser opened." };
  }
  const path = selectedInspection.path;
  const action = selectedInspection.recommendedAction;
  if (action === "explain") {
    diagnostics.textContent = JSON.stringify({ project: selectedInspection }, null, 2);
    return { ok: true, code: "OK", message: "Workspace details shown." };
  }
  if (action === "remove") {
    if (selectedInspection.roadmapId) {
      return runCommand(["projects", "remove", "--roadmap-id", selectedInspection.roadmapId]);
    } else {
      return runCommand(["projects", "remove", "--path", path]);
    }
  }
  if (action === "open") return runCommand(["open-project", path, "--json"]);
  if (action === "port") return runCommand(["port", path, "--json"]);
  if (action === "create" || action === "repair") return runCommand(["create", path, "--json"]);
  return { ok: false, code: "WORKSPACE_ACTION_UNAVAILABLE", message: "No Workspace action is available." };
}

document.querySelector("#refresh").addEventListener("click", () => void runUiAction({
  id: "refresh",
  pendingMessage: "Refreshing Bridge status…",
  successMessage: "Bridge status refreshed.",
  refreshAfter: false,
  controls: [document.querySelector("#refresh")],
  execute: async () => {
    await refresh({ rethrow: true });
    return { ok: true, code: "OK", message: "Bridge status refreshed." };
  }
}));
for (const pairButton of [document.querySelector("#open-studio"), document.querySelector("#open-studio-connection")]) {
  pairButton.addEventListener("click", () => void runUiAction({
    id: "open-hunsu-web",
    pendingMessage: "Opening Hunsu Web…",
    successMessage: "Hunsu Web opened.",
    failureMessage: "Hunsu Web could not be opened.",
    controls: [pairButton],
    execute: () => runCommand(["pair", "--json"])
  }));
}
selectedProjectAction.addEventListener("click", () => void runUiAction({
  id: "selected-workspace-action",
  pendingMessage: "Updating Workspace…",
  successMessage: "Workspace action complete.",
  failureMessage: "Workspace action failed.",
  controls: [selectedProjectAction],
  execute: runSelectedAction
}));
document.querySelector("#enable-remote").addEventListener("click", event => void runUiAction({
  id: "enable-remote",
  pendingMessage: "Enabling Remote Access…",
  successMessage: "Remote Access enabled.",
  controls: [event.currentTarget],
  execute: () => runCommand(["remote", "enable"])
}));
document.querySelector("#disable-remote").addEventListener("click", event => void runUiAction({
  id: "disable-remote",
  pendingMessage: "Disabling Remote Access…",
  successMessage: "Remote Access disabled.",
  controls: [event.currentTarget],
  execute: () => runCommand(["remote", "disable"])
}));
connectionEls.primaryAction.addEventListener("click", event => void runConnectionActionWithFeedback(event));
connectionEls.secondaryAction.addEventListener("click", event => void runConnectionActionWithFeedback(event));
document.querySelector("#install-protocol").addEventListener("click", event => void runUiAction({
  id: "install-protocol",
  pendingMessage: "Installing hunsu:// handler…",
  successMessage: "hunsu:// handler installed.",
  controls: [event.currentTarget],
  execute: () => runCommand(["protocol", "install"])
}));
startBridgeButton.addEventListener("click", () => void runUiAction({
  id: "start-bridge",
  pendingMessage: "Starting Bridge…",
  successMessage: "Bridge is connected.",
  failureMessage: "Bridge could not be started.",
  refreshAfter: false,
  controls: [startBridgeButton, stopBridgeButton],
  execute: startManagedBridge
}));
stopBridgeButton.addEventListener("click", () => void runUiAction({
  id: "stop-bridge",
  pendingMessage: "Stopping Bridge…",
  successMessage: "Bridge stopped.",
  failureMessage: "Bridge could not be stopped.",
  refreshAfter: false,
  controls: [startBridgeButton, stopBridgeButton],
  execute: stopManagedBridge
}));

async function startManagedBridge() {
  const result = await runCommand(["ensure-running", "--json"]);
  if (!result.ok) return result;
  return waitForBridgeControl(
    control => control.state === "connected" && control.ownership === "managed",
    "BRIDGE_START_TIMEOUT",
    "Bridge did not become connected in time.",
    result
  );
}

async function stopManagedBridge() {
  const result = await runCommand(["stop", "--json"]);
  if (!result.ok) return result;
  return waitForBridgeControl(
    control => control.state === "not-running",
    "BRIDGE_STOP_TIMEOUT",
    "Bridge did not stop in time.",
    result
  );
}

async function waitForBridgeControl(predicate, timeoutCode, timeoutMessage, result) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await refresh({ rethrow: true });
    if (snapshot && predicate(resolvedBridgeControl(snapshot.localBridgeControl, snapshot.status))) {
      return result;
    }
    await delay(250);
  }
  return { ok: false, code: timeoutCode, message: timeoutMessage };
}
async function chooseProjectFolder() {
  if (!invoke) return { ok: false, code: "TAURI_UNAVAILABLE", message: "The desktop folder chooser is unavailable." };
  const folder = await invoke("choose_project_folder");
  if (folder?.path) {
    await inspectSelectedFolder(folder.path);
    return { ok: true, code: "OK", message: "Workspace selected." };
  }
  return { ok: true, code: "CANCELED", message: "No Workspace was selected." };
}

async function chooseCodexBinary() {
  if (!invoke) {
    openProviderConfigDialog();
    codexBinaryPath?.focus();
    return { ok: true, code: "OK", message: "Codex configuration opened." };
  }
  const binary = await invoke("choose_codex_binary");
  if (!binary?.path) {
    return { ok: true, code: "CANCELED", message: "No Codex binary was selected." };
  }
  return runCommand(["codex", "path", "set", binary.path]);
}

async function chooseCodexBinaryForSettings() {
  if (!invoke) {
    codexBinaryPath?.focus();
    return;
  }
  const binary = await invoke("choose_codex_binary");
  if (binary?.path && codexBinaryPath) {
    codexBinaryPath.value = binary.path;
  }
}

async function chooseCodexHome() {
  if (!invoke) {
    codexEnvHome?.focus();
    return;
  }
  const folder = await invoke("choose_codex_home");
  if (folder?.path && codexEnvHome) {
    codexEnvHome.value = folder.path;
  }
}

document.querySelector("#choose-folder").addEventListener("click", event => void runUiAction({
  id: "choose-workspace",
  pendingMessage: "Choosing a Workspace…",
  successMessage: result => result.code === "CANCELED" ? result.message : "Workspace selected.",
  failureMessage: "Workspace could not be selected.",
  controls: [event.currentTarget],
  execute: chooseProjectFolder
}));

async function runConnectionAction(event) {
  const action = event?.currentTarget?.dataset?.action;
  if (action === "sign-in") {
    return runCommand(["login", "--gui"]);
  } else if (action === "enable-remote") {
    return runCommand(["remote", "enable"]);
  } else if (action === "disable-remote") {
    return runCommand(["remote", "disable"]);
  } else if (action === "sign-out") {
    return runCommand(["logout"]);
  }
  return { ok: false, code: "CONNECTION_ACTION_UNAVAILABLE", message: "No connection action is available." };
}

function runConnectionActionWithFeedback(event) {
  const action = event?.currentTarget?.dataset?.action;
  const labels = {
    "sign-in": ["Starting sign in…", "Sign in opened."],
    "enable-remote": ["Enabling Remote Access…", "Remote Access enabled."],
    "disable-remote": ["Disabling Remote Access…", "Remote Access disabled."],
    "sign-out": ["Signing out…", "Signed out."]
  };
  const [pendingMessage, successMessage] = labels[action] ?? ["Updating connection…", "Connection updated."];
  return runUiAction({
    id: `connection-${action ?? "unknown"}`,
    pendingMessage,
    successMessage,
    controls: [event?.currentTarget],
    execute: () => runConnectionAction(event)
  });
}

copyDiagnosticsButton.addEventListener("click", () => void runUiAction({
  id: "copy-diagnostics",
  pendingMessage: "Preparing fresh diagnostics…",
  successMessage: "Diagnostics copied.",
  failureMessage: "Diagnostics were not copied.",
  refreshAfter: false,
  controls: [copyDiagnosticsButton],
  execute: copyFreshDiagnostics
}));

async function copyFreshDiagnostics() {
  const result = await runCommand(["diagnostics", "--json"]);
  if (!result.ok) return result;
  try {
    const payload = typeof result.value === "string" ? parseJsonResult(result.value) ?? result.value : result.value;
    assertDiagnosticsSafe(payload);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? {}, null, 2);
    assertDiagnosticTextSafe(text);
    await navigator.clipboard.writeText(text);
    diagnostics.textContent = text;
    return result;
  } catch (_error) {
    await runCommand(["diagnostics-redaction-blocked", "--json"]);
    return {
      ok: false,
      code: "DIAGNOSTICS_SENSITIVE_DATA_DETECTED",
      message: "Diagnostics could not be copied because sensitive data was detected."
    };
  }
}
providerConfigSettingsOpen?.addEventListener("click", openProviderConfigDialog);
providerConfigClose?.addEventListener("click", closeProviderConfigDialog);
providerConfigDialog?.addEventListener("click", event => {
  if (event.target === providerConfigDialog) {
    closeProviderConfigDialog();
  }
});
document.querySelector("#validate-codex-config").addEventListener("click", event => void runUiAction({
  id: "validate-codex-config",
  pendingMessage: "Validating configuration…",
  successMessage: "Configuration is valid.",
  failureMessage: "Configuration is invalid.",
  refreshAfter: false,
  feedbackElement: providerConfigStatus,
  controls: [event.currentTarget],
  execute: validateCodexConfig
}));
document.querySelector("#save-codex-config").addEventListener("click", event => void saveCodexConfigWithFeedback(event.currentTarget));
async function saveCodexConfigWithFeedback(button) {
  const result = await runUiAction({
    id: "save-codex-config",
    pendingMessage: "Saving provider configuration…",
    successMessage: "Provider configuration saved.",
    failureMessage: "Provider configuration was not saved.",
    feedbackElement: providerConfigStatus,
    controls: [button],
    execute: saveCodexConfig
  });
  if (result.ok) {
    closeProviderConfigDialog();
  }
  return result;
}
document.querySelector("#reset-codex-config").addEventListener("click", event => void runUiAction({
  id: "reset-codex-config",
  pendingMessage: "Resetting provider configuration…",
  successMessage: "Provider configuration reset.",
  failureMessage: "Provider configuration was not reset.",
  feedbackElement: providerConfigStatus,
  controls: [event.currentTarget],
  execute: () => runCommand(["provider", "config", "reset"])
}));
quitBehaviorSelect?.addEventListener("change", () => void runUiAction({
  id: "quit-behavior",
  pendingMessage: "Saving quit behavior…",
  successMessage: "Quit behavior saved.",
  controls: [quitBehaviorSelect],
  execute: () => runCommand(["settings", "quit-behavior", "set", quitBehaviorSelect.value])
}));

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => {
    selectTab(tab.dataset.tab);
  });
}

function selectTab(tabName) {
  if (!tabName) return;
  const canonical = canonicalTabName(tabName);
  for (const candidate of document.querySelectorAll("[data-tab]")) {
    candidate.setAttribute("aria-selected", String(candidate.dataset.tab === canonical));
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== canonical;
  }
}

function canonicalTabName(tabName) {
  if (tabName === "overview" || tabName === "prerequisites") return "provider";
  if (tabName === "roadmaps") return "workspaces";
  if (tabName === "remote") return "advanced";
  return tabName;
}

void refresh();
window.setInterval(refresh, 3000);

if (listen) {
  void listen("bridge-operation-completed", event => {
    const result = normalizeCommandOutput(event?.payload, ["background-operation"]);
    showActionFeedback(result.ok ? "success" : "error", result.message);
    void refresh();
  }).catch(error => {
    showActionFeedback("error", safeDiagnosticText(error?.message ?? String(error)));
  });
}
