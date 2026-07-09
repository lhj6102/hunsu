const invoke = window.__TAURI__?.core?.invoke;
const diagnostics = document.querySelector("#diagnostics");
const statusEls = {
  localBridge: document.querySelector("#local-bridge"),
  codexSummary: document.querySelector("#codex-summary"),
  activeRoadmaps: document.querySelector("#active-roadmaps"),
  account: document.querySelector("#account"),
  remoteAccess: document.querySelector("#remote-access"),
  device: document.querySelector("#device"),
  service: document.querySelector("#service")
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
const codexBinaryPath = document.querySelector("#codex-binary-path");
const codexInstallChannel = document.querySelector("#codex-install-channel");
const codexAuthPreference = document.querySelector("#codex-auth-preference");
const codexEnvHome = document.querySelector("#codex-env-home");
const codexEnvCommand = document.querySelector("#codex-env-command");
const codexEnvArgs = document.querySelector("#codex-env-args");
let latestSnapshot = undefined;
let selectedInspection = undefined;
let lastHandledUiIntentId = undefined;
let latestCodexDeviceLoginResult = undefined;
let localBridgeAutoStartAttempted = false;
const projectGrantScopes = ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"];

async function open(url) {
  if (invoke) await invoke("open_external", { url });
  else window.location.href = url;
}

async function run(args) {
  if (!invoke) throw new Error("Tauri invoke is unavailable.");
  const output = await invoke("run_bridge_app_command", { input: { args } });
  if (output.status !== 0) {
    throw new Error(output.stderr || output.stdout || `Command failed: ${args.join(" ")}`);
  }
  return output.stdout;
}

async function spawn(args) {
  if (!invoke) {
    await open(`hunsu://${args[0]}`);
    return;
  }
  await invoke("spawn_bridge_app_command", { input: { args } });
}

async function refresh() {
  try {
    const stdout = await run(["snapshot"]);
    latestSnapshot = await ensureLocalBridgeAvailable(JSON.parse(stdout));
    renderSnapshot(latestSnapshot);
    await handleUiIntent(latestSnapshot.uiIntent);
  } catch (error) {
    statusEls.localBridge.textContent = "Error";
    statusEls.localBridge.className = "status-error";
    diagnostics.textContent = JSON.stringify({ error: String(error) }, null, 2);
  }
}

async function ensureLocalBridgeAvailable(snapshot) {
  if (!invoke || localBridgeAutoStartAttempted || snapshot?.status?.localBridge !== "not-running") {
    return snapshot;
  }
  localBridgeAutoStartAttempted = true;
  try {
    await invoke("start_bridge_sidecar", {});
    window.setTimeout(refresh, 900);
    return {
      ...snapshot,
      status: {
        ...snapshot.status,
        localBridge: "starting",
        healthError: undefined
      }
    };
  } catch (error) {
    return {
      ...snapshot,
      status: {
        ...snapshot.status,
        localBridge: "error",
        healthError: String(error)
      }
    };
  }
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
  const status = snapshot.status;
  statusEls.localBridge.textContent = providerConnectionSummary(status);
  statusEls.localBridge.className = status.localBridge === "connected" ? "status-connected" : status.localBridge === "error" ? "status-error" : "status-warning";
  const codex = snapshot.prerequisites?.codex;
  const currentProvider = currentRuntimeProvider(snapshot.providers ?? snapshot.runtimeProviders, codex);
  statusEls.codexSummary.textContent = `${currentProvider.label} · ${providerStatusSummary(currentProvider)}`;
  statusEls.codexSummary.className = currentProvider.ready ? "status-connected" : currentProvider.recommendedAction === "install" || currentProvider.recommendedAction === "login" || currentProvider.recommendedAction === "select_binary" ? "status-warning" : "status-error";
  const managed = snapshot.workspaces?.managed ?? snapshot.managedRoadmaps ?? snapshot.recentProjects ?? [];
  const activeRoadmaps = snapshot.workspaces?.active ?? managed.filter(project => project.lifecycle === "active");
  const inactiveRoadmaps = snapshot.workspaces?.inactive ?? managed.filter(project => project.lifecycle !== "active");
  statusEls.activeRoadmaps.textContent = `${activeRoadmaps.length} active`;
  statusEls.account.textContent = status.account;
  statusEls.remoteAccess.textContent = status.remoteAccess;
  statusEls.device.textContent = `${status.device.name}${status.device.registered ? " (registered)" : ""}`;
  statusEls.service.textContent = status.service.installed ? `Installed (${status.service.manager})` : "Not installed";
  diagnostics.textContent = JSON.stringify({
    diagnostics: snapshot.diagnostics,
    logs: snapshot.logLines
  }, null, 2);
  if (snapshot.codexLogin) {
    latestCodexDeviceLoginResult = snapshot.codexLogin;
  } else if (currentProvider.ready || currentProvider.auth?.state === "authenticated") {
    latestCodexDeviceLoginResult = undefined;
  }
  renderProviderCard(currentProvider);
  renderToolCards(snapshot.prerequisites?.tools);
  activeRoadmapList.replaceChildren(...roadmapRows(activeRoadmaps, "active", snapshot.projectGrants ?? []));
  inactiveRoadmapList.replaceChildren(...roadmapRows(inactiveRoadmaps, "inactive", snapshot.projectGrants ?? []));
  remoteRoadmapList.replaceChildren(...roadmapRows(managed, "remote", snapshot.projectGrants ?? [], { advanced: true }));
  projectGrants.replaceChildren(...projectGrantRows(snapshot.projectGrants ?? []));
  renderConnection(snapshot);
  renderRuntimeProviders(snapshot.providers ?? snapshot.runtimeProviders, codex);
  renderCodexSettings(snapshot.codexSettings, snapshot.diagnostics?.app?.codex);
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
    button.addEventListener("click", async () => {
      if (action === "open") {
        await spawn(["open-roadmap", project.roadmapId]);
      } else if (action === "repair") {
        await spawn(["create", project.repositoryPath]);
      } else {
        await run(["projects", "remove", "--roadmap-id", project.roadmapId]);
      }
      await refresh();
    });
    buttons.append(button);
  }
  const lifecycleButton = document.createElement("button");
  lifecycleButton.textContent = project.lifecycle === "inactive" ? "Activate" : "Deactivate";
  lifecycleButton.addEventListener("click", async () => {
    await run(["roadmaps", project.lifecycle === "inactive" ? "activate" : "deactivate", project.roadmapId]);
    await refresh();
  });
  buttons.append(lifecycleButton);
  if (options.advanced) {
    const remoteButton = document.createElement("button");
    remoteButton.textContent = remote.enabled ? "Disable Remote Access" : "Enable Remote Access";
    remoteButton.disabled = !remote.available;
    remoteButton.title = remote.available ? remoteButton.textContent : remote.reason;
    remoteButton.className = remote.enabled ? "" : remote.available ? "primary" : "";
    remoteButton.addEventListener("click", async () => {
      await run(["roadmaps", "remote", remote.enabled ? "disable" : "enable", project.roadmapId]);
      await refresh();
    });
    buttons.append(remoteButton);
  }
  const removeButton = document.createElement("button");
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", async () => {
    await run(["roadmaps", "remove", project.roadmapId]);
    await refresh();
  });
  buttons.append(removeButton);
  row.append(body, buttons);
  return row;
}

function renderConnection(snapshot) {
  const status = snapshot.status ?? {};
  const signedIn = !String(status.account ?? "").toLowerCase().includes("signed out");
  connectionEls.localStatus.textContent = `This computer · ${labelLocalBridge(status.localBridge)}`;
  connectionEls.localStatus.className = status.localBridge === "connected" ? "project-meta status-connected" : status.localBridge === "error" ? "project-meta status-error" : "project-meta status-warning";
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
    connectionEls.remoteStatus.textContent = `Remote · ${remoteAccess === "On" ? "On" : "Registered but offline"}`;
    connectionEls.remoteStatus.className = remoteAccess === "On" ? "project-meta status-connected" : "project-meta status-warning";
    connectionEls.remoteDetail.textContent = [
      `Device: ${status.device?.name ?? "This computer"}`,
      `Status: ${remoteAccess === "On" ? "Online" : "Offline"}`
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
    group: provider.providerId === currentProviderId ? "Current" : "Available later",
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
    input.addEventListener("change", async () => {
      await setRoadmapScope(project, grant, scope, input.checked);
    });
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
    await run(["roadmaps", "remote", "disable", project.roadmapId]);
    await refresh();
    return;
  }
  currentScopes.add("remoteRelay.access");
  const scopes = projectGrantScopes.filter(candidate => currentScopes.has(candidate));
  await run(["roadmaps", "remote", "enable", project.roadmapId, "--scopes", scopes.join(",")]);
  await refresh();
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
  meta.textContent = [
    providerStatusSummary(provider),
    provider?.install?.version,
    provider?.auth?.access ? `Access: ${formatProviderAccess(provider)}` : undefined,
    provider?.auth?.accountSummary?.email,
    provider?.auth?.accountSummary?.planLabel,
    provider?.usage?.summary?.label
  ].filter(Boolean).join(" · ");
  body.append(title, meta, codexDeviceLoginStatus());
  const buttons = document.createElement("div");
  buttons.className = "actions";
  const recheck = document.createElement("button");
  recheck.textContent = "Recheck";
  recheck.addEventListener("click", async () => {
    await run(provider?.providerId === "codex" ? ["codex", "recheck"] : ["snapshot"]);
    await refresh();
  });
  buttons.append(recheck);
  if (provider?.ready) {
    const changeProvider = document.createElement("button");
    changeProvider.textContent = "Change provider";
    changeProvider.addEventListener("click", () => {
      selectTab("advanced");
    });
    buttons.append(changeProvider);
  }
  if (provider?.recommendedAction === "install") {
    const install = document.createElement("button");
    install.className = "primary";
    install.textContent = `Install ${provider.label}`;
    install.addEventListener("click", async () => {
      if (provider.providerId !== "codex") {
        selectTab("advanced");
        return;
      }
      const confirmed = window.confirm("Install Codex with the OpenAI Codex npm package now?");
      if (!confirmed) {
        diagnostics.textContent = "Codex install was not started.";
        return;
      }
      diagnostics.textContent = await run(["codex", "install", "--confirm"]);
      await refresh();
    });
    buttons.append(install);
    const existing = document.createElement("button");
    existing.textContent = `Use Existing ${provider.label}`;
    existing.addEventListener("click", () => {
      selectTab("settings");
      codexBinaryPath.focus();
    });
    buttons.append(existing);
  }
  if (provider?.recommendedAction === "select_binary") {
    const existing = document.createElement("button");
    existing.className = "primary";
    existing.textContent = `Select Existing ${provider.label}`;
    existing.addEventListener("click", () => {
      selectTab("settings");
      codexBinaryPath.focus();
    });
    buttons.append(existing);
  }
  if (provider?.recommendedAction === "login" && provider.providerId === "codex") {
    const login = document.createElement("button");
    login.className = "primary";
    login.textContent = "Sign in with ChatGPT";
    login.addEventListener("click", startCodexChatGptLogin);
    buttons.append(login);
    const device = document.createElement("button");
    device.textContent = "Use Device Code";
    device.addEventListener("click", startCodexDeviceLogin);
    buttons.append(device);
  }
  if (providerNeedsAttention(provider)) {
    if (provider?.providerId === "codex") {
      const existing = document.createElement("button");
      existing.textContent = `Select Existing ${provider.label}`;
      existing.addEventListener("click", () => {
        selectTab("settings");
        codexBinaryPath.focus();
      });
      buttons.append(existing);
    }
    const details = document.createElement("button");
    details.textContent = "Show details";
    details.addEventListener("click", () => {
      diagnostics.textContent = JSON.stringify({ provider }, null, 2);
      selectTab("diagnostics");
    });
    buttons.append(details);
  }
  row.append(body, buttons);
  codexCard.append(row);
  const advancedDetails = providerAdvancedDetails(provider);
  if (advancedDetails) {
    codexCard.append(advancedDetails);
  }
}

function providerNeedsAttention(provider) {
  return provider
    && !provider.ready
    && provider.recommendedAction !== "install"
    && provider.recommendedAction !== "select_binary"
    && provider.recommendedAction !== "login";
}

function providerAdvancedDetails(provider) {
  if (provider?.providerId !== "codex") {
    return undefined;
  }
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Advanced provider details";
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.setAttribute("style", "margin-top: 10px;");
  const apiKey = document.createElement("button");
  apiKey.textContent = "Use API Key - Advanced";
  apiKey.addEventListener("click", startCodexApiKeyLogin);
  actions.append(apiKey);
  details.append(summary, actions);
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
      error: String(error)
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
      message: String(error)
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
      error: String(error)
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
    toolRow("Node", tools?.node),
    toolRow("Package manager", tools?.packageManager)
  );
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

function renderCodexSettings(settings, legacyCodexSettings) {
  codexBinaryPath.value = settings?.binaryPath ?? legacyCodexSettings?.binaryPath ?? "";
  codexInstallChannel.value = settings?.installChannel ?? "stable";
  codexAuthPreference.value = settings?.authenticationPreference ?? "chatgpt";
  codexEnvHome.value = settings?.environment?.CODEX_HOME ?? "";
  codexEnvCommand.value = settings?.environment?.HUNSU_CODEX_APP_SERVER_COMMAND ?? "";
  codexEnvArgs.value = settings?.environment?.HUNSU_CODEX_APP_SERVER_ARGS ?? "";
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
  if (value === "error") return "Error";
  return "Connecting";
}

function providerConnectionSummary(status) {
  const local = `Local · ${labelLocalBridge(status?.localBridge)}`;
  const remoteAccess = status?.remoteAccess ?? "Off";
  const remote = `Remote · ${remoteAccess === "On" ? "On" : remoteAccess === "Registered but offline" ? "Registered but offline" : "Off"}`;
  return `${local}\n${remote}`;
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
    return;
  }
  const path = selectedInspection.path;
  const action = selectedInspection.recommendedAction;
  if (action === "explain") {
    diagnostics.textContent = JSON.stringify({ project: selectedInspection }, null, 2);
    return;
  }
  if (action === "remove") {
    if (selectedInspection.roadmapId) {
      await run(["projects", "remove", "--roadmap-id", selectedInspection.roadmapId]);
    } else {
      await run(["projects", "remove", "--path", path]);
    }
    selectedInspection = undefined;
    renderSelectedInspection();
    renderSelectedProjectAction();
    await refresh();
    return;
  }
  if (action === "open") await spawn(["open-project", path]);
  if (action === "port") await spawn(["port", path]);
  if (action === "create" || action === "repair") await spawn(["create", path]);
}

document.querySelector("#refresh").addEventListener("click", refresh);
document.querySelector("#open-studio").addEventListener("click", () => spawn(["pair"]));
document.querySelector("#open-studio-connection").addEventListener("click", () => spawn(["pair"]));
selectedProjectAction.addEventListener("click", runSelectedAction);
document.querySelector("#enable-remote").addEventListener("click", async () => {
  await run(["remote", "enable"]);
  await refresh();
});
document.querySelector("#disable-remote").addEventListener("click", async () => {
  await run(["remote", "disable"]);
  await refresh();
});
connectionEls.primaryAction.addEventListener("click", runConnectionAction);
connectionEls.secondaryAction.addEventListener("click", runConnectionAction);
document.querySelector("#install-protocol").addEventListener("click", async () => {
  const stdout = await run(["protocol", "install"]);
  diagnostics.textContent = stdout;
});
document.querySelector("#start-bridge").addEventListener("click", async () => {
  if (invoke) await invoke("start_bridge_sidecar", {});
  window.setTimeout(refresh, 600);
});
document.querySelector("#stop-bridge").addEventListener("click", async () => {
  await run(["stop"]);
  await refresh();
});
async function chooseProjectFolder() {
  if (!invoke) return;
  const folder = await invoke("choose_project_folder");
  if (folder?.path) {
    await inspectSelectedFolder(folder.path);
  }
}

document.querySelector("#choose-folder").addEventListener("click", chooseProjectFolder);

async function runConnectionAction(event) {
  const action = event?.currentTarget?.dataset?.action;
  if (action === "sign-in") {
    await spawn(["login", "--gui"]);
  } else if (action === "enable-remote") {
    await run(["remote", "enable"]);
  } else if (action === "disable-remote") {
    await run(["remote", "disable"]);
  } else if (action === "sign-out") {
    await run(["logout"]);
  }
  await refresh();
}

document.querySelector("#copy-diagnostics").addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagnostics.textContent || "{}");
});
document.querySelector("#save-codex-path").addEventListener("click", async () => {
  const value = codexBinaryPath.value.trim();
  if (value) await run(["codex", "path", "set", value]);
  else await run(["codex", "path", "reset"]);
  await refresh();
});
document.querySelector("#save-codex-settings").addEventListener("click", async () => {
  await run([
    "codex",
    "settings",
    "set",
    "--install-channel",
    codexInstallChannel.value,
    "--auth-preference",
    codexAuthPreference.value
  ]);
  await refresh();
});
document.querySelector("#reset-codex-path").addEventListener("click", async () => {
  await run(["codex", "path", "reset"]);
  await refresh();
});

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
