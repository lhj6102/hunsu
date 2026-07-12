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
    connectTicketSigningKeyId: "connect-Ea21pgXVRp5WfId1kXKSeyea",
    connectTicketSigningPublicJwk: Object.freeze({
      kty: "EC",
      crv: "P-256",
      x: "SekGyUfv_HqJlJ35q9uE4cUzM7jWW6V6B7k4_HGy6ck",
      y: "zY0W0qv5kHQKxF6aynjmy0kGv1XodPwF4MX4yvTW_C8"
    })
  }),
  preview: Object.freeze({
    webUrl: "https://preview.hunsu.app/studio",
    connectApiUrl: "https://connect.preview.hunsu.app",
    connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.preview.hunsu.app",
    connectTicketSigningKeyId: "connect-vd_GiPDTK2lPIDS3Y2dDIEck",
    connectTicketSigningPublicJwk: Object.freeze({
      kty: "EC",
      crv: "P-256",
      x: "DZDAFyOricZ4dOBOhNrNtAS2X_EdqrE2wQxB23raNcc",
      y: "qLXw7DinTp-5T0i_MdU9jN15Wpnxu0dXh-Owo5ydL1U"
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
