import { Github, LockKeyhole, Network, RefreshCw } from "lucide-react";
import type { SessionResponse } from "@/shared/api/types";
import { safeHttpHref } from "@/shared/format";
import { Button } from "@/shared/ui/button";

export function GitHubConnectionScreen({
  session,
  onRefresh
}: {
  session?: SessionResponse;
  onRefresh: () => void;
}) {
  const connectUrl = safeHttpHref(session?.github.connectUrl) ?? "/api/auth/github";
  return (
    <main className="apple-page min-h-screen px-5 py-8 sm:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-[1120px] flex-col">
        <header className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-sm font-semibold text-white">H</span>
          <div>
            <p className="text-[15px] font-semibold">Hunsu</p>
            <p className="text-[12px] text-muted-foreground">GitHub-backed product futures</p>
          </div>
        </header>

        <div className="grid flex-1 items-center gap-8 py-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <section>
            <p className="text-[13px] font-semibold uppercase tracking-normal text-[color:var(--apple-blue)]">Connect GitHub</p>
            <h1 className="mt-3 max-w-[680px] font-[family-name:var(--apple-font-display)] text-[44px] font-semibold leading-[1.04] tracking-normal sm:text-[60px]">
              Turn a repository into a Hunsu Project.
            </h1>
            <p className="mt-5 max-w-[620px] text-[17px] leading-7 text-[color:var(--apple-body)]">
              GitHub keeps durable Project truth. Hunsu gives Goals, reusable Runners, evidence, Coach review, and deliberate alternative futures a clear home.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href={connectUrl}>
                  <Github className="size-4" />
                  {session?.authenticated ? "Install the GitHub App" : "Continue with GitHub"}
                </a>
              </Button>
              <Button type="button" size="lg" variant="outline" onClick={onRefresh}>
                <RefreshCw className="size-4" />
                Check connection
              </Button>
            </div>
          </section>

          <aside className="apple-glass-strong rounded-[26px] p-6">
            <h2 className="text-xl font-semibold">One connected flow</h2>
            <div className="mt-6 grid gap-5">
              <ConnectionBenefit icon={<Github />} title="Repository authority" body="Project events and snapshots live on the protected hunsu/state ref." />
              <ConnectionBenefit icon={<LockKeyhole />} title="Installation-scoped access" body="Hunsu can see only repositories granted through the GitHub App." />
              <ConnectionBenefit icon={<Network />} title="Divergence preserved" body="Competing Runs start from a shared commit and remain comparable before selection." />
            </div>
            <p className="mt-6 rounded-[14px] bg-white/58 px-4 py-3 text-[12px] leading-5 text-muted-foreground">
              Repository secrets and GitHub installation credentials are never written to Project state.
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ConnectionBenefit({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)] [&_svg]:size-4">{icon}</span>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
