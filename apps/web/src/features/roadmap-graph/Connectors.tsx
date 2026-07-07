import { figmaComponentNames } from "@/shared/design/figmaContracts";

export function ExecuteCueConnector() {
  return (
    <svg data-figma-component={figmaComponentNames.executeCueConnector} width="128" height="28" viewBox="0 0 128 28" aria-hidden="true">
      <path d="M4 14H112" fill="none" stroke="var(--team-color)" strokeWidth="2" strokeDasharray="6 6" strokeLinecap="round" />
      <path d="M112 7L124 14L112 21" fill="none" stroke="var(--team-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HunsuForkConnector() {
  return (
    <svg data-figma-component={figmaComponentNames.hunsuForkConnector} width="128" height="42" viewBox="0 0 128 42" aria-hidden="true">
      <path d="M4 10H48C66 10 66 32 84 32H112" fill="none" stroke="var(--studio-galio)" strokeWidth="2" strokeDasharray="5 5" strokeLinecap="round" />
      <path d="M112 25L124 32L112 39" fill="none" stroke="var(--studio-galio)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
