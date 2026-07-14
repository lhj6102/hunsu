import { useQuery } from "@tanstack/react-query";
import { Bot, Boxes, ChevronRight, Network, ShieldCheck, Users } from "lucide-react";
import { pushAppPath, runPath } from "@/app/routes";
import { apiErrorMessage } from "@/shared/api/client";
import { fetchRunners } from "@/shared/api/projectApi";
import type { Player, Runner, Team } from "@/shared/api/types";
import { formatTimestamp } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { RunStatusBadge } from "@/shared/ui/domain-badge";
import { PageError, PageLoading, EmptyState } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";

export function RunnerDirectoryScreen({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ["projects", projectId, "runners"],
    queryFn: ({ signal }) => fetchRunners(projectId, signal),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false
  });
  if (query.isLoading) return <PageLoading label="Loading Runners…" />;
  if (query.isError || !query.data) return <PageError message={apiErrorMessage(query.error, "Runners are unavailable.")} onRetry={() => void query.refetch()} />;
  const teams = query.data.runners.filter((runner): runner is Team => runner.kind === "team");
  const players = query.data.runners.filter((runner): runner is Player => runner.kind === "player");
  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1220px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Runner directory"
          title="Teams and Players"
          description="A Runner is exactly one reusable Player or Team definition. Runs are execution records; Runners are not processes."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <DirectoryMetric icon={<Boxes />} label="Teams" value={teams.length} />
          <DirectoryMetric icon={<Bot />} label="Players" value={players.length} />
          <DirectoryMetric icon={<Network />} label="Assigned Goals" value={query.data.runners.reduce((sum, runner) => sum + runner.goalCount, 0)} />
        </div>

        <DirectorySection title="Teams" description="Composite Runners coordinate Players through an explicit strategy.">
          {teams.length > 0 ? <div className="grid gap-4 lg:grid-cols-2">{teams.map(team => <TeamCard key={team.id} projectId={projectId} team={team} />)}</div> : <EmptyState title="No Teams configured" body="Create a Team from Players through the Hunsu plugin or Runner API." />}
        </DirectorySection>

        <DirectorySection title="Players" description="Atomic Runners carry prompts, resources, and runtime policy.">
          {players.length > 0 ? <div className="grid gap-4 lg:grid-cols-2">{players.map(player => <PlayerCard key={player.id} projectId={projectId} player={player} />)}</div> : <EmptyState title="No Players configured" body="Create the first Player through the Hunsu plugin or Runner API." />}
        </DirectorySection>
      </div>
    </main>
  );
}

function DirectoryMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-[18px] border bg-white/62 p-4">
      <span className="flex size-8 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)] [&_svg]:size-4">{icon}</span>
      <p className="mt-3 text-2xl font-semibold">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function DirectorySection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="mt-10"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p><div className="mt-4">{children}</div></section>;
}

function TeamCard({ projectId, team }: { projectId: string; team: Team }) {
  return (
    <article className="rounded-[20px] border bg-white/68 p-5">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-lg font-semibold">{team.name}</h3><p className="mt-1 text-[12px] text-muted-foreground">{team.description ?? `${team.strategy.mode} · ${team.strategy.maxRounds} round${team.strategy.maxRounds === 1 ? "" : "s"}`}</p></div>
        <Badge variant="default"><Users />Team</Badge>
      </div>
      <div className="mt-4 rounded-[14px] bg-white/62 p-3">
        <p className="text-[10px] font-semibold uppercase text-muted-foreground">Strategy</p>
        <p className="mt-1 text-[12px] font-semibold leading-5">{team.strategy.mode} · up to {team.strategy.maxRounds} round{team.strategy.maxRounds === 1 ? "" : "s"}</p>
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">{team.strategy.promptTemplate}</p>
      </div>
      <div className="mt-4">
        <p className="text-[11px] font-semibold">Player composition</p>
        <ol className="mt-2 grid gap-2">
          {[...team.players].sort((left, right) => left.order - right.order).map(link => (
            <li key={`${link.playerId}:${link.role}`} className="flex items-center gap-3 rounded-[12px] border bg-white/58 px-3 py-2 text-[12px]">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[10px] font-semibold text-[color:var(--apple-blue)]">{link.order}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{link.playerName}</span>
              <span className="truncate text-muted-foreground">{link.role}</span>
            </li>
          ))}
        </ol>
      </div>
      <Usage projectId={projectId} runner={team} />
    </article>
  );
}

function PlayerCard({ projectId, player }: { projectId: string; player: Player }) {
  return (
    <article className="rounded-[20px] border bg-white/68 p-5">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-lg font-semibold">{player.name}</h3><p className="mt-1 text-[12px] text-muted-foreground">{player.description ?? "Atomic Runner"}</p></div>
        <Badge variant="outline"><Bot />Player</Badge>
      </div>
      <details className="mt-4 rounded-[14px] border bg-white/58 px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-semibold">Prompt and capabilities</summary>
        <p className="mt-3 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">{player.promptTemplate}</p>
      </details>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[14px] bg-white/62 p-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground"><ShieldCheck className="size-3" />Policy</p>
          <p className="mt-2 text-[11px]">Filesystem: {player.runtimePolicy.filesystem}</p>
          <p className="mt-1 text-[11px]">Network: {player.runtimePolicy.network}</p>
          <p className="mt-1 text-[11px]">Approvals: {player.runtimePolicy.approvals}</p>
        </div>
        <div className="rounded-[14px] bg-white/62 p-3">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Resources</p>
          <div className="mt-2 flex flex-wrap gap-1">{player.resources.length > 0 ? player.resources.map(resource => <Badge key={resource.id} variant="outline">{resource.name}</Badge>) : <span className="text-[11px] text-muted-foreground">None</span>}</div>
        </div>
      </div>
      <Usage projectId={projectId} runner={player} />
    </article>
  );
}

function Usage({ projectId, runner }: { projectId: string; runner: Runner }) {
  const completed = runner.recentResults.filter(run => run.status === "completed").length;
  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>{runner.goalCount} assigned Goals</span>
        <span>{runner.recentResults.length} recent Runs</span>
        <span>{completed} completed</span>
      </div>
      {runner.recentResults.length > 0 ? (
        <div className="mt-3 grid gap-1.5">
          {runner.recentResults.slice(0, 3).map(run => (
            <button
              key={run.id}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-[12px] bg-white/54 px-3 py-2 text-left hover:bg-white"
              onClick={() => pushAppPath(runPath(projectId, run.id))}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold">{run.goalTitle}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{formatTimestamp(run.updatedAt)}</span>
              </span>
              <RunStatusBadge status={run.status} />
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
