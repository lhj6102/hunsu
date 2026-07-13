import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronLeft, ChevronRight, CircleDot, FolderKanban, Github, LayoutDashboard, Users } from "lucide-react";
import {
  coachPath,
  projectPath,
  pushAppPath,
  runnersPath,
  type AppRoute
} from "@/app/routes";
import { fetchProjects, PROJECT_LIST_QUERY_KEY } from "@/shared/api/projectApi";
import type { SessionResponse } from "@/shared/api/types";
import { relativeTimestamp } from "@/shared/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";

export function ProjectAppShell({
  route,
  session,
  children
}: {
  route: AppRoute;
  session: SessionResponse;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 920);
  const projectId = "projectId" in route ? route.projectId : undefined;
  const projectsQuery = useQuery({
    queryKey: PROJECT_LIST_QUERY_KEY,
    queryFn: ({ signal }) => fetchProjects(signal),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false
  });
  const projects = projectsQuery.data?.projects ?? [];
  const currentProject = useMemo(
    () => projects.find(project => project.id === projectId),
    [projectId, projects]
  );

  return (
    <div
      className="grid min-h-screen bg-[color:var(--apple-canvas-alt)] text-foreground transition-[grid-template-columns] duration-200"
      style={{ gridTemplateColumns: `${collapsed ? 64 : 264}px minmax(0, 1fr)` }}
    >
      <aside className={cn(
        "apple-glass sticky top-0 z-40 box-border flex h-screen min-w-0 flex-col overflow-hidden border-y-0 border-l-0 py-4",
        collapsed ? "items-center px-2" : "px-3"
      )}>
        <div className={cn("flex min-w-0", collapsed ? "w-full flex-col items-center gap-2" : "w-full items-center gap-2")}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-[13px] font-semibold text-white">H</div>
          {!collapsed ? (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold leading-5">Hunsu</p>
              <p className="truncate text-[11px] leading-4 text-muted-foreground">GitHub projects</p>
            </div>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-8", collapsed ? "bg-white/36" : "ml-auto")}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? <ChevronRight /> : <ChevronLeft />}
          </Button>
        </div>

        <nav className={cn("mt-6 grid w-full gap-1", collapsed && "justify-items-center")} aria-label="Primary navigation">
          <NavItem
            collapsed={collapsed}
            active={route.kind === "projects"}
            icon={<FolderKanban />}
            label="Projects"
            caption="All initiatives"
            onClick={() => pushAppPath("/projects")}
          />
          {projectId ? (
            <>
              <NavItem
                collapsed={collapsed}
                active={route.kind === "project" || route.kind === "goal" || route.kind === "run"}
                icon={<LayoutDashboard />}
                label="Overview"
                caption="Goals and Runs"
                onClick={() => pushAppPath(projectPath(projectId))}
              />
              <NavItem
                collapsed={collapsed}
                active={route.kind === "runners"}
                icon={<Users />}
                label="Runners"
                caption="Teams and Players"
                onClick={() => pushAppPath(runnersPath(projectId))}
              />
              <NavItem
                collapsed={collapsed}
                active={route.kind === "coach"}
                icon={<Bot />}
                label="Coach"
                caption="Review and steer"
                onClick={() => pushAppPath(coachPath(projectId))}
              />
            </>
          ) : null}
        </nav>

        <section className="mt-6 flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          {!collapsed ? (
            <div className="mb-2 flex items-center justify-between gap-2 px-2">
              <p className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Recent projects</p>
              <Badge variant={projectsQuery.isError ? "destructive" : "outline"}>{projects.length}</Badge>
            </div>
          ) : null}
          <ScrollArea className={cn("min-h-0 flex-1", !collapsed && "pr-1")}>
            <div className={cn("grid gap-1", collapsed && "justify-items-center")}>
              {projects.slice(0, 10).map(project => (
                <button
                  key={project.id}
                  type="button"
                  className={cn(
                    "relative flex min-w-0 items-center gap-3 rounded-[14px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
                    collapsed ? "size-10 justify-center" : "min-h-11 w-full px-2",
                    project.id === projectId ? "bg-white/52 text-foreground" : "text-[color:var(--apple-body)] hover:bg-white/42"
                  )}
                  title={collapsed ? project.title : undefined}
                  onClick={() => pushAppPath(projectPath(project.id))}
                >
                  <CircleDot className={cn("size-4 shrink-0", project.activeRunCount > 0 ? "fill-[color:var(--apple-blue)] text-[color:var(--apple-blue)]" : "text-muted-foreground")} />
                  {!collapsed ? (
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold">{project.title}</span>
                      <span className="block truncate text-[10px] leading-4 text-muted-foreground">{project.repository.owner}/{project.repository.name}</span>
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </ScrollArea>
        </section>

        <div className={cn("mt-3 w-full rounded-[14px] border bg-white/44 p-2", collapsed && "flex justify-center border-transparent bg-transparent")}>
          <div className="flex items-center gap-2">
            {session.user?.avatarUrl ? (
              <img src={session.user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-8 rounded-full" />
            ) : (
              <span className="flex size-8 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-white"><Github className="size-4" /></span>
            )}
            {!collapsed ? (
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold">{session.user?.name ?? session.user?.login ?? "GitHub account"}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {currentProject ? `Synced ${relativeTimestamp(currentProject.synchronizedAt)}` : session.workspace?.accountLogin ?? "Connected"}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

function NavItem({
  collapsed,
  active,
  icon,
  label,
  caption,
  onClick
}: {
  collapsed: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex min-w-0 items-center gap-3 rounded-[14px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        collapsed ? "size-11 justify-center" : "min-h-11 w-full px-2",
        active ? "text-foreground" : "text-[color:var(--apple-body)] hover:bg-white/42"
      )}
      title={collapsed ? label : undefined}
      onClick={onClick}
    >
      {active ? <span className="absolute left-0 h-6 w-0.5 rounded-full bg-[color:var(--apple-blue)]" /> : null}
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", active ? "bg-[color:var(--apple-blue)] text-white" : "text-muted-foreground")}>{icon}</span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold leading-4">{label}</span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">{caption}</span>
        </span>
      ) : null}
    </button>
  );
}
