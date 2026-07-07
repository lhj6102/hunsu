import { DomainInvariantError, unwrapDomainModelResult } from "./errors.ts";
import type {
  BoardProjection,
  Destination,
  DestinationId,
  TeamName,
  HunsuId,
  LineId,
  LineRecord,
  MoveRecord,
  NodeId,
  NodeRecord,
  RequestId,
  SkillDraftRecord
} from "./model.ts";
import {
  makeLineId,
  makeTeamName,
  makeNodeId,
} from "./primitives.ts";

export const TEAM_NAME_POOL = [
  "T1",
  "Gen.G",
  "Hanwha Life Esports",
  "KT Rolster",
  "Dplus KIA",
  "DRX",
  "Nongshim RedForce",
  "BNK FearX",
  "DN Freecs",
  "OKSavingsBank BRION",
  "Bilibili Gaming",
  "JD Gaming",
  "Top Esports",
  "Anyone's Legend",
  "Ninjas in Pyjamas",
  "Weibo Gaming",
  "Invictus Gaming",
  "Team WE",
  "LNG Esports",
  "TT Gaming",
  "LGD Gaming",
  "EDward Gaming",
  "Ultra Prime",
  "Oh My God",
  "Cloud9",
  "Team Liquid",
  "FlyQuest",
  "Shopify Rebellion",
  "100 Thieves",
  "Dignitas",
  "LYON",
  "Sentinels",
  "G2 Esports",
  "Fnatic",
  "Karmine Corp",
  "Team Vitality",
  "Team Heretics",
  "GIANTX",
  "Movistar KOI",
  "SK Gaming",
  "Natus Vincere",
  "Rogue"
];

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  if (items.some(existing => existing.id === item.id)) {
    return items.map(existing => (existing.id === item.id ? item : existing));
  }
  return [...items, item];
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function requestIdForLine(state: BoardProjection, lineId: LineId): RequestId {
  return requireLine(state, lineId).requestId;
}

export function rootNodeId(requestId: RequestId): NodeId {
  return unwrapDomainModelResult(makeNodeId(`${requestId}:root`));
}

export function nextNodeId(state: BoardProjection): NodeId {
  const highest = state.nodes.reduce((max, node) => {
    const match = node.id.match(/^N(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return unwrapDomainModelResult(makeNodeId(`N${String(highest + 1).padStart(4, "0")}`));
}

export function nextTeamName(state: BoardProjection): TeamName {
  const used = new Set<string>(state.lines.map(line => line.teamName).filter((name): name is TeamName => Boolean(name)));
  const available = TEAM_NAME_POOL.find(name => !used.has(name));
  if (available) {
    return unwrapDomainModelResult(makeTeamName(available));
  }
  return unwrapDomainModelResult(makeTeamName(`${TEAM_NAME_POOL[state.lines.length % TEAM_NAME_POOL.length]}-${state.lines.length + 1}`));
}

export function nextForkLineId(lineId: LineId, hunsuId: HunsuId): LineId {
  return unwrapDomainModelResult(makeLineId(`${lineId}/fork-${hunsuId}`));
}

export function requireRequest(state: BoardProjection, requestId: string): void {
  if (!state.requests.some(request => request.id === requestId)) {
    throw new DomainInvariantError(`Unknown request: ${requestId}`);
  }
}

export function requireLine(state: BoardProjection, lineId: string): LineRecord {
  const line = state.lines.find(candidate => candidate.id === lineId);
  if (!line) {
    throw new DomainInvariantError(`Unknown line: ${lineId}`);
  }
  return line;
}

export function requirePlayableLine(line: LineRecord): void {
  if (line.status !== "active") {
    throw new DomainInvariantError(`TEAM line ${line.id} cannot continue from status ${line.status}`);
  }
}

export function requireNode(state: BoardProjection, nodeId: NodeId): NodeRecord {
  const node = state.nodes.find(candidate => candidate.id === nodeId);
  if (!node) {
    throw new DomainInvariantError(`Unknown node: ${nodeId}`);
  }
  return node;
}

export function requireRootNode(state: BoardProjection, requestId: RequestId): NodeRecord {
  return requireNode(state, rootNodeId(requestId));
}

export function requireCurrentNode(state: BoardProjection, line: LineRecord): NodeRecord {
  return requireNode(state, line.currentNodeId);
}

export function requireMove(state: BoardProjection, moveId: string): MoveRecord {
  const move = state.moves.find(candidate => candidate.id === moveId);
  if (!move) {
    throw new DomainInvariantError(`Unknown MOVE: ${moveId}`);
  }
  return move;
}

export function requireSkillDraft(state: BoardProjection, draftId: string): SkillDraftRecord {
  const draft = state.skillDrafts.find(candidate => candidate.id === draftId);
  if (!draft) {
    throw new DomainInvariantError(`Unknown Skill Draft: ${draftId}`);
  }
  return draft;
}

export function nodeForMove(state: BoardProjection, move: MoveRecord): NodeRecord | undefined {
  return move.toNodeId ? state.nodes.find(node => node.id === move.toNodeId) : undefined;
}

export function requireExistingDestination(state: BoardProjection, destinationId: DestinationId): Destination {
  const destination = state.destinations.find(candidate => candidate.id === destinationId);
  if (!destination) {
    throw new DomainInvariantError(`Unknown Destination: ${destinationId}`);
  }
  return destination;
}

export function requireDestinationInNode(node: NodeRecord, destinationId: DestinationId): Destination {
  const destination = node.destinations.find(candidate => candidate.id === destinationId);
  if (!destination) {
    throw new DomainInvariantError(`Unknown Destination in node ${node.id}: ${destinationId}`);
  }
  return destination;
}

export function requireClaimableDestination(state: BoardProjection, destinationId: DestinationId): Destination {
  const destination = requireExistingDestination(state, destinationId);
  if (destination.status !== "pending" && destination.status !== "blocked") {
    throw new DomainInvariantError(`Destination ${destinationId} cannot be claimed from status ${destination.status}`);
  }
  return destination;
}

export function requireBlockableDestination(state: BoardProjection, destinationId: DestinationId): Destination {
  const destination = requireExistingDestination(state, destinationId);
  if (isClosedDestination(destination)) {
    throw new DomainInvariantError(`Destination ${destinationId} cannot be blocked from status ${destination.status}`);
  }
  return destination;
}

export function requireBlockableDestinationInNode(node: NodeRecord, destinationId: DestinationId): Destination {
  const destination = requireDestinationInNode(node, destinationId);
  if (isClosedDestination(destination)) {
    throw new DomainInvariantError(`Destination ${destinationId} cannot be blocked from status ${destination.status}`);
  }
  return destination;
}

export function requireBlockedDestinationInNode(node: NodeRecord, destinationId: DestinationId): Destination {
  const destination = requireDestinationInNode(node, destinationId);
  if (destination.status !== "blocked") {
    throw new DomainInvariantError(`Destination ${destinationId} cannot be unblocked from status ${destination.status}`);
  }
  return destination;
}

export function requireReachibleDestinationInNode(node: NodeRecord, destinationId: DestinationId): Destination {
  const destination = requireDestinationInNode(node, destinationId);
  if (isClosedDestination(destination)) {
    throw new DomainInvariantError(`Destination ${destinationId} cannot be reached from status ${destination.status}`);
  }
  return destination;
}

export function isClosedDestination(destination: Destination): boolean {
  return destination.status === "reached" || destination.status === "canceled" || destination.status === "superseded";
}

export function assertNonEmpty<T>(items: T[], message: string): void {
  if (items.length === 0) {
    throw new DomainInvariantError(message);
  }
}

export function assertSingleDestination<T>(items: T[], message: string): void {
  if (items.length !== 1) {
    throw new DomainInvariantError(message);
  }
}

export function assertText(value: string, message: string): void {
  if (value.trim() === "") {
    throw new DomainInvariantError(message);
  }
}
