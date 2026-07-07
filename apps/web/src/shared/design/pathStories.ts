import type { FigmaTeamTone } from "@/shared/design/figmaContracts";

export type PathStoryCardKind = "move" | "accident" | "executing" | "executeButton" | "hunsu";
export type PathDestinationState = "done" | "current" | "waiting" | "failed";

export type PathStoryDestination = {
  label: string;
  state: PathDestinationState;
};

export type PathStoryCard = {
  id: string;
  kind: PathStoryCardKind;
  team: FigmaTeamTone;
  title: string;
  x: number;
  y: number;
  destinations: PathStoryDestination[];
  digesting?: string;
  status?: "arrived" | "accident" | "executing" | "draft";
  autopilot?: boolean;
};

export type PathStoryConnector = {
  id: string;
  fromId: string;
  toId: string;
  team: FigmaTeamTone;
  kind: "path" | "executeCue" | "hunsuFork";
  progress: "done" | "running" | "waiting" | "failed";
};

export type PathStoryTeam = {
  team: FigmaTeamTone;
  state: "ready" | "accident" | "arrived" | "executing";
  autopilot?: boolean;
};

export type PathStory = {
  number: number;
  sourceNodeId: string;
  title: string;
  description: string;
  cards: PathStoryCard[];
  connectors: PathStoryConnector[];
  teams: PathStoryTeam[];
};

const storyCopy = [
  ["MOVE 0 snapshot exists", "Roadmap opens to one URL-addressed workspace with initial Team Snapshot and preview contract ready."],
  ["Execute D0001 is active", "Execute node shows the target MOVE count, live Executing dots, and the current Destination indicator."],
  ["T1 M0001 arrived", "The first recorded MOVE advances the route and carries immutable snapshot plus evidence markers."],
  ["Preview evidence is attached", "The dashboard shows alias-level runtime health and E2E evidence as first-class review data."],
  ["Execute D0002 starts from M0001", "The next Execute starts from the selected MOVE and targets the Payment Destination."],
  ["T1 M0002 is current", "The current route has a valid MOVE but still has one Destination and a preview warning to resolve."],
  ["Execute D0003 tries the last Destination", "The Execute targets the final Result Destination; no recorded outcome exists yet."],
  ["T1 M0003 records Accident", "The route cannot continue from the Accident. Retry requires Hunsu from the parent MOVE."],
  ["Hunsu Manager drafts route change", "The Manager starts from M0002 evidence and prepares a structured HUNSU Draft without mutating the source route."],
  ["HUNSU confirms Gen.G M0002", "Confirmation creates a new Team route at the same MOVE count and preserves the source route."],
  ["Gen.G Execute runs from fork", "The Gen.G Execute starts from the forked Team route and targets the Result Destination."],
  ["Roadmap preserves route outcomes", "Final view compares failed source and successful fork using preview/E2E evidence, without selected-node detail."],
  ["HUNSU draft starts from Gen.G M0003", "The completed Gen.G route becomes the source for a mutable HUNSU Draft that can add Destinations."],
  ["Hanwha Life Esports M0003 adds Destinations", "The HUNSU Draft is confirmed as a Hanwha Life Esports route at M0003 and appends Receipt, Refund, and Audit."],
  ["Hanwha Life Esports D0004 is executing", "Hanwha Life Esports starts the next Execute from M0003 and digests the newly added Receipt Destination."],
  ["Hanwha Life Esports M0004 arrives", "The Execute completes as M0004, marks Receipt as done, and leaves Refund and Audit as the next Destinations."],
  ["Hanwha Life Esports Autopilot starts D0005", "Autopilot is enabled for Hanwha Life Esports, so Refund starts as D0005 without pressing Execute."]
] as const;

export const pathStories: PathStory[] = storyCopy.map(([title, description], index) => buildPathStory(index + 1, title, description));

export function pathStoryByNumber(value: number | undefined): PathStory {
  if (!value) return pathStories[0];
  return pathStories[Math.min(Math.max(value, 1), pathStories.length) - 1];
}

function buildPathStory(number: number, title: string, description: string): PathStory {
  const cards: PathStoryCard[] = [faker0()];
  const connectors: PathStoryConnector[] = [];

  if (number === 1) {
    cards.push(executeButton("execute-faker-d0001", "T1", "Execute", "Console", 224, 302));
    connectors.push(connector("cue-f0-d1", "faker-m0000", "execute-faker-d0001", "T1", "executeCue", "waiting"));
  }

  if (number === 2) {
    cards.push(executing("execute-faker-d0001", "T1", "T1 D0001", "Console", 224, 287));
    connectors.push(connector("cue-f0-d1", "faker-m0000", "execute-faker-d0001", "T1", "executeCue", "running"));
  }

  if (number >= 3) {
    cards.push(faker1());
    connectors.push(connector("f0-f1", "faker-m0000", "faker-m0001", "T1", "path", "done"));
  }

  if (number >= 5 && number < 6) {
    cards.push(executing("execute-faker-d0002", "T1", "T1 D0002", "Payment", 425, 295));
    connectors.push(connector("cue-f1-d2", "faker-m0001", "execute-faker-d0002", "T1", "executeCue", "running"));
  }

  if (number >= 6) {
    cards.push(faker2());
    connectors.push(connector("f1-f2", "faker-m0001", "faker-m0002", "T1", "path", "done"));
  }

  if (number >= 7 && number < 8) {
    cards.push(executing("execute-faker-d0003", "T1", "T1 D0003", "Result", 626, 287));
    connectors.push(connector("cue-f2-d3", "faker-m0002", "execute-faker-d0003", "T1", "executeCue", "running"));
  }

  if (number >= 8) {
    cards.push(accident("faker-m0003", "T1 M0003", 626, 261));
    connectors.push(connector("f2-f3", "faker-m0002", "faker-m0003", "T1", "path", "failed"));
  }

  if (number === 9) {
    cards.push(hunsu("hunsu-ruler-draft", "Gen.G Draft", 828, 302, [
      { label: "Retry Result", state: "current" }
    ]));
    connectors.push(connector("f2-hunsu", "faker-m0002", "hunsu-ruler-draft", "Gen.G", "hunsuFork", "running"));
  }

  if (number >= 10) {
    cards.push(ruler2());
    connectors.push(connector("f2-r2", "faker-m0002", "ruler-m0002", "Gen.G", "hunsuFork", "done"));
  }

  if (number === 11) {
    cards.push(executing("execute-ruler-d0003", "Gen.G", "Gen.G D0003", "Result", 626, 452));
    connectors.push(connector("cue-r2-d3", "ruler-m0002", "execute-ruler-d0003", "Gen.G", "executeCue", "running"));
  }

  if (number >= 12) {
    cards.push(ruler3());
    connectors.push(connector("r2-r3", "ruler-m0002", "ruler-m0003", "Gen.G", "path", "done"));
  }

  if (number === 13) {
    cards.push(hunsu("hunsu-canyon-draft", "Hanwha Life Esports Draft", 828, 470, [
      { label: "Receipt", state: "current" },
      { label: "Refund", state: "waiting" },
      { label: "Audit", state: "waiting" }
    ]));
    connectors.push(connector("r3-hunsu", "ruler-m0003", "hunsu-canyon-draft", "Hanwha Life Esports", "hunsuFork", "running"));
  }

  if (number >= 14) {
    cards.push(canyon3());
    connectors.push(connector("r3-c3", "ruler-m0003", "canyon-m0003", "Hanwha Life Esports", "hunsuFork", "done"));
  }

  if (number === 15) {
    cards.push(executing("execute-canyon-d0004", "Hanwha Life Esports", "Hanwha Life Esports D0004", "Receipt", 828, 620));
    connectors.push(connector("cue-c3-d4", "canyon-m0003", "execute-canyon-d0004", "Hanwha Life Esports", "executeCue", "running"));
  }

  if (number >= 16) {
    cards.push(canyon4());
    connectors.push(connector("c3-c4", "canyon-m0003", "canyon-m0004", "Hanwha Life Esports", "path", "done"));
  }

  if (number >= 17) {
    cards.push(executing("execute-canyon-d0005", "Hanwha Life Esports", "Hanwha Life Esports D0005", "Refund", 1029, 611, true));
    connectors.push(connector("cue-c4-d5", "canyon-m0004", "execute-canyon-d0005", "Hanwha Life Esports", "executeCue", "running"));
  }

  return {
    number,
    sourceNodeId: sourceNodeIdForStory(number),
    title,
    description,
    cards,
    connectors,
    teams: teamsForStory(number)
  };
}

function faker0(): PathStoryCard {
  return move("faker-m0000", "T1", "T1 M0000", 23, 269, [
    { label: "Console", state: "current" },
    { label: "Payment", state: "waiting" }
  ]);
}

function faker1(): PathStoryCard {
  return move("faker-m0001", "T1", "T1 M0001", 224, 261, [
    { label: "Console", state: "done" },
    { label: "Payment", state: "current" },
    { label: "Result", state: "waiting" }
  ]);
}

function faker2(): PathStoryCard {
  return move("faker-m0002", "T1", "T1 M0002", 425, 269, [
    { label: "Console", state: "done" },
    { label: "Payment", state: "done" },
    { label: "Result", state: "current" }
  ]);
}

function ruler2(): PathStoryCard {
  return move("ruler-m0002", "Gen.G", "Gen.G M0002", 425, 426, [
    { label: "Console", state: "waiting" },
    { label: "Payment", state: "waiting" },
    { label: "Result", state: "current" }
  ]);
}

function ruler3(): PathStoryCard {
  return move("ruler-m0003", "Gen.G", "Gen.G M0003", 626, 434, [
    { label: "Payment", state: "waiting" },
    { label: "Result", state: "done" }
  ]);
}

function canyon3(): PathStoryCard {
  return move("canyon-m0003", "Hanwha Life Esports", "Hanwha Life Esports M0003", 626, 594, [
    { label: "Result", state: "done" },
    { label: "Receipt", state: "current" },
    { label: "Refund", state: "waiting" },
    { label: "Audit", state: "waiting" }
  ]);
}

function canyon4(): PathStoryCard {
  return move("canyon-m0004", "Hanwha Life Esports", "Hanwha Life Esports M0004", 828, 602, [
    { label: "Result", state: "done" },
    { label: "Receipt", state: "done" },
    { label: "Refund", state: "current" },
    { label: "Audit", state: "waiting" }
  ]);
}

function move(id: string, team: FigmaTeamTone, title: string, x: number, y: number, destinations: PathStoryDestination[]): PathStoryCard {
  return { id, kind: "move", team, title, x, y, destinations, status: "arrived" };
}

function accident(id: string, title: string, x: number, y: number): PathStoryCard {
  return {
    id,
    kind: "accident",
    team: "T1",
    title,
    x,
    y,
    status: "accident",
    destinations: [
      { label: "Console", state: "done" },
      { label: "Payment", state: "done" },
      { label: "Result", state: "failed" }
    ]
  };
}

function executing(id: string, team: FigmaTeamTone, title: string, digesting: string, x: number, y: number, autopilot = false): PathStoryCard {
  return {
    id,
    kind: "executing",
    team,
    title,
    x,
    y,
    digesting,
    status: "executing",
    autopilot,
    destinations: [{ label: digesting, state: "current" }]
  };
}

function executeButton(id: string, team: FigmaTeamTone, title: string, digesting: string, x: number, y: number): PathStoryCard {
  return {
    id,
    kind: "executeButton",
    team,
    title,
    x,
    y,
    digesting,
    destinations: [{ label: digesting, state: "current" }]
  };
}

function hunsu(id: string, title: string, x: number, y: number, destinations: PathStoryDestination[]): PathStoryCard {
  return { id, kind: "hunsu", team: "G2 Esports", title, x, y, destinations, status: "draft" };
}

function connector(id: string, fromId: string, toId: string, team: FigmaTeamTone, kind: PathStoryConnector["kind"], progress: PathStoryConnector["progress"]): PathStoryConnector {
  return { id, fromId, toId, team, kind, progress };
}

function teamsForStory(number: number): PathStoryTeam[] {
  if (number >= 17) return [
    { team: "T1", state: "accident" },
    { team: "Gen.G", state: "arrived" },
    { team: "Hanwha Life Esports", state: "executing", autopilot: true }
  ];
  if (number >= 14) return [
    { team: "T1", state: "accident" },
    { team: "Gen.G", state: "arrived" },
    { team: "Hanwha Life Esports", state: number >= 15 ? "executing" : "ready" }
  ];
  if (number >= 10) return [
    { team: "T1", state: "accident" },
    { team: "Gen.G", state: number >= 11 && number < 12 ? "executing" : number >= 12 ? "arrived" : "ready" }
  ];
  return [{ team: "T1", state: number >= 8 ? "accident" : number === 2 || number === 5 || number === 7 ? "executing" : "ready" }];
}

function sourceNodeIdForStory(number: number): string {
  const sourceIds = [
    "52:11655",
    "52:11663",
    "52:11671",
    "52:11681",
    "52:11691",
    "52:11701",
    "52:11713",
    "52:11741",
    "52:11758",
    "52:11778",
    "52:11800",
    "52:11822",
    "52:11844",
    "52:11869",
    "52:11896",
    "52:11923",
    "52:11953"
  ];
  return sourceIds[number - 1] ?? sourceIds[0];
}
