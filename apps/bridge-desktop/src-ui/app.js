const invoke = window.__TAURI__?.core?.invoke;
const diagnostics = document.querySelector("#diagnostics");
const statusEls = {
  localBridge: document.querySelector("#local-bridge"),
  account: document.querySelector("#account"),
  remoteAccess: document.querySelector("#remote-access"),
  device: document.querySelector("#device"),
  service: document.querySelector("#service")
};
const recentProjects = document.querySelector("#recent-projects");
const projectGrants = document.querySelector("#project-grants");
const selectedProject = document.querySelector("#selected-project");
const selectedProjectAction = document.querySelector("#selected-project-action");
let latestSnapshot = undefined;
let selectedInspection = undefined;

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
    latestSnapshot = JSON.parse(stdout);
    renderSnapshot(latestSnapshot);
  } catch (error) {
    statusEls.localBridge.textContent = "Error";
    statusEls.localBridge.className = "status-error";
    diagnostics.textContent = JSON.stringify({ error: String(error) }, null, 2);
  }
}

function renderSnapshot(snapshot) {
  const status = snapshot.status;
  statusEls.localBridge.textContent = labelLocalBridge(status.localBridge);
  statusEls.localBridge.className = status.localBridge === "connected" ? "status-connected" : status.localBridge === "error" ? "status-error" : "status-warning";
  statusEls.account.textContent = status.account;
  statusEls.remoteAccess.textContent = status.remoteAccess;
  statusEls.device.textContent = `${status.device.name}${status.device.registered ? " (registered)" : ""}`;
  statusEls.service.textContent = status.service.installed ? `Installed (${status.service.manager})` : "Not installed";
  diagnostics.textContent = JSON.stringify({
    diagnostics: snapshot.diagnostics,
    logs: snapshot.logLines
  }, null, 2);
  recentProjects.replaceChildren(...snapshot.recentProjects.map(projectRow));
  projectGrants.replaceChildren(...projectGrantRows(snapshot.projectGrants ?? []));
}

function projectRow(project) {
  const row = document.createElement("div");
  row.className = "project-row";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "project-title";
  title.textContent = project.displayName;
  const meta = document.createElement("div");
  meta.className = "project-meta";
  meta.textContent = [
    project.health,
    project.lastKnownBranch,
    project.lastOpenedAt ? new Date(project.lastOpenedAt).toLocaleString() : undefined,
    project.repositoryPath
  ].filter(Boolean).join(" · ");
  body.append(title, meta);
  const button = document.createElement("button");
  const action = project.primaryAction || (project.health === "ok" ? "open" : "remove");
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
  row.append(body, button);
  return row;
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
  return "Not Running";
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
selectedProjectAction.addEventListener("click", runSelectedAction);
document.querySelector("#sign-in").addEventListener("click", () => spawn(["login", "--gui"]));
document.querySelector("#enable-remote").addEventListener("click", async () => {
  await run(["remote", "enable"]);
  await refresh();
});
document.querySelector("#disable-remote").addEventListener("click", async () => {
  await run(["remote", "disable"]);
  await refresh();
});
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
document.querySelector("#choose-folder").addEventListener("click", async () => {
  if (!invoke) return;
  const folder = await invoke("choose_project_folder");
  if (folder?.path) {
    await inspectSelectedFolder(folder.path);
  }
});
document.querySelector("#copy-diagnostics").addEventListener("click", async () => {
  await navigator.clipboard.writeText(diagnostics.textContent || "{}");
});

void refresh();
window.setInterval(refresh, 3000);
