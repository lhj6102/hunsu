import { useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, Clipboard, Download, ExternalLink, Loader2, RefreshCw, Terminal, Wifi, WifiOff } from "lucide-react";
import { pushStudioPath, safeStudioNext } from "@/app/routes";
import { cn } from "@/lib/utils";
import { bridgeApiHttpUrl } from "@/shared/api/bridgeApiBase";
import { useBridgeConnection } from "@/shared/api/bridgeConnection";
import { Button } from "@/shared/ui/button";

export function SetupScreen({ next = "/studio" }: { next?: string }) {
  const safeNext = safeStudioNext(next);
  const command = useMemo(() => bridgeCommandForCurrentOrigin(safeNext), [safeNext]);
  const healthEndpoint = useMemo(() => bridgeApiHttpUrl("/health"), []);
  const connection = useBridgeConnection({ enabled: true, intervalMs: 1800 });
  const [copied, setCopied] = useState(false);
  const canContinue = connection.status === "online" && connection.tokenPresent;
  const bridgeRunningWithoutToken = connection.status === "online" && !connection.tokenPresent;

  useEffect(() => {
    if (!canContinue) {
      return;
    }
    const timer = window.setTimeout(() => pushStudioPath(safeNext), 900);
    return () => window.clearTimeout(timer);
  }, [canContinue, safeNext]);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="apple-page min-h-screen overflow-x-hidden">
      <section className="mx-auto grid min-h-screen w-full max-w-[1180px] grid-rows-[auto_1fr] gap-8 px-5 py-7 sm:px-8 lg:px-10 lg:py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            className="flex items-center gap-3 rounded-full text-left text-[color:var(--apple-ink)] transition-opacity hover:opacity-78 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
            onClick={() => pushStudioPath("/studio")}
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-[13px] font-semibold text-white">H</span>
            <span className="grid">
              <span className="text-[15px] font-semibold leading-5">Hunsu</span>
              <span className="text-[12px] leading-4 text-muted-foreground">Bridge Setup</span>
            </span>
          </button>
          <ConnectionPill status={connection.status} tokenPresent={connection.tokenPresent} />
        </header>

        <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] lg:items-center">
          <section className="min-w-0">
            <p className="text-[13px] font-semibold uppercase tracking-normal text-[color:var(--apple-blue)]">Local Bridge required</p>
            <h1 className="mt-3 max-w-[720px] font-[family-name:var(--apple-font-display)] text-[42px] font-semibold leading-[1.05] tracking-normal text-[color:var(--apple-ink)] sm:text-[56px]">
              Connect Studio to your workspace.
            </h1>
            <p className="mt-5 max-w-[640px] text-[16px] leading-7 text-[color:var(--apple-body)]">
              Studio runs in the browser, while Bridge runs on your machine and gives it temporary access to your local repositories.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button type="button" size="lg" onClick={() => openBridgeLink(pairLink(safeNext))}>
                <ExternalLink className="size-4" />
                Open Hunsu Bridge App
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={() => openBridgeLink("https://hunsu.app/download/bridge")}>
                <Download className="size-4" />
                Download Hunsu Bridge App
              </Button>
            </div>

            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              <SetupStep number="1" title="Open" body="Launch the Bridge App on this machine." />
              <SetupStep number="2" title="Pair" body="Bridge opens Studio with a fresh pairing session." />
              <SetupStep number="3" title="Continue" body="Choose or create a Roadmap from Project Finder." />
            </div>

            <details className="mt-6 rounded-[18px] border border-[color:var(--apple-hairline)] bg-white/64 px-4 py-3">
              <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-[color:var(--apple-ink)]">
                <Terminal className="size-4" />
                Advanced terminal command
              </summary>
              <div className="mt-4 overflow-hidden rounded-[14px] border border-[color:var(--apple-hairline)] bg-[color:var(--apple-ink)] text-white">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                  <span className="text-[13px] font-semibold">CLI fallback</span>
                  <Button type="button" size="sm" variant="secondary" className="h-8 bg-white/12 text-white hover:bg-white/18" onClick={copyCommand}>
                    {copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-6 text-white sm:text-[14px]">
                  <code>{command}</code>
                </pre>
              </div>
            </details>
          </section>

          <aside className="apple-glass-strong min-w-0 rounded-[24px] p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <StatusIcon status={connection.status} tokenPresent={connection.tokenPresent} />
              <div className="min-w-0 flex-1">
                <h2 className="text-[22px] font-semibold leading-7 text-[color:var(--apple-ink)]">{statusTitle(connection.status, connection.tokenPresent)}</h2>
                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{statusBody(connection.status, connection.tokenPresent, healthEndpoint)}</p>
              </div>
            </div>

            <div className="mt-6 grid gap-3">
              <Button type="button" size="lg" disabled={!canContinue} onClick={() => pushStudioPath(safeNext)}>
                <ExternalLink className="size-4" />
                Continue to Studio
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={() => window.location.reload()}>
                <RefreshCw className="size-4" />
                Check again
              </Button>
            </div>

            {bridgeRunningWithoutToken ? (
              <div className="mt-5 rounded-[14px] border border-[color:var(--apple-orange)]/28 bg-white/54 px-4 py-3 text-[12px] leading-5 text-[color:var(--apple-body)]">
                Bridge is reachable, but this browser tab does not have the pairing token yet. Pair again from the Bridge App or use the advanced CLI fallback.
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
}

function SetupStep({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="rounded-[16px] border border-[color:var(--apple-hairline)] bg-white/68 px-4 py-4">
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue)] text-[12px] font-semibold text-white">{number}</span>
        <h2 className="text-[14px] font-semibold text-[color:var(--apple-ink)]">{title}</h2>
      </div>
      <p className="mt-3 text-[12px] leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

function ConnectionPill({ status, tokenPresent }: { status: string; tokenPresent: boolean }) {
  return (
    <span className={cn(
      "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold",
      status === "online" && tokenPresent
        ? "border-[color:var(--apple-green)]/34 bg-white/76 text-[color:var(--apple-green)]"
        : "border-[color:var(--apple-hairline)] bg-white/68 text-muted-foreground"
    )}>
      {status === "checking" ? <Loader2 className="size-3.5 animate-spin" /> : status === "online" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {status === "online" && tokenPresent ? "Connected" : status === "online" ? "Bridge running" : status === "checking" ? "Checking" : "Not connected"}
    </span>
  );
}

function StatusIcon({ status, tokenPresent }: { status: string; tokenPresent: boolean }) {
  const connected = status === "online" && tokenPresent;
  return (
    <span className={cn(
      "flex size-12 shrink-0 items-center justify-center rounded-full",
      connected ? "bg-[color:var(--apple-green)] text-white" : "bg-white text-[color:var(--apple-blue)]"
    )}>
      {connected ? <CheckCircle2 className="size-5" /> : status === "checking" ? <Loader2 className="size-5 animate-spin" /> : <Terminal className="size-5" />}
    </span>
  );
}

function statusTitle(status: string, tokenPresent: boolean): string {
  if (status === "online" && tokenPresent) return "Studio is paired.";
  if (status === "online") return "Bridge is running.";
  if (status === "checking") return "Looking for Bridge.";
  return "Start Bridge to continue.";
}

function statusBody(status: string, tokenPresent: boolean, healthEndpoint: string): string {
  if (status === "online" && tokenPresent) return "This browser has a valid pairing token. Studio will open automatically.";
  if (status === "online") return "Bridge answered locally, but Studio still needs a fresh pairing token.";
  if (status === "checking") return `Checking ${healthEndpoint} for a local Bridge session.`;
  return "Open the Bridge App. It will start Bridge and open Studio with a temporary pairing token.";
}

function openBridgeLink(url: string): void {
  window.location.href = url;
}

function pairLink(next: string): string {
  return `hunsu://pair?next=${encodeURIComponent(next)}`;
}

function bridgeCommandForCurrentOrigin(next: string): string {
  if (typeof window === "undefined") {
    return "npx @hunsu/bridge@latest";
  }
  const origin = window.location.origin;
  const targetUrl = new URL(next, origin).toString();
  if (origin === "https://hunsu.app" && next === "/studio") {
    return "npx @hunsu/bridge@latest";
  }
  return `npx @hunsu/bridge@latest --web-url "${targetUrl}"`;
}
