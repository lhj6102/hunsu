export type Env = Readonly<Record<string, string | undefined>>;

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HunsuConfigError };

export type HunsuConfigError = {
  code:
    | "invalid_host"
    | "invalid_integer"
    | "invalid_port"
    | "invalid_private_key"
    | "invalid_secret"
    | "invalid_url"
    | "invalid_value"
    | "missing_required_env"
    | "port_conflict";
  message: string;
  env?: string;
  portName?: HunsuPortName;
  port?: number;
  value?: string;
};

export type HunsuPortName = "api" | "web";

export type HunsuEndpoint = {
  name: HunsuPortName;
  host: string;
  port: number;
};

export type ApiServerConfig = {
  api: HunsuEndpoint;
};

export type WebServerConfig = {
  web: HunsuEndpoint;
  api: HunsuEndpoint;
  strictPort: boolean;
  apiProxyTarget: string;
  browserApiUrl?: string;
};

export type GitHubAppConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  appSlug: string;
  publicApiUrl: string;
  webUrl: string;
};

export type SessionConfig = {
  secret: string;
  ttlSeconds: number;
  cookieName: "hunsu_session";
  secure: boolean;
};

type PortSpec = {
  name: HunsuPortName;
  defaultHost: string;
  hostEnv: "HUNSU_API_HOST" | "HUNSU_WEB_HOST";
  defaultPort: number;
  portEnv: "HUNSU_API_PORT" | "HUNSU_WEB_PORT";
  allowPortZero: boolean;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const HUNSU_PORT_SPECS: Readonly<Record<HunsuPortName, PortSpec>> = {
  api: {
    name: "api",
    defaultHost: DEFAULT_HOST,
    hostEnv: "HUNSU_API_HOST",
    defaultPort: 19687,
    portEnv: "HUNSU_API_PORT",
    allowPortZero: true
  },
  web: {
    name: "web",
    defaultHost: DEFAULT_HOST,
    hostEnv: "HUNSU_WEB_HOST",
    defaultPort: 19688,
    portEnv: "HUNSU_WEB_PORT",
    allowPortZero: false
  }
};

export function resolveApiServerConfig(env: Env): ConfigResult<ApiServerConfig> {
  const api = resolveEndpoint(HUNSU_PORT_SPECS.api, env);
  return api.ok ? ok({ api: api.value }) : api;
}

export function resolveWebServerConfig(env: Env): ConfigResult<WebServerConfig> {
  const api = resolveEndpoint(HUNSU_PORT_SPECS.api, env);
  if (!api.ok) {
    return api;
  }

  const web = resolveEndpoint(HUNSU_PORT_SPECS.web, env);
  if (!web.ok) {
    return web;
  }

  if (
    api.value.port !== 0
    && api.value.port === web.value.port
    && hostsMayConflict(api.value.host, web.value.host)
  ) {
    return err({
      code: "port_conflict",
      message: "Hunsu port conflict: api and web resolve to the same listening address.",
      port: api.value.port
    });
  }

  const browserApiUrl = readOptionalUrl(env, "VITE_HUNSU_API_URL");
  if (!browserApiUrl.ok) {
    return browserApiUrl;
  }

  const apiProxyTarget = readUrl(
    env,
    "HUNSU_API_PROXY_TARGET",
    browserApiUrl.value ?? endpointUrl(api.value)
  );
  if (!apiProxyTarget.ok) {
    return apiProxyTarget;
  }

  return ok({
    web: web.value,
    api: api.value,
    strictPort: true,
    apiProxyTarget: apiProxyTarget.value,
    ...(browserApiUrl.value === undefined ? {} : { browserApiUrl: browserApiUrl.value })
  });
}

export function resolveGitHubAppConfig(env: Env): ConfigResult<GitHubAppConfig> {
  const appId = readPositiveInteger(env, "HUNSU_GITHUB_APP_ID");
  if (!appId.ok) {
    return appId;
  }

  const clientId = readRequiredString(env, "HUNSU_GITHUB_CLIENT_ID");
  if (!clientId.ok) {
    return clientId;
  }

  const clientSecret = readRequiredString(env, "HUNSU_GITHUB_CLIENT_SECRET");
  if (!clientSecret.ok) {
    return clientSecret;
  }

  const privateKey = readGitHubPrivateKey(env);
  if (!privateKey.ok) {
    return privateKey;
  }

  const webhookSecret = readRequiredString(env, "HUNSU_GITHUB_WEBHOOK_SECRET");
  if (!webhookSecret.ok) {
    return webhookSecret;
  }

  const appSlug = readGitHubAppSlug(env);
  if (!appSlug.ok) {
    return appSlug;
  }

  const publicApiUrl = resolvePublicApiUrl(env);
  if (!publicApiUrl.ok) {
    return publicApiUrl;
  }

  const webUrl = resolvePublicWebUrl(env);
  if (!webUrl.ok) {
    return webUrl;
  }

  return ok({
    appId: appId.value,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    privateKey: privateKey.value,
    webhookSecret: webhookSecret.value,
    appSlug: appSlug.value,
    publicApiUrl: publicApiUrl.value,
    webUrl: webUrl.value
  });
}

export function resolveSessionConfig(env: Env): ConfigResult<SessionConfig> {
  const secret = readRequiredString(env, "HUNSU_SESSION_SECRET");
  if (!secret.ok) {
    return secret;
  }
  if (secret.value.length < 32) {
    return err({
      code: "invalid_secret",
      env: "HUNSU_SESSION_SECRET",
      message: "Invalid HUNSU_SESSION_SECRET: expected at least 32 characters."
    });
  }

  const ttlSeconds = readPositiveInteger(
    env,
    "HUNSU_SESSION_TTL_SECONDS",
    DEFAULT_SESSION_TTL_SECONDS
  );
  if (!ttlSeconds.ok) {
    return ttlSeconds;
  }

  const publicApiUrl = resolvePublicApiUrl(env);
  if (!publicApiUrl.ok) {
    return publicApiUrl;
  }

  return ok({
    secret: secret.value,
    ttlSeconds: ttlSeconds.value,
    cookieName: "hunsu_session",
    secure: new URL(publicApiUrl.value).protocol === "https:"
  });
}

export function currentProcessEnv(): Env {
  return process.env;
}

export function unwrapConfigResult<T>(result: ConfigResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  const error = new Error(result.error.message);
  error.name = "HunsuConfigError";
  throw error;
}

export function endpointUrl(endpoint: Pick<HunsuEndpoint, "host" | "port">): string {
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[")
    ? "[" + endpoint.host + "]"
    : endpoint.host;
  return "http://" + host + ":" + endpoint.port;
}

function resolveEndpoint(spec: PortSpec, env: Env): ConfigResult<HunsuEndpoint> {
  const host = readHost(env, spec.hostEnv, spec.defaultHost);
  if (!host.ok) {
    return host;
  }

  const port = readPort(env, spec);
  if (!port.ok) {
    return port;
  }

  return ok({
    name: spec.name,
    host: host.value,
    port: port.value
  });
}

function readHost(env: Env, envName: string, fallback: string): ConfigResult<string> {
  const raw = env[envName];
  const host = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  const normalizedHost = stripIpv6Brackets(host);
  const colonCount = normalizedHost.split(":").length - 1;
  if (
    host.length === 0
    || /\s/u.test(host)
    || host.includes("/")
    || host.includes("?")
    || host.includes("#")
    || host.includes("@")
    || (host.startsWith("[") !== host.endsWith("]"))
    || (host.startsWith("[") && !normalizedHost.includes(":"))
    || (
      normalizedHost.includes(":")
      && (colonCount < 2 || !/^[0-9a-f:.]+$/iu.test(normalizedHost))
    )
  ) {
    return err({
      code: "invalid_host",
      env: envName,
      value: host,
      message: "Invalid " + envName + ": expected a hostname or IP address without a scheme or path."
    });
  }
  return ok(normalizedHost);
}

function readPort(env: Env, spec: PortSpec): ConfigResult<number> {
  const raw = env[spec.portEnv];
  if (raw === undefined || raw.trim() === "") {
    return ok(spec.defaultPort);
  }

  const value = raw.trim();
  const port = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  const minimum = spec.allowPortZero ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65535) {
    return err({
      code: "invalid_port",
      env: spec.portEnv,
      portName: spec.name,
      value,
      message:
        "Invalid "
        + spec.portEnv
        + ": expected an integer port from "
        + minimum
        + " to 65535."
    });
  }
  return ok(port);
}

function readPositiveInteger(
  env: Env,
  envName: string,
  fallback?: number
): ConfigResult<number> {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return fallback === undefined
      ? err({
          code: "missing_required_env",
          env: envName,
          message: "Missing required environment variable " + envName + "."
        })
      : ok(fallback);
  }

  const value = raw.trim();
  const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return err({
      code: "invalid_integer",
      env: envName,
      value,
      message: "Invalid " + envName + ": expected a positive integer."
    });
  }
  return ok(parsed);
}

function readRequiredString(env: Env, envName: string): ConfigResult<string> {
  const value = env[envName]?.trim();
  if (value === undefined || value === "") {
    return err({
      code: "missing_required_env",
      env: envName,
      message: "Missing required environment variable " + envName + "."
    });
  }
  return ok(value);
}

function readGitHubPrivateKey(env: Env): ConfigResult<string> {
  const raw = env.HUNSU_GITHUB_PRIVATE_KEY;
  if (raw === undefined || raw.trim() === "") {
    return err({
      code: "missing_required_env",
      env: "HUNSU_GITHUB_PRIVATE_KEY",
      message: "Missing required environment variable HUNSU_GITHUB_PRIVATE_KEY."
    });
  }

  const privateKey = raw
    .trim()
    .replace(/\\r\\n/gu, "\n")
    .replace(/\\n/gu, "\n")
    .replace(/\r\n?/gu, "\n");
  if (!/^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\n[\s\S]+\n-----END \1-----$/u.test(privateKey)) {
    return err({
      code: "invalid_private_key",
      env: "HUNSU_GITHUB_PRIVATE_KEY",
      message: "Invalid HUNSU_GITHUB_PRIVATE_KEY: expected a PEM encoded private key."
    });
  }
  return ok(privateKey);
}

function readGitHubAppSlug(env: Env): ConfigResult<string> {
  const appSlug = readRequiredString(env, "HUNSU_GITHUB_APP_SLUG");
  if (!appSlug.ok) {
    return appSlug;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(appSlug.value)) {
    return err({
      code: "invalid_value",
      env: "HUNSU_GITHUB_APP_SLUG",
      value: appSlug.value,
      message: "Invalid HUNSU_GITHUB_APP_SLUG: expected a lower-case GitHub App slug."
    });
  }
  return appSlug;
}

function resolvePublicApiUrl(env: Env): ConfigResult<string> {
  const api = resolveEndpoint(HUNSU_PORT_SPECS.api, env);
  if (!api.ok) {
    return api;
  }
  return readUrl(env, "HUNSU_PUBLIC_API_URL", endpointUrl(api.value));
}

function resolvePublicWebUrl(env: Env): ConfigResult<string> {
  const web = resolveEndpoint(HUNSU_PORT_SPECS.web, env);
  if (!web.ok) {
    return web;
  }
  return readUrl(env, "HUNSU_WEB_URL", endpointUrl(web.value));
}

function readOptionalUrl(env: Env, envName: string): ConfigResult<string | undefined> {
  const raw = env[envName];
  return raw === undefined || raw.trim() === ""
    ? ok(undefined)
    : validateUrl(raw, envName);
}

function readUrl(env: Env, envName: string, fallback: string): ConfigResult<string> {
  const raw = env[envName];
  return validateUrl(raw === undefined || raw.trim() === "" ? fallback : raw, envName);
}

function validateUrl(raw: string, envName: string): ConfigResult<string> {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw new Error("unsupported URL");
    }
    return ok(url.toString().replace(/\/$/u, ""));
  } catch {
    return err({
      code: "invalid_url",
      env: envName,
      message:
        "Invalid "
        + envName
        + ": expected a credential-free HTTP(S) URL without a query or fragment."
    });
  }
}

function hostsMayConflict(left: string, right: string): boolean {
  const normalizedLeft = normalizeHost(left);
  const normalizedRight = normalizeHost(right);
  return (
    normalizedLeft === normalizedRight
    || isWildcardHost(normalizedLeft)
    || isWildcardHost(normalizedRight)
  );
}

function normalizeHost(host: string): string {
  const normalized = stripIpv6Brackets(host).toLowerCase();
  return normalized === "localhost" ? DEFAULT_HOST : normalized;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function ok<T>(value: T): ConfigResult<T> {
  return { ok: true, value };
}

function err(error: HunsuConfigError): ConfigResult<never> {
  return { ok: false, error };
}
