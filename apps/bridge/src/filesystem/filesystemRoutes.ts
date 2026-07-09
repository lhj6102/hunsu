import type { IncomingMessage, ServerResponse } from "node:http";

type FilesystemRouteContext = {
  cwd: string;
  browseRootEntries: (cwd: string) => unknown[];
  browse: (path: string | undefined, options: { cwd: string; rootId?: string }) => unknown;
  createGrant: (body: unknown, options: { cwd: string }) => unknown;
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleFilesystemRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  url: URL,
  context: FilesystemRouteContext
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/filesystem/roots") {
    context.sendJson(response, 200, { roots: context.browseRootEntries(context.cwd) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/filesystem/browse") {
    context.sendJson(response, 200, context.browse(url.searchParams.get("path") ?? undefined, {
      cwd: context.cwd,
      rootId: url.searchParams.get("rootId") ?? undefined
    }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/filesystem/grants") {
    context.sendJson(response, 201, context.createGrant(await context.readJson(request), { cwd: context.cwd }));
    return true;
  }

  return false;
}
