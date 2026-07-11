export type BridgePackSmokeResult = {
  packageName: string;
  version: string;
  nodeEngine: string;
  tarballBytes: number;
  files: string[];
  endpoint: string;
  durationMs: number;
};

export function runBridgePackSmoke(options?: {
  outputDirectory?: string;
}): Promise<BridgePackSmokeResult>;
