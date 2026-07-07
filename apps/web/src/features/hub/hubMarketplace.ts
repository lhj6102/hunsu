export type HubPackageKind = "team" | "member" | "manager" | "skill";
export type HubMarketplaceId = "executor" | "hunsu" | "resources";
export type HubTagId = "team" | "member" | "manager" | "skill" | "plugin";

export type HubRouteState = {
  marketplaceId: HubMarketplaceId;
  tags: HubTagId[];
  detail?: {
    origin: string;
    kind: HubPackageKind;
    key: string;
    version: string;
    executorId?: string;
  };
  resourceDetail?: {
    origin: string;
    resourceKind: HubResourceSummary["resourceKind"];
    resourceKey: string;
    packageKind: HubPackageKind;
    packageKey: string;
    version: string;
  };
};

export type HubPackageSummary = {
  origin: string;
  entryKind: "package" | "executor";
  kind: HubPackageKind;
  key: string;
  version: string;
  integrity: string;
  label: string;
  sourcePackageKind: HubPackageKind;
  sourcePackageKey: string;
  sourcePackageVersion: string;
  executorId?: string;
  memberOf?: string[];
  promptTemplateEngine?: string;
  memberCount?: number;
  skillCount?: number;
  pluginRequirementCount?: number;
};

export type HubResourceSummary = {
  origin: string;
  resourceKind: "skill" | "plugin" | "package";
  resourceKey: string;
  title: string;
  packageKind: HubPackageKind;
  packageKey: string;
  version: string;
};

export const hubMarketplaceSections: Array<{
  id: HubMarketplaceId;
  label: string;
  kinds: HubPackageKind[];
  tags: Array<{ id: HubTagId; label: string }>;
}> = [
  { id: "executor", label: "Executor Marketplace", kinds: ["team", "member"], tags: [{ id: "team", label: "Team" }, { id: "member", label: "Member" }] },
  { id: "hunsu", label: "Hunsu Marketplace", kinds: ["manager"], tags: [{ id: "manager", label: "Manager" }] },
  { id: "resources", label: "Skills & Plugins", kinds: ["skill"], tags: [{ id: "skill", label: "Skill" }, { id: "plugin", label: "Plugin Requirement" }] }
];

const hubMarketplacePaths: Record<HubMarketplaceId, string> = {
  executor: "/hub/executor",
  hunsu: "/hub/hunsu",
  resources: "/hub/resources"
};

export function marketplaceSection(id: HubMarketplaceId) {
  return hubMarketplaceSections.find(section => section.id === id) ?? hubMarketplaceSections[0];
}

export function packagesForMarketplace(packages: HubPackageSummary[], id: HubMarketplaceId, tags: HubTagId[] = []): HubPackageSummary[] {
  const section = marketplaceSection(id);
  return packages.filter(item => section.kinds.includes(item.kind) && (tags.length === 0 || tags.includes(item.kind)));
}

export function resourcesForMarketplace(resources: HubResourceSummary[], id: HubMarketplaceId, tags: HubTagId[] = []): HubResourceSummary[] {
  return id === "resources"
    ? resources.filter(item => item.resourceKind === "plugin" && (tags.length === 0 || tags.includes("plugin")))
    : [];
}

export function kindLabel(kind: HubPackageKind): string {
  if (kind === "team") return "Team";
  if (kind === "member") return "Member";
  if (kind === "manager") return "Manager";
  return "Skill";
}

export function hubMarketplacePath(id: HubMarketplaceId, tags: HubTagId[] = []): string {
  const validTags = normalizeHubTags(id, tags);
  if (validTags.length === 0) {
    return hubMarketplacePaths[id];
  }
  const params = new URLSearchParams();
  for (const tag of validTags) {
    params.append("tag", tag);
  }
  return `${hubMarketplacePaths[id]}?${params.toString()}`;
}

export function hubEntityRef(origin: string, key: string): string {
  return `@${origin}/${key}`;
}

export function hubVersionRef(origin: string, key: string, version: string): string {
  return `${hubEntityRef(origin, key)}@${version}`;
}

export function hubPackageDetailPath(item: Pick<HubPackageSummary, "origin" | "kind" | "key" | "version">): string {
  const marketplaceId = marketplaceIdForPackageKind(item.kind);
  return `${hubMarketplacePaths[marketplaceId]}/${item.kind}/${refPath(item.origin, item.key)}/versions/${encodeURIComponent(item.version)}`;
}

export function hubResourceDetailPath(item: HubResourceSummary): string {
  return `/hub/resources/${item.resourceKind}/${item.packageKind}/${refPath(item.origin, item.packageKey)}/resources/${encodeURIComponent(item.resourceKey)}/versions/${encodeURIComponent(item.version)}`;
}

export function parseHubPath(pathname: string, search = ""): HubRouteState {
  const resourceDetail = pathname.match(/^\/hub\/resources\/(skill|plugin|package)\/(team|member|manager|skill)\/@([^/]+)\/([^/]+)\/resources\/([^/]+)\/versions\/([^/]+)$/);
  if (resourceDetail?.[1] && resourceDetail[2] && resourceDetail[3] && resourceDetail[4] && resourceDetail[5] && resourceDetail[6]) {
    return {
      marketplaceId: "resources",
      tags: normalizeHubTags("resources", tagsFromSearch(search)),
      resourceDetail: {
        origin: decodeURIComponent(resourceDetail[3]),
        resourceKind: resourceDetail[1] as HubResourceSummary["resourceKind"],
        packageKind: resourceDetail[2] as HubPackageKind,
        packageKey: decodeURIComponent(resourceDetail[4]),
        resourceKey: decodeURIComponent(resourceDetail[5]),
        version: decodeURIComponent(resourceDetail[6])
      }
    };
  }
  const executorDetail = pathname.match(/^\/hub\/executor\/(team|member)\/@([^/]+)\/([^/]+)\/executors\/([^/]+)\/versions\/([^/]+)$/);
  if (executorDetail?.[1] && executorDetail[2] && executorDetail[3] && executorDetail[4] && executorDetail[5]) {
    return {
      marketplaceId: "executor",
      tags: normalizeHubTags("executor", tagsFromSearch(search)),
      detail: {
        origin: decodeURIComponent(executorDetail[2]),
        kind: executorDetail[1] as HubPackageKind,
        key: decodeURIComponent(executorDetail[3]),
        executorId: decodeURIComponent(executorDetail[4]),
        version: decodeURIComponent(executorDetail[5])
      }
    };
  }
  const detail = pathname.match(/^\/hub\/(executor|hunsu|resources)\/(team|member|manager|skill)\/@([^/]+)\/([^/]+)\/versions\/([^/]+)$/);
  if (detail?.[1] && detail[2] && detail[3] && detail[4] && detail[5]) {
    const marketplaceId = detail[1] as HubMarketplaceId;
    const kind = detail[2] as HubPackageKind;
    return {
      marketplaceId,
      tags: normalizeHubTags(marketplaceId, tagsFromSearch(search)),
      detail: {
        origin: decodeURIComponent(detail[3]),
        kind,
        key: decodeURIComponent(detail[4]),
        version: decodeURIComponent(detail[5])
      }
    };
  }
  const list = pathname.match(/^\/hub\/(executor|hunsu|resources)$/);
  if (list?.[1]) {
    const marketplaceId = list[1] as HubMarketplaceId;
    return { marketplaceId, tags: normalizeHubTags(marketplaceId, tagsFromSearch(search)) };
  }
  return { marketplaceId: "executor", tags: normalizeHubTags("executor", tagsFromSearch(search)) };
}

export function marketplaceIdForPackageKind(kind: HubPackageKind): HubMarketplaceId {
  if (kind === "manager") return "hunsu";
  if (kind === "skill") return "resources";
  return "executor";
}

export function hubCatalogDetailPath(item: HubPackageSummary): string {
  if (item.entryKind === "executor" && item.executorId) {
    return `/hub/executor/${item.kind}/${refPath(item.origin, item.sourcePackageKey)}/executors/${encodeURIComponent(item.executorId)}/versions/${encodeURIComponent(item.sourcePackageVersion)}`;
  }
  return hubPackageDetailPath(item);
}

export function matchesHubRouteDetail(item: HubPackageSummary, detail: HubRouteState["detail"]): boolean {
  if (!detail) {
    return false;
  }
  if (detail.executorId) {
    return item.entryKind === "executor"
      && item.origin === detail.origin
      && item.kind === detail.kind
      && item.sourcePackageKey === detail.key
      && item.sourcePackageVersion === detail.version
      && item.executorId === detail.executorId;
  }
  return item.origin === detail.origin && item.kind === detail.kind && item.key === detail.key && item.version === detail.version;
}

export function matchesHubResourceRouteDetail(item: HubResourceSummary, detail: HubRouteState["resourceDetail"]): boolean {
  if (!detail) {
    return false;
  }
  return item.resourceKind === detail.resourceKind
    && item.origin === detail.origin
    && item.resourceKey === detail.resourceKey
    && item.packageKind === detail.packageKind
    && item.packageKey === detail.packageKey
    && item.version === detail.version;
}

export function normalizeHubTags(id: HubMarketplaceId, tags: HubTagId[]): HubTagId[] {
  const allowed = new Set(marketplaceSection(id).tags.map(tag => tag.id));
  return [...new Set(tags)].filter(tag => allowed.has(tag));
}

function tagsFromSearch(search: string): HubTagId[] {
  const params = new URLSearchParams(search);
  const values = params.getAll("tag").flatMap(value => value.split(","));
  return values.filter(isHubTagId);
}

function isHubTagId(value: string): value is HubTagId {
  return value === "team" || value === "member" || value === "manager" || value === "skill" || value === "plugin";
}

function refPath(origin: string, key: string): string {
  return `@${encodeURIComponent(origin)}/${encodeURIComponent(key)}`;
}
