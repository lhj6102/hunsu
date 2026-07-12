import { Folder, Monitor, RadioTower } from "lucide-react";
import type { ReactNode } from "react";
import type { BridgeBackendStatus, ConnectedWorkspaceSummary, RuntimeProviderStatus } from "@/shared/api/bridgeTypes";
import { cn } from "@/lib/utils";
import { providerStatusLabel } from "./ProviderStatusCard.js";

export function WorkspaceConnectionList({
  connections,
  maxItems = 5,
  compact = false
}: {
  connections: BridgeBackendStatus[];
  maxItems?: number;
  compact?: boolean;
}) {
  const local = connections.find(connection => connection.mode === "local");
  const remotes = connections.filter(connection => connection.mode === "remote");
  const localWorkspaces = local?.workspaces ?? [];
  return (
    <section className={cn("min-w-0", !compact && "rounded-[8px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3")}>
      {!compact ? <h3 className="text-[12px] font-semibold uppercase tracking-normal text-muted-foreground">Workspaces</h3> : null}
      <div className={cn("grid gap-2", !compact && "mt-3")}>
        <WorkspaceGroup
          icon={<Monitor className="size-3.5" />}
          label="Local"
          provider={local?.provider}
          workspaces={localWorkspaces.slice(0, maxItems)}
          emptyLabel="No active local workspaces"
          compact={compact}
        />
        {remotes.length > 0 ? (
          remotes.map(connection => (
            <WorkspaceGroup
              key={connection.backendId}
              icon={<RadioTower className="size-3.5" />}
              label={compact ? "Remote" : `Remote · ${connection.label}`}
              provider={connection.provider}
              workspaces={connection.workspaces.slice(0, maxItems)}
              emptyLabel={connection.connection.state === "connected" ? "No active remote workspaces" : remoteConnectionLabel(connection.connection.state)}
              compact={compact}
            />
          ))
        ) : null}
      </div>
    </section>
  );
}

function remoteConnectionLabel(state: BridgeBackendStatus["connection"]["state"]): string {
  if (state === "login_required") return "Sign in to connect remote workspaces";
  if (state === "signaling_offline") return "Remote Bridge offline";
  if (state === "not_running") return "Remote Bridge not running";
  return "Remote Bridge unavailable";
}

function WorkspaceGroup({
  icon,
  label,
  provider,
  workspaces,
  emptyLabel,
  compact
}: {
  icon: ReactNode;
  label: string;
  provider?: RuntimeProviderStatus;
  workspaces: ConnectedWorkspaceSummary[];
  emptyLabel: string;
  compact: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
        <span className="shrink-0">{icon}</span>
        <span className="shrink-0">{label}</span>
        {provider ? (
          <span className={cn("min-w-0 truncate normal-case", provider.ready ? "text-[color:var(--apple-green)]" : "text-[color:var(--apple-orange)]")}>
            {`${provider.label} ${providerStatusLabel(provider).toLowerCase()}`}
          </span>
        ) : null}
      </div>
      <div className="mt-1 grid gap-1">
        {workspaces.length === 0 ? (
          <p className="truncate text-[11px] leading-4 text-muted-foreground">{emptyLabel}</p>
        ) : workspaces.map(workspace => (
          <WorkspaceRow key={`${workspace.backendId}:${workspace.workspaceId}`} workspace={workspace} compact={compact} />
        ))}
      </div>
    </div>
  );
}

function WorkspaceRow({ workspace, compact }: { workspace: ConnectedWorkspaceSummary; compact: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[11px] leading-4", compact ? "text-muted-foreground" : "text-[color:var(--apple-ink)]")}>
      <Folder className="size-3.5 shrink-0" />
      <span className="truncate">{workspace.displayName}</span>
    </div>
  );
}
