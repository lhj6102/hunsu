import { AlertCircle, CheckCircle2, LogIn, RefreshCw } from "lucide-react";
import { currentStudioNext, pushStudioPath, setupPath } from "@/app/routes";
import type { RuntimeProviderStatus } from "@/shared/api/bridgeTypes";
import { cn } from "@/lib/utils";
import { Button } from "@/shared/ui/button";

export function ProviderStatusCard({
  provider,
  compact = false,
  onOpenProvider = openBridgeProvider,
  title = "Provider"
}: {
  provider?: RuntimeProviderStatus;
  compact?: boolean;
  onOpenProvider?: (providerId?: string) => void;
  title?: string;
}) {
  const ready = provider?.ready === true;
  const needsLogin = provider?.recommendedAction === "login";
  const Icon = ready ? CheckCircle2 : needsLogin ? LogIn : AlertCircle;
  return (
    <section className={cn("min-w-0", !compact && "rounded-[8px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3")}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full bg-white/72",
          ready ? "text-[color:var(--apple-green)]" : "text-[color:var(--apple-orange)]"
        )}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold leading-4 text-[color:var(--apple-ink)]">
            {title}
          </p>
          <p className="truncate text-[11px] leading-4 text-muted-foreground">
            {provider ? `${provider.label} · ${providerStatusLabel(provider)}` : "Unknown"}
          </p>
        </div>
        {!compact ? (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => onOpenProvider(provider?.providerId)}>
            <RefreshCw className="size-4" />
            Setup
          </Button>
        ) : null}
      </div>
      {!compact && provider?.safeMessage ? (
        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{provider.safeMessage}</p>
      ) : null}
    </section>
  );
}

export function providerStatusLabel(provider: RuntimeProviderStatus): string {
  if (provider.usage?.rateLimited) return "Rate limited";
  if (provider.ready) return "Ready";
  if (provider.recommendedAction === "install") return "Install required";
  if (provider.recommendedAction === "login") return "Login required";
  if (provider.recommendedAction === "configure" || provider.recommendedAction === "select_binary") return "Setup required";
  if (provider.recommendedAction === "recheck") return "Needs attention";
  return "Unknown";
}

function openBridgeProvider(_providerId?: string) {
  pushStudioPath(setupPath(currentStudioNext(window.location)));
}
