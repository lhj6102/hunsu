import { useMemo, useState } from "react";
import { ArrowLeft, Boxes, ListTree } from "lucide-react";
import { pushStudioPath } from "@/app/routes";
import { Button } from "@/shared/ui/button";
import { Badge } from "@/shared/ui/badge";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import { pathStories, pathStoryByNumber } from "@/shared/design/pathStories";
import { scenarioByNumber } from "@/shared/design/studioScenarios";
import { PathStoryBoard } from "@/features/roadmap-graph/PathStoryBoard";
import { ScenarioBoard } from "@/features/roadmap-graph/ScenarioBoard";

export function HandoffGallery() {
  const [scenarioNumber, setScenarioNumber] = useState(17);
  const story = useMemo(() => pathStoryByNumber(scenarioNumber), [scenarioNumber]);

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-[color:var(--studio-canvas-tint)] text-foreground">
        <div className="grid min-h-screen lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="self-start border-r border-[color:var(--studio-border-subtle)] bg-white/82 p-4 lg:sticky lg:top-0 lg:h-screen lg:overflow-hidden">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Hunsu Studio</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-normal">Component & Scenario Board</h1>
              </div>
              <Button variant="outline" size="icon" aria-label="Back to Studio" onClick={() => pushStudioPath("/studio")}>
                <ArrowLeft />
              </Button>
            </div>

            <div className="mt-4 rounded-2xl border bg-background p-3">
              <div className="flex items-center gap-2">
                <ListTree className="size-4 text-[color:var(--studio-execute-phase)]" />
                <h2 className="text-sm font-semibold">Path Story 1-17</h2>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Extracted from the Figma Path Story storyboard page. Each step changes visible route nodes, fork state, Path points, and Team legend state.
              </p>
            </div>

            <ScrollArea className="mt-4 h-[calc(100vh-262px)] pr-2">
              <div className="grid gap-2">
                {pathStories.map(item => (
                  <button
                    key={item.number}
                    type="button"
                    onClick={() => setScenarioNumber(item.number)}
                    className={
                      item.number === story.number
                        ? "rounded-xl border border-[color:var(--studio-faker)] bg-[color-mix(in_oklab,var(--studio-faker),white_90%)] p-3 text-left shadow-sm"
                        : "rounded-xl border bg-background p-3 text-left transition-colors hover:bg-accent"
                    }
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-muted-foreground">Step {String(item.number).padStart(2, "0")}</span>
                      <Badge variant="outline">{item.teams.at(-1)?.state ?? "ready"}</Badge>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium">{item.title}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{item.description}</p>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>

          <section className="min-w-0 p-4 lg:p-6">
            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Source Contract</p>
                <h2 className="mt-1 text-3xl font-semibold tracking-normal">RoadmapV3 / HunsuStudio</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.values(figmaComponentNames).map(name => (
                  <Badge key={name} variant="outline" className="font-mono text-[10px]">{name}</Badge>
                ))}
              </div>
            </div>

            <PathStoryBoard story={story} />

            <Separator className="my-6" />

            <section>
              <div className="mb-3 flex items-center gap-2">
                <Boxes className="size-4 text-[color:var(--studio-canyon)]" />
                <h2 className="text-lg font-semibold">Component Matrix</h2>
                <Badge variant="muted">Move / Execute / Hunsu / Accident</Badge>
              </div>
              <ScenarioBoard scenario={scenarioByNumber(11)} showComponentMatrix showInspector compactBranches />
            </section>
          </section>
        </div>
      </main>
    </TooltipProvider>
  );
}
