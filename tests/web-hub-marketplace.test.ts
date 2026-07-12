import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hubMarketplaceSections,
  hubMarketplacePath,
  hubPackageDetailPath,
  hubResourceDetailPath,
  parseHubPath,
  kindLabel,
  packagesForMarketplace,
  resourcesForMarketplace,
  type HubPackageSummary,
  type HubResourceSummary
} from "../apps/web/src/features/hub/hubMarketplace.ts";
import { parseStudioRoute, setupPath } from "../apps/web/src/app/routes.ts";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");

test("Hub marketplace model groups Executors, Managers, and independent Skills & Plugins", () => {
  assert.deepEqual(hubMarketplaceSections.map(section => section.label), [
    "Executor Marketplace",
    "Hunsu Marketplace",
    "Skills & Plugins"
  ]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "executor")?.kinds, ["team", "member"]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "hunsu")?.kinds, ["manager"]);
  assert.deepEqual(hubMarketplaceSections.find(section => section.id === "resources")?.kinds, ["skill"]);
});

test("Hub marketplace filters Manager cards outside Executor listings", () => {
  const packages: HubPackageSummary[] = [
    packageSummary("team", "team.superloopy.crew"),
    packageSummary("member", "member.reviewer"),
    packageSummary("manager", "manager.idea-helper"),
    packageSummary("skill", "skills.repo-audit")
  ];

  assert.deepEqual(packagesForMarketplace(packages, "executor").map(item => item.kind), ["team", "member"]);
  assert.deepEqual(packagesForMarketplace(packages, "executor", ["member"]).map(item => item.kind), ["member"]);
  assert.deepEqual(packagesForMarketplace(packages, "hunsu").map(item => item.kind), ["manager"]);
  assert.deepEqual(packagesForMarketplace(packages, "resources").map(item => item.kind), ["skill"]);
  assert.equal(kindLabel("manager"), "Manager");
});

test("Hub marketplace exposes Plugin requirements only through Skills & Plugins resources", () => {
  const resources: HubResourceSummary[] = [
    resourceSummary("plugin", "manager:manager.researcher:github@openai-curated"),
    resourceSummary("skill", "manager:manager.researcher:researcher")
  ];

  assert.deepEqual(resourcesForMarketplace(resources, "executor"), []);
  assert.deepEqual(resourcesForMarketplace(resources, "hunsu"), []);
  assert.deepEqual(resourcesForMarketplace(resources, "resources").map(item => item.resourceKind), ["plugin"]);
  assert.deepEqual(resourcesForMarketplace(resources, "resources", ["skill"]), []);
  assert.deepEqual(resourcesForMarketplace(resources, "resources", ["plugin"]).map(item => item.resourceKind), ["plugin"]);
});

test("Hub marketplace URL strategy maps list and detail routes", () => {
  assert.equal(hubMarketplacePath("executor"), "/hub/executor");
  assert.equal(hubMarketplacePath("executor", ["member"]), "/hub/executor?tag=member");
  assert.deepEqual(parseHubPath("/hub"), { marketplaceId: "executor", tags: [] });
  assert.deepEqual(parseHubPath("/hub/executor", "?tag=team&tag=member"), { marketplaceId: "executor", tags: ["team", "member"] });
  assert.deepEqual(parseHubPath("/hub/hunsu", "?tag=manager"), { marketplaceId: "hunsu", tags: ["manager"] });
  assert.deepEqual(parseHubPath("/hub/resources", "?tag=skill"), { marketplaceId: "resources", tags: ["skill"] });
  assert.deepEqual(parseHubPath("/hub/executor/team/@motorhome/team.superloopy.crew/versions/1.0.2"), {
    marketplaceId: "executor",
    tags: [],
    detail: {
      origin: "motorhome",
      kind: "team",
      key: "team.superloopy.crew",
      version: "1.0.2"
    }
  });
  assert.deepEqual(parseHubPath("/hub/executor/member/@motorhome/team.superloopy.crew/executors/build/versions/1.0.2", "?tag=member"), {
    marketplaceId: "executor",
    tags: ["member"],
    detail: {
      origin: "motorhome",
      kind: "member",
      key: "team.superloopy.crew",
      executorId: "build",
      version: "1.0.2"
    }
  });
  const pluginRequirement = resourceSummary("plugin", "manager:manager.researcher:github@openai-curated");
  assert.equal(
    hubResourceDetailPath(pluginRequirement),
    "/hub/resources/plugin/manager/@motorhome/manager.researcher/resources/manager%3Amanager.researcher%3Agithub%40openai-curated/versions/1.0.0"
  );
  assert.deepEqual(parseHubPath(hubResourceDetailPath(pluginRequirement), "?tag=plugin"), {
    marketplaceId: "resources",
    tags: ["plugin"],
    resourceDetail: {
      origin: "motorhome",
      resourceKind: "plugin",
      resourceKey: "manager:manager.researcher:github@openai-curated",
      packageKind: "manager",
      packageKey: "manager.researcher",
      version: "1.0.0"
    }
  });
  assert.equal(hubPackageDetailPath(packageSummary("manager", "manager.researcher")), "/hub/hunsu/manager/@motorhome/manager.researcher/versions/1.0.0");
  assert.deepEqual(parseStudioRoute({ pathname: "/hub/hunsu", search: "?tag=manager" } as Location), { kind: "hub" });
});

test("Studio setup route preserves only internal Studio next paths", () => {
  assert.deepEqual(parseStudioRoute({ pathname: "/studio/setup", search: "?next=%2Fstudio%2Fopen%3Fpath%3D%252Ftmp%252Fdemo" } as Location), {
    kind: "setup",
    next: "/studio/open?path=%2Ftmp%2Fdemo"
  });
  assert.deepEqual(parseStudioRoute({ pathname: "/studio/setup", search: "?next=https%3A%2F%2Fevil.example%2Fstudio" } as Location), {
    kind: "setup",
    next: "/studio"
  });
  assert.equal(setupPath("/studio/roadmaps/demo"), "/studio/setup?next=%2Fstudio%2Froadmaps%2Fdemo");
  assert.equal(setupPath("https://evil.example/studio"), "/studio/setup?next=%2Fstudio");
});

test("/hub renders without Bridge, Roadmap Registry fetch, or Setup redirect", async () => {
  const fetchCalls: string[] = [];
  const historyReplacements: string[] = [];
  const browser = installHubBrowserShim({
    url: "http://localhost/hub",
    fetchCalls,
    historyReplacements
  });
  const { render, close } = await loadAppRenderModule();
  try {
    const html = render();
    assert.match(html, /Hunsu Hub/);
    assert.match(html, /Packages/);
    assert.doesNotMatch(html, /Local Bridge required/);
    assert.equal(fetchCalls.some(url => url.includes("/api/roadmaps/recent")), false);
    assert.equal(historyReplacements.some(path => path.startsWith("/studio/setup")), false);
  } finally {
    await close();
    browser.restore();
  }
});


function packageSummary(kind: HubPackageSummary["kind"], key: string): HubPackageSummary {
  return {
    origin: "motorhome",
    entryKind: "package",
    kind,
    key,
    version: "1.0.0",
    integrity: "hunsu-json-c14n-v1+sha256:0000000000000000000000000000000000000000000000000000000000000000",
    label: key,
    sourcePackageKind: kind,
    sourcePackageKey: key,
    sourcePackageVersion: "1.0.0"
  };
}

type HubBrowserShimOptions = {
  url: string;
  fetchCalls: string[];
  historyReplacements: string[];
};

function installHubBrowserShim(options: HubBrowserShimOptions): { restore: () => void } {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousNavigator = globalThis.navigator;
  const storage = new Map<string, string>();
  const location = new URL(options.url);
  const history = {
    state: null,
    pushState: (_state: unknown, _unused: string, path?: string | URL | null) => {
      if (path) {
        updateLocation(location, path);
      }
    },
    replaceState: (_state: unknown, _unused: string, path?: string | URL | null) => {
      if (path) {
        options.historyReplacements.push(String(path));
        updateLocation(location, path);
      }
    }
  };
  const windowValue = {
    innerWidth: 1200,
    location,
    history,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: windowValue
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { clipboard: { writeText: () => Promise.resolve() } }
  });
  globalThis.fetch = ((input: URL | RequestInfo) => {
    options.fetchCalls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ error: "unexpected fetch" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    }));
  }) as typeof fetch;

  return {
    restore: () => {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: previousWindow
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: previousNavigator
      });
      globalThis.fetch = previousFetch;
    }
  };
}

function updateLocation(location: URL, path: string | URL): void {
  const next = new URL(String(path), location.origin);
  location.href = next.href;
}

async function loadAppRenderModule(): Promise<{ render: () => string; close: () => Promise<void> }> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: {
      alias: {
        "@": resolve(WEB_ROOT, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    ssr: {
      external: ["react", "react-dom", "@tanstack/react-query"]
    },
    server: {
      middlewareMode: true
    }
  });
  try {
    const react = await importWebDependency("react/index.js") as {
      default?: { createElement: (...args: unknown[]) => unknown };
      createElement: (...args: unknown[]) => unknown;
    };
    const reactDomServer = await importWebDependency("react-dom/server.node.js") as {
      renderToString: (element: unknown) => string;
    };
    const query = await importWebDependency("@tanstack/react-query/build/modern/index.js") as {
      QueryClient: new (options?: unknown) => { clear: () => void };
      QueryClientProvider: unknown;
    };
    const app = await server.ssrLoadModule("/src/app/App.tsx") as {
      App: unknown;
    };
    const createElement = react.createElement ?? react.default?.createElement;
    if (!createElement) {
      throw new Error("React SSR loader did not expose createElement.");
    }
    return {
      render: () => {
        const client = new query.QueryClient({
          defaultOptions: {
            queries: {
              retry: false
            }
          }
        });
        try {
          return reactDomServer.renderToString(createElement(
            query.QueryClientProvider,
            { client },
            createElement(app.App)
          ));
        } finally {
          client.clear();
        }
      },
      close: () => server.close()
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function importWebDependency(path: string): Promise<unknown> {
  return import(pathToFileURL(resolve(WEB_ROOT, "node_modules", path)).href);
}

function resourceSummary(resourceKind: HubResourceSummary["resourceKind"], resourceKey: string): HubResourceSummary {
  return {
    origin: "motorhome",
    resourceKind,
    resourceKey,
    title: resourceKey.split(":").at(-1) ?? resourceKey,
    packageKind: "manager",
    packageKey: "manager.researcher",
    version: "1.0.0"
  };
}
