import {
  currentProcessEnv,
  resolveApiServerConfig,
  unwrapConfigResult,
  type Env
} from "@hunsu/config";
import { InMemoryEphemeralStateStore } from "./auth/in-memory-ephemeral-store.ts";
import { createHunsuRuntime } from "./runtime-common.ts";
import { createHunsuNodeServer } from "./server.ts";

export function createProductionRuntime(env: Env = currentProcessEnv()) {
  const apiConfig = unwrapConfigResult(resolveApiServerConfig(env));
  const stateStore = new InMemoryEphemeralStateStore();
  const runtime = createHunsuRuntime(env, stateStore);
  const server = createHunsuNodeServer(runtime.app, runtime.githubConfig.publicApiUrl);
  return { apiConfig, stateStore, ...runtime, server };
}
