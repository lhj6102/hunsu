import { replayDomainEvents } from "@hunsu/core";
import type { ProjectStateCodec, StoreResult } from "@hunsu/github-store";
import {
  PROJECT_EVENT_SCHEMA,
  decodeDomainEvent,
  type DomainEvent,
  type ProjectState
} from "@hunsu/protocol";

export const projectStateCodec: ProjectStateCodec<DomainEvent, ProjectState> = {
  projectId(state) {
    if (state.projects.length !== 1) throw new Error("A repository Project stream must reconstruct exactly one Project.");
    return state.projects[0].id;
  },
  decodeEvent(input) {
    const decoded = decodeDomainEvent(JSON.stringify({ schema: PROJECT_EVENT_SCHEMA, event: input }));
    return decoded.ok
      ? storeOk(decoded.value)
      : storeFailure(`GitHub contains an invalid Project event: ${decoded.error.message}`);
  },
  replay(events) {
    const replayed = replayDomainEvents(events);
    if (!replayed.ok) return storeFailure(`GitHub Project event replay failed: ${replayed.error.message}`);
    if (replayed.value.projects.length !== 1) return storeFailure("A Project event stream must reconstruct exactly one Project.");
    return storeOk(replayed.value);
  },
  materialize(state) {
    const project = state.projects[0];
    return {
      "project.json": project,
      "coach.json": state.coaches.find(coach => coach.projectId === project.id),
      ...Object.fromEntries(state.goals.map(goal => [`goals/${goal.id}.json`, goal])),
      ...Object.fromEntries(state.runners.map(runner => [`runners/${runner.id}.json`, runner])),
      "snapshots/latest.json": {
        schema: "hunsu.project-snapshot.v1",
        projectId: project.id,
        state
      }
    };
  }
};

function storeOk<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function storeFailure(message: string): StoreResult<never> {
  return { ok: false, error: { code: "invalid_event", message } };
}
