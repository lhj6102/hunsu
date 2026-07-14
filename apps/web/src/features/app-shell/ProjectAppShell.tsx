import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, Github, ListTree, Menu, Network, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { projectEventsPath, projectGraphPath, pushAppPath, type AppRoute } from "@/app/routes";
import { cn } from "@/lib/utils";
import { pollingQueryOptions } from "@/shared/api/polling";
import { fetchProjects, PROJECT_LIST_QUERY_KEY } from "@/shared/api/projectApi";
import type { ProjectListResponse, SessionResponse } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";

const NAVIGATION_KEY = "hunsu.project-navigation.v2";

export function ProjectAppShell({
  route,
  session,
  children
}: {
  route: AppRoute;
  session: SessionResponse;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [mobileOpen, setMobileOpen] = useState(false);
  const projectId = route.kind === "graph" || route.kind === "events" ? route.projectId : null;
  const projectsQuery = useQuery({
    queryKey: PROJECT_LIST_QUERY_KEY,
    queryFn: ({ signal }) => fetchProjects(signal),
    ...pollingQueryOptions<ProjectListResponse>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => data.projects.some(project => project.activeRunCount > 0)
    })
  });
  const projects = projectsQuery.data?.projects ?? [];
  const currentProject = useMemo(() => projects.find(project => project.id === projectId), [projectId, projects]);

  function updateCollapsed(next: boolean) {
    setCollapsed(next);
    try {
      window.localStorage.setItem(NAVIGATION_KEY, next ? "collapsed" : "expanded");
    } catch {
      // Navigation state is a non-critical preference.
    }
  }

  return (
    <TooltipProvider>
      <div
        className="min-h-screen bg-[color:var(--apple-canvas-alt)] text-foreground lg:grid lg:transition-[grid-template-columns] lg:duration-200"
        style={{ gridTemplateColumns: `${collapsed ? 72 : 248}px minmax(0, 1fr)` }}
      >
        <DesktopNavigation
          collapsed={collapsed}
          route={route}
          session={session}
          projectId={projectId}
          projects={projects}
          currentProjectTitle={currentProject?.title}
          onCollapseChange={updateCollapsed}
        />

        <MobileHeader
          title={currentProject?.title ?? "Hunsu"}
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          route={route}
          projectId={projectId}
          projects={projects}
        />

        <div className="min-w-0 overflow-hidden">{children}</div>
      </div>
    </TooltipProvider>
  );
}

function DesktopNavigation({
  collapsed,
  route,
  session,
  projectId,
  projects,
  currentProjectTitle,
  onCollapseChange
}: {
  collapsed: boolean;
  route: AppRoute;
  session: SessionResponse;
  projectId: string | null;
  projects: ProjectListResponse["projects"];
  currentProjectTitle: string | undefined;
  onCollapseChange: (collapsed: boolean) => void;
}) {
  return (
    <aside className={cn(
      "apple-glass sticky top-0 z-40 hidden h-screen min-w-0 flex-col overflow-hidden border-y-0 border-l-0 py-4 lg:flex",
      collapsed ? "items-center px-2" : "px-3"
    )}>
      <div className={cn("flex w-full min-w-0 items-center", collapsed ? "flex-col gap-3" : "gap-2")}>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-[13px] font-semibold text-white"
          aria-label="Open Projects"
          onClick={() => pushAppPath("/projects")}
        >
          H
        </button>
        {!collapsed ? <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{currentProjectTitle ?? "Hunsu"}</p> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={() => onCollapseChange(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
      </div>

      {!collapsed ? (
        <div className="mt-6">
          <label htmlFor="project-selector" className="sr-only">Project</label>
          <select
            id="project-selector"
            className="h-10 w-full rounded-[12px] border bg-white/58 px-3 text-[12px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
            value={projectId ?? ""}
            onChange={event => pushAppPath(event.target.value ? projectGraphPath(event.target.value) : "/projects")}
          >
            <option value="">All Projects</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
        </div>
      ) : null}

      <nav className={cn("mt-5 grid w-full gap-1", collapsed && "justify-items-center")} aria-label="Project navigation">
        {projectId ? (
          <>
            <ProjectNavItem
              collapsed={collapsed}
              active={route.kind === "graph"}
              icon={<Network />}
              label="Node graph"
              onClick={() => pushAppPath(projectGraphPath(projectId))}
            />
            <ProjectNavItem
              collapsed={collapsed}
              active={route.kind === "events"}
              icon={<ListTree />}
              label="Events"
              onClick={() => pushAppPath(projectEventsPath(projectId))}
            />
          </>
        ) : (
          <ProjectNavItem
            collapsed={collapsed}
            active={route.kind === "projects"}
            icon={<FolderKanban />}
            label="Projects"
            onClick={() => pushAppPath("/projects")}
          />
        )}
      </nav>

      <div className={cn("mt-auto w-full rounded-[14px] border bg-white/44 p-2", collapsed && "flex justify-center border-transparent bg-transparent")}>
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
                {projects.length > 0 ? `${projects.length} Project${projects.length === 1 ? "" : "s"}` : session.workspace?.accountLogin ?? "Connected"}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function ProjectNavItem({
  collapsed,
  active,
  icon,
  label,
  onClick
}: {
  collapsed: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const item = (
    <button
      type="button"
      className={cn(
        "relative flex min-w-0 items-center gap-3 rounded-[12px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        collapsed ? "size-11 justify-center" : "min-h-11 w-full px-2",
        active ? "bg-white/58 text-foreground" : "text-[color:var(--apple-body)] hover:bg-white/42"
      )}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={onClick}
    >
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", active ? "text-[color:var(--apple-blue)]" : "text-muted-foreground")}>{icon}</span>
      {!collapsed ? <span className="truncate text-[13px] font-medium">{label}</span> : null}
    </button>
  );
  if (!collapsed) return item;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function MobileHeader({
  title,
  open,
  onOpenChange,
  route,
  projectId,
  projects
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: AppRoute;
  projectId: string | null;
  projects: ProjectListResponse["projects"];
}) {
  function navigate(path: string) {
    onOpenChange(false);
    pushAppPath(path);
  }
  return (
    <>
      <header className="apple-glass sticky top-0 z-40 flex h-14 items-center gap-3 border-x-0 border-t-0 px-4 lg:hidden">
        <Button type="button" size="icon" variant="ghost" className="size-9" aria-label="Open navigation" onClick={() => onOpenChange(true)}><Menu /></Button>
        <span className="flex size-8 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-[11px] font-semibold text-white">H</span>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{title}</p>
      </header>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-[min(86vw,320px)] bg-[color:var(--apple-canvas-alt)]">
          <SheetHeader>
            <SheetTitle>Hunsu</SheetTitle>
            <SheetDescription>Choose a Project view.</SheetDescription>
          </SheetHeader>
          <label htmlFor="mobile-project-selector" className="sr-only">Project</label>
          <select
            id="mobile-project-selector"
            className="mt-6 h-11 w-full rounded-[12px] border bg-white px-3 text-sm"
            value={projectId ?? ""}
            onChange={event => navigate(event.target.value ? projectGraphPath(event.target.value) : "/projects")}
          >
            <option value="">All Projects</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          <nav className="mt-5 grid gap-1" aria-label="Mobile Project navigation">
            {projectId ? (
              <>
                <MobileNavItem active={route.kind === "graph"} icon={<Network />} label="Node graph" onClick={() => navigate(projectGraphPath(projectId))} />
                <MobileNavItem active={route.kind === "events"} icon={<ListTree />} label="Events" onClick={() => navigate(projectEventsPath(projectId))} />
              </>
            ) : (
              <MobileNavItem active={route.kind === "projects"} icon={<FolderKanban />} label="Projects" onClick={() => navigate("/projects")} />
            )}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}

function MobileNavItem({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn("flex h-12 items-center gap-3 rounded-[12px] px-3 text-sm", active ? "bg-white font-semibold text-[color:var(--apple-blue)]" : "text-[color:var(--apple-body)]")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="[&_svg]:size-4">{icon}</span>{label}
    </button>
  );
}

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(NAVIGATION_KEY) === "collapsed";
  } catch {
    return false;
  }
}
