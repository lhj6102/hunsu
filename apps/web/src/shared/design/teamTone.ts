import type { FigmaTeamTone } from "@/shared/design/figmaContracts";

export const appleTeamPalette = [
  "var(--team-01)",
  "var(--team-02)",
  "var(--team-03)",
  "var(--team-04)",
  "var(--team-05)",
  "var(--team-06)",
  "var(--team-07)",
  "var(--team-08)",
  "var(--team-09)",
  "var(--team-10)",
  "var(--team-11)",
  "var(--team-12)"
] as const;

export const teamToneMap: Record<FigmaTeamTone, { label: string; color: string; className: string }> = {
  "T1": { label: "T1", color: appleTeamPalette[0], className: "text-[color:var(--team-01)]" },
  "Gen.G": { label: "Gen.G", color: appleTeamPalette[6], className: "text-[color:var(--team-07)]" },
  "Hanwha Life Esports": { label: "Hanwha Life Esports", color: appleTeamPalette[1], className: "text-[color:var(--team-02)]" },
  "G2 Esports": { label: "G2 Esports", color: appleTeamPalette[5], className: "text-[color:var(--team-06)]" }
};

export function teamToneForName(name: string | undefined): FigmaTeamTone {
  const normalized = (name ?? "").toLowerCase();
  if (normalized.includes("gen.g") || normalized.includes("gen g")) return "Gen.G";
  if (normalized.includes("hanwha")) return "Hanwha Life Esports";
  if (normalized.includes("g2")) return "G2 Esports";
  return "T1";
}

export function teamColorForName(name: string | undefined): string {
  const normalized = (name ?? "T1").trim().toLowerCase();
  if (normalized.includes("t1")) return appleTeamPalette[0];
  if (normalized.includes("gen.g") || normalized.includes("gen g")) return appleTeamPalette[6];
  if (normalized.includes("hanwha")) return appleTeamPalette[1];
  if (normalized.includes("g2")) return appleTeamPalette[5];
  let hash = 0;
  for (const char of normalized || "team") {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return appleTeamPalette[hash % appleTeamPalette.length];
}
