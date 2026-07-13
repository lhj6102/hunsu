import { createProductionRuntime } from "./runtime.ts";

const runtime = createProductionRuntime();
runtime.server.listen(runtime.apiConfig.api.port, runtime.apiConfig.api.host, () => {
  const address = runtime.server.address();
  const port = typeof address === "object" && address ? address.port : runtime.apiConfig.api.port;
  process.stdout.write(`Hunsu API listening on ${runtime.apiConfig.api.host}:${port}\n`);
});
