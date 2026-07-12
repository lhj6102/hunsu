import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { BookOpen, Clipboard, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { HUNSU_WEB_RUNTIME_CONFIG } from "@/shared/config/runtimeConfig";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { hubCatalogDetailPath, hubMarketplacePath, hubMarketplaceSections, hubResourceDetailPath, hubVersionRef, kindLabel, marketplaceSection, matchesHubResourceRouteDetail, matchesHubRouteDetail, normalizeHubTags, packagesForMarketplace, parseHubPath, resourcesForMarketplace, type HubMarketplaceId, type HubPackageSummary, type HubResourceSummary, type HubRouteState, type HubTagId } from "./hubMarketplace.js";

const HUB_API_BASE_URL = HUNSU_WEB_RUNTIME_CONFIG.hubApiBaseUrl;

export function HubScreen() {
  const [packages, setPackages] = useState<HubPackageSummary[]>([]);
  const [resources, setResources] = useState<HubResourceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [routeState, setRouteState] = useState<HubRouteState>(() => parseHubPath(window.location.pathname, window.location.search));
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unconfigured" | "offline">("idle");
  const selectedMarketplace = routeState.marketplaceId;
  const selectedTags = routeState.tags;

  const loadPackages = () => {
    if (!HUB_API_BASE_URL) {
      setPackages([]);
      setResources([]);
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    Promise.all([
      fetch(`${HUB_API_BASE_URL}/api/hub/packages`).then(async response => {
        if (!response.ok) throw new Error(`Hub packages returned ${response.status}`);
        return response.json() as Promise<{ packages: HubPackageSummary[] }>;
      }),
      fetch(`${HUB_API_BASE_URL}/api/hub/resources`).then(async response => {
        if (!response.ok) throw new Error(`Hub resources returned ${response.status}`);
        return response.json() as Promise<{ resources: HubResourceSummary[] }>;
      })
    ])
      .then(([packageResult, resourceResult]) => {
        setPackages(packageResult.packages);
        setResources(resourceResult.resources);
        setStatus("ready");
      })
      .catch(() => {
        setPackages([]);
        setResources([]);
        setStatus("offline");
      });
  };

  useEffect(() => {
    loadPackages();
  }, []);

  useEffect(() => {
    if (window.location.pathname === "/hub") {
      const route = parseHubPath(hubMarketplacePath("executor"));
      window.history.replaceState({}, "", hubMarketplacePath("executor"));
      setRouteState(route);
    }
    const handlePopState = () => setRouteState(parseHubPath(window.location.pathname, window.location.search));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const visiblePackages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return packagesForMarketplace(packages, selectedMarketplace, selectedTags)
      .filter(item => !normalized || `${item.key} ${item.label} ${item.version} ${item.sourcePackageKey} ${item.executorId ?? ""} ${(item.memberOf ?? []).join(" ")}`.toLowerCase().includes(normalized));
  }, [packages, query, selectedMarketplace, selectedTags]);
  const visibleResources = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return resourcesForMarketplace(resources, selectedMarketplace, selectedTags)
      .filter(item => !normalized || `${item.resourceKey} ${item.title} ${item.packageKey}`.toLowerCase().includes(normalized));
  }, [resources, query, selectedMarketplace, selectedTags]);
  const selectedSection = marketplaceSection(selectedMarketplace);
  const selectedDetail = routeState.detail
    ? packages.find(item => matchesHubRouteDetail(item, routeState.detail))
    : undefined;
  const selectedResourceDetail = routeState.resourceDetail
    ? resources.find(item => matchesHubResourceRouteDetail(item, routeState.resourceDetail))
    : undefined;

  const selectMarketplace = (id: HubMarketplaceId) => {
    const path = hubMarketplacePath(id);
    window.history.pushState({}, "", path);
    setRouteState(parseHubPath(path));
  };

  const selectTags = (tags: HubTagId[]) => {
    const path = hubMarketplacePath(selectedMarketplace, normalizeHubTags(selectedMarketplace, tags));
    window.history.pushState({}, "", path);
    const url = new URL(path, window.location.origin);
    setRouteState(parseHubPath(url.pathname, url.search));
  };

  const openPackageDetail = (item: HubPackageSummary) => {
    const params = new URLSearchParams();
    for (const tag of selectedTags) {
      params.append("tag", tag);
    }
    const queryString = params.toString();
    const path = queryString ? `${hubCatalogDetailPath(item)}?${queryString}` : hubCatalogDetailPath(item);
    window.history.pushState({}, "", path);
    setRouteState(parseHubPath(window.location.pathname, window.location.search));
  };

  const openResourceDetail = (item: HubResourceSummary) => {
    const params = new URLSearchParams();
    for (const tag of selectedTags) {
      params.append("tag", tag);
    }
    const queryString = params.toString();
    const path = queryString ? `${hubResourceDetailPath(item)}?${queryString}` : hubResourceDetailPath(item);
    window.history.pushState({}, "", path);
    setRouteState(parseHubPath(window.location.pathname, window.location.search));
  };

  const closeDetail = () => {
    const path = hubMarketplacePath(selectedMarketplace, routeState.tags);
    window.history.pushState({}, "", path);
    const url = new URL(path, window.location.origin);
    setRouteState(parseHubPath(url.pathname, url.search));
  };

  return (
    <main className="apple-page h-screen overflow-auto px-6 py-8 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-6xl">
        <div>
          <div>
            <p className="text-[13px] font-medium leading-5 text-muted-foreground">Hunsu Hub</p>
            <h1 className="mt-1 font-[family-name:var(--apple-font-display)] text-[44px] font-semibold leading-[1.08] tracking-normal">
              Packages
            </h1>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-5 border-b border-border md:flex-row md:items-end md:justify-between">
          <div className="flex min-w-0 gap-6 overflow-x-auto">
            {hubMarketplaceSections.map(section => (
              <button
                key={section.id}
                type="button"
                className={cn(
                  "shrink-0 border-b-2 pb-3 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
                  selectedMarketplace === section.id
                    ? "border-[color:var(--apple-blue)] text-[color:var(--apple-blue)]"
                    : "border-transparent text-muted-foreground hover:text-[color:var(--apple-ink)]"
                )}
                aria-pressed={selectedMarketplace === section.id}
                onClick={() => selectMarketplace(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 border-b border-transparent pb-3 md:w-[360px]">
            <Search className="pointer-events-none absolute left-0 top-1 size-4 text-muted-foreground" />
            <input
              aria-label="Search Hub"
              className="h-6 w-full min-w-0 bg-transparent pl-7 text-[15px] leading-6 text-[color:var(--apple-ink)] outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search packages"
            />
          </div>
        </div>

        {status === "unconfigured" ? (
          <HubNotice text="Hub API is not configured for this Web build." />
        ) : null}
        {status === "offline" ? (
          <HubNotice text="Hub API is unavailable." />
        ) : null}

        <HubTagFilters section={selectedSection} selectedTags={selectedTags} onSelectTags={selectTags} />

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {visiblePackages.map(item => (
            <PackageCard key={`${item.kind}:${item.key}:${item.version}`} item={item} onOpenDetail={openPackageDetail} />
          ))}
          {visibleResources.map(item => (
            <ResourceCard key={`${item.resourceKind}:${item.resourceKey}:${item.packageKey}:${item.version}`} item={item} onOpenDetail={openResourceDetail} />
          ))}
          {status !== "loading" && visiblePackages.length === 0 && visibleResources.length === 0 ? (
            <div className="py-2 text-sm text-muted-foreground md:col-span-3">No packages found in {selectedSection.label}.</div>
          ) : null}
        </div>
      </div>
      <PackageDetailDialog item={selectedDetail} open={Boolean(routeState.detail && selectedDetail)} onOpenChange={open => {
        if (!open) closeDetail();
      }} />
      <ResourceDetailDialog item={selectedResourceDetail} open={Boolean(routeState.resourceDetail && selectedResourceDetail)} onOpenChange={open => {
        if (!open) closeDetail();
      }} />
    </main>
  );
}

function HubNotice({ text }: { text: string }) {
  return <div className="mt-6 text-sm text-muted-foreground">{text}</div>;
}

function HubTagFilters({ section, selectedTags, onSelectTags }: { section: ReturnType<typeof marketplaceSection>; selectedTags: HubTagId[]; onSelectTags: (tags: HubTagId[]) => void }) {
  const allSelected = selectedTags.length === 0;
  const toggleTag = (tag: HubTagId) => {
    if (selectedTags.includes(tag)) {
      onSelectTags(selectedTags.filter(item => item !== tag));
    } else {
      onSelectTags([...selectedTags, tag]);
    }
  };
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={allSelected ? "default" : "outline"}
        aria-pressed={allSelected}
        onClick={() => onSelectTags([])}
      >
        All
      </Button>
      {section.tags.map(tag => {
        const selected = selectedTags.includes(tag.id);
        return (
          <Button
            key={tag.id}
            type="button"
            size="sm"
            variant={selected ? "default" : "outline"}
            aria-pressed={selected}
            onClick={() => toggleTag(tag.id)}
          >
            {tag.label}
          </Button>
        );
      })}
    </div>
  );
}

function ResourceCard({ item, onOpenDetail }: { item: HubResourceSummary; onOpenDetail: (item: HubResourceSummary) => void }) {
  const link = resourceLink(item);
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDetail(item);
    }
  };
  return (
    <Card
      className="cursor-pointer bg-white/68 transition-colors hover:bg-white/82 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(item)}
      onKeyDown={openFromKeyboard}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-base">{item.title}</CardTitle>
          <Badge variant="outline">Plugin Requirement</Badge>
        </div>
        <CardDescription className="truncate">{hubVersionRef(item.origin, item.packageKey, item.version)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 text-sm text-muted-foreground">
          <p className="truncate">{item.resourceKey}</p>
          <p>Required by {kindLabel(item.packageKind)}</p>
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="w-full justify-start" variant="outline" onClick={event => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(link);
          }}>
            <Clipboard />
            Copy Link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PackageCard({ item, onOpenDetail }: { item: HubPackageSummary; onOpenDetail: (item: HubPackageSummary) => void }) {
  const link = packageLink(item);
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDetail(item);
    }
  };
  return (
    <Card
      className="cursor-pointer bg-white/68 transition-colors hover:bg-white/82 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(item)}
      onKeyDown={openFromKeyboard}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-base">{item.label}</CardTitle>
          <Badge variant={item.kind === "team" ? "success" : "outline"}>{kindLabel(item.kind)}</Badge>
        </div>
        <CardDescription className="truncate">{packageDescription(item)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 text-sm text-muted-foreground">
          {item.promptTemplateEngine ? <p>Template {item.promptTemplateEngine}</p> : null}
          {item.memberCount !== undefined ? <p>{item.memberCount} linked members</p> : null}
          {item.skillCount !== undefined ? <p>{item.skillCount} skills</p> : null}
          {item.pluginRequirementCount !== undefined ? <p>{item.pluginRequirementCount} plugin requirements</p> : null}
          {item.memberOf?.length ? <p className="truncate">Member of {item.memberOf.join(", ")}</p> : null}
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="w-full justify-start" variant="outline" onClick={event => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(link);
          }}>
            <Clipboard />
            Copy Link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function packageLink(item: HubPackageSummary): string {
  return new URL(hubCatalogDetailPath(item), window.location.origin).toString();
}

function resourceLink(item: HubResourceSummary): string {
  return new URL(hubResourceDetailPath(item), window.location.origin).toString();
}

function rawManifestUrl(item: HubPackageSummary): string {
  return `${HUB_API_BASE_URL}/v1/packages/${item.sourcePackageKind}/${encodeURIComponent(item.sourcePackageKey)}/versions/${encodeURIComponent(item.sourcePackageVersion)}`;
}

function rawResourceSourceUrl(item: HubResourceSummary): string {
  return `${HUB_API_BASE_URL}/v1/packages/${item.packageKind}/${encodeURIComponent(item.packageKey)}/versions/${encodeURIComponent(item.version)}`;
}

function PackageDetailDialog({ item, open, onOpenChange }: { item: HubPackageSummary | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!item) {
    return null;
  }
  const link = packageLink(item);
  return (
    <HubDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item.label}
      description={packageDescription(item)}
      badge={kindLabel(item.kind)}
      metrics={packageMetrics(item)}
      footer={(
        <>
          <Button className="justify-start" onClick={() => void navigator.clipboard?.writeText(link)}>
            <Clipboard />
            Copy Link
          </Button>
          <Button asChild className="justify-start" variant="outline">
            <a href={rawManifestUrl(item)}>
              <BookOpen />
              Raw Manifest
            </a>
          </Button>
        </>
      )}
    >
      <DetailRows
        rows={[
          { label: "Package", value: hubVersionRef(item.origin, item.key, item.version) },
          { label: "Source", value: `${kindLabel(item.sourcePackageKind)} ${hubVersionRef(item.origin, item.sourcePackageKey, item.sourcePackageVersion)}` },
          item.entryKind === "executor" && item.executorId ? { label: "Executor ID", value: item.executorId } : undefined,
          item.memberOf?.length ? { label: "Member Of", value: item.memberOf.join(", ") } : undefined
        ]}
      />
    </HubDetailDialog>
  );
}

function ResourceDetailDialog({ item, open, onOpenChange }: { item: HubResourceSummary | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!item) {
    return null;
  }
  const link = resourceLink(item);
  return (
    <HubDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item.title}
      description={resourceDescription(item)}
      badge="Plugin Requirement"
      metrics={[
        { label: "Resource", value: "Plugin" },
        { label: "Required By", value: kindLabel(item.packageKind) },
        { label: "Version", value: item.version }
      ]}
      footer={(
        <>
          <Button className="justify-start" onClick={() => void navigator.clipboard?.writeText(link)}>
            <Clipboard />
            Copy Link
          </Button>
          <Button asChild className="justify-start" variant="outline">
            <a href={rawResourceSourceUrl(item)}>
              <BookOpen />
              Source Manifest
            </a>
          </Button>
        </>
      )}
    >
      <DetailRows
        rows={[
          { label: "Resource Key", value: item.resourceKey, tone: "code" },
          { label: "Source", value: `${kindLabel(item.packageKind)} ${hubVersionRef(item.origin, item.packageKey, item.version)}` }
        ]}
      />
    </HubDetailDialog>
  );
}

function HubDetailDialog({ open, onOpenChange, title, description, badge, metrics, footer, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; badge: string; metrics: Array<{ label: string; value: string }>; footer: ReactNode; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="hub-detail-dialog max-h-[calc(100vh-2rem)] max-w-[760px] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pb-5 pt-7 sm:px-8">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="min-w-0">
              <DialogTitle className="break-words font-[family-name:var(--apple-font-display)] text-[32px] font-semibold leading-[1.12] tracking-normal text-[color:var(--apple-ink)]">
                {title}
              </DialogTitle>
              <DialogDescription className="mt-2 break-words text-[15px] leading-6 text-[color:var(--apple-muted)]">
                {description}
              </DialogDescription>
            </div>
            <Badge className="border-[color:var(--apple-blue)] bg-white text-[color:var(--apple-blue)]" variant="outline">{badge}</Badge>
          </div>
          <DetailMetrics metrics={metrics} />
        </DialogHeader>
        <div className="max-h-[calc(100vh-17rem)] overflow-y-auto px-6 py-2 sm:px-8">
          {children}
        </div>
        <div className="flex flex-col gap-2 border-t border-[color:var(--apple-hairline)] bg-[color:var(--apple-canvas-alt)]/72 px-6 py-4 sm:flex-row sm:px-8">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailMetrics({ metrics }: { metrics: Array<{ label: string; value: string }> }) {
  return (
    <dl className="mt-6 grid gap-4 border-y border-[color:var(--apple-hairline)] py-4 text-[14px] leading-5 sm:grid-cols-3">
      {metrics.map(metric => (
        <div key={metric.label} className="min-w-0">
          <dt className="text-[color:var(--apple-muted)]">{metric.label}</dt>
          <dd className="mt-1 truncate font-semibold text-[color:var(--apple-ink)]">{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailRows({ rows }: { rows: Array<{ label: string; value: string; tone?: "code" } | undefined> }) {
  const visibleRows = rows.filter((row): row is { label: string; value: string; tone?: "code" } => Boolean(row));
  return (
    <div className="divide-y divide-[color:var(--apple-hairline)]">
      {visibleRows.map(row => (
        <div key={row.label} className="grid gap-1 py-4 text-[14px] leading-5 sm:grid-cols-[156px_minmax(0,1fr)] sm:gap-6">
          <div className="text-[color:var(--apple-muted)]">{row.label}</div>
          <div className={cn(
            "min-w-0 break-words font-medium text-[color:var(--apple-ink)]",
            row.tone === "code" ? "font-mono text-[12px] leading-5 text-[color:var(--apple-body)]" : null
          )}>
            {row.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function packageMetrics(item: HubPackageSummary): Array<{ label: string; value: string }> {
  if (item.memberCount !== undefined) {
    return [
      { label: "Direct Members", value: String(item.memberCount) },
      { label: "Skills", value: String(item.skillCount ?? 0) },
      { label: "Plugins", value: String(item.pluginRequirementCount ?? 0) }
    ];
  }
  if (item.kind === "skill") {
    return [
      { label: "Kind", value: kindLabel(item.kind) },
      { label: "Version", value: item.version },
      { label: "Provider", value: item.origin }
    ];
  }
  return [
    { label: "Prompt Engine", value: item.promptTemplateEngine ?? "Manifest" },
    { label: "Skills", value: String(item.skillCount ?? 0) },
    { label: "Plugins", value: String(item.pluginRequirementCount ?? 0) }
  ];
}

function packageDescription(item: HubPackageSummary): string {
  if (item.entryKind === "executor" && item.executorId) {
    return `${hubVersionRef(item.origin, item.sourcePackageKey, item.sourcePackageVersion)} / ${item.executorId}`;
  }
  return hubVersionRef(item.origin, item.key, item.version);
}

function resourceDescription(item: HubResourceSummary): string {
  return `${kindLabel(item.packageKind)} ${hubVersionRef(item.origin, item.packageKey, item.version)}`;
}
