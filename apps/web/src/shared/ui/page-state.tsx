import { AlertCircle, AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/shared/ui/button";

export function PageLoading({ label = "Loading Hunsu…" }: { label?: string }) {
  return (
    <div className="flex min-h-[360px] items-center justify-center px-6 text-muted-foreground">
      <div className="flex items-center gap-3 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto flex min-h-[360px] max-w-xl items-center justify-center px-6">
      <div className="w-full rounded-[20px] border bg-card p-6 text-center shadow-sm">
        <AlertCircle className="mx-auto size-7 text-destructive" />
        <h2 className="mt-3 text-lg font-semibold">This view could not be loaded</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
        {onRetry ? (
          <Button type="button" variant="outline" className="mt-5" onClick={onRetry}>
            <RotateCw className="size-4" />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function PageRefreshWarning({
  message,
  onRetry,
  retrying = false
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="alert" className="mt-5 flex flex-col gap-3 rounded-[14px] border border-amber-200 bg-amber-50/72 px-4 py-3 text-amber-950 sm:flex-row sm:items-center">
      <AlertTriangle className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold">Automatic refresh paused</p>
        <p className="mt-0.5 text-[11px] leading-4 text-amber-900/80">{message}</p>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
        <RotateCw className={retrying ? "animate-spin" : ""} />
        {retrying ? "Retrying…" : "Retry refresh"}
      </Button>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-[20px] border border-dashed bg-white/52 px-6 py-10 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
