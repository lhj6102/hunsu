import type {
  CommitSha,
  GitGoal,
  GitHunsuId,
  GitMoveId,
  GitMoveNumber,
  GitPriority,
  GitRef,
  GitRunId,
  GitTrailerActor,
  GitTrailerRole
} from "./primitives.ts";

export type HunsuEventType = "move" | "hunsu";
export type MoveEventStatus = "complete" | "failed" | "blocked";

export type TrailerMap = Map<string, string[]>;

export type CommitRecord = {
  sha: CommitSha;
  shortSha: string;
  parents: string[];
  refs: GitRef[];
  authorName: string;
  authoredAt: string;
  subject: string;
  body: string;
};

export type MoveEvent = {
  type: "move";
  commit: CommitRecord;
  runId: GitRunId;
  moveNumber: GitMoveNumber;
  moveId: GitMoveId;
  goal: GitGoal;
  role: GitTrailerRole;
  actor: GitTrailerActor;
  status: MoveEventStatus;
  trailers: TrailerMap;
};

export type HunsuEvent = {
  type: "hunsu";
  commit: CommitRecord;
  hunsuId: GitHunsuId;
  target: CommitSha;
  sourceRun: GitRunId;
  newRun: GitRunId;
  role: GitTrailerRole;
  actor: GitTrailerActor;
  priority?: GitPriority;
  trailers: TrailerMap;
};

export type BoardEvent = MoveEvent | HunsuEvent;

export type RunTimeline = {
  runId: string;
  moves: MoveEvent[];
  hunsus: HunsuEvent[];
  events: BoardEvent[];
};

export type Board = {
  runs: RunTimeline[];
  moves: MoveEvent[];
  hunsus: HunsuEvent[];
  positions: Map<string, MoveEvent>;
};

export type HunsuConfig = {
  runtime: {
    default_runner: string;
    max_goal_minutes: number;
  };
  git: {
    require_trailers: boolean;
    main_mode: string;
    allow_write_main: boolean;
  };
  members: {
    default: string[];
    verification: string[];
  };
  approval: {
    require_human_for: string[];
  };
};

export const REQUIRED_MOVE_TRAILERS = [
  "Hunsu-Event",
  "Hunsu-Run",
  "Hunsu-Move",
  "Hunsu-Goal",
  "Hunsu-Role",
  "Hunsu-Actor",
  "Hunsu-Status"
];

export const REQUIRED_HUNSU_TRAILERS = [
  "Hunsu-Event",
  "Hunsu-ID",
  "Hunsu-Target",
  "Hunsu-Source-Run",
  "Hunsu-New-Run",
  "Hunsu-Role",
  "Hunsu-Actor"
];
