export const BRIDGE_DEPLOYMENT_PROFILES = ["production", "preview"] as const;

export type BridgeDeploymentProfile = typeof BRIDGE_DEPLOYMENT_PROFILES[number];

export type BridgeDeploymentEndpoints = Readonly<{
  webUrl: string;
  connectApiUrl: string;
  connectWsUrl: string;
  connectTicketIssuer: string;
  connectTicketSigningKeyId: string;
  connectTicketSigningPublicJwk: Readonly<{
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  }>;
}>;

const PROFILE_ENDPOINTS: Readonly<Record<BridgeDeploymentProfile, BridgeDeploymentEndpoints>> = Object.freeze({
  production: Object.freeze({
    webUrl: "https://hunsu.app/studio",
    connectApiUrl: "https://connect.hunsu.app",
    connectWsUrl: "wss://connect.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.hunsu.app",
    connectTicketSigningKeyId: "connect-enaK6bbNEOky9hUYzzJuN3Qi",
    connectTicketSigningPublicJwk: Object.freeze({
      kty: "EC",
      crv: "P-256",
      x: "LmCMF_gjDJ9HQOmdmk_ylwWFA5r3cwvuMpJ_f6Ud3Cg",
      y: "wjC2rVxMFzICuC-QH3RKXb5ztR968bg2oVc5PJ1A1gM"
    })
  }),
  preview: Object.freeze({
    webUrl: "https://preview.hunsu.app/studio",
    connectApiUrl: "https://connect.preview.hunsu.app",
    connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.preview.hunsu.app",
    connectTicketSigningKeyId: "connect-LPehY8CSnG6Y0rkTzjQB4I77",
    connectTicketSigningPublicJwk: Object.freeze({
      kty: "EC",
      crv: "P-256",
      x: "69FCDW0whttjj1IhJjFMQOOl-icup4Dv4MlpgasZcWw",
      y: "9oGa20XKzFy9LCFn34v3H7ss42sD_9eKhjBbWwwBTa4"
    })
  })
});

export function isBridgeDeploymentProfile(value: unknown): value is BridgeDeploymentProfile {
  return value === "production" || value === "preview";
}

export function bridgeDeploymentEndpoints(profile: BridgeDeploymentProfile): BridgeDeploymentEndpoints {
  return PROFILE_ENDPOINTS[profile];
}

export function bridgeSetupPackageTag(profile: BridgeDeploymentProfile): "next" | "candidate-next" {
  return profile === "preview" ? "candidate-next" : "next";
}
