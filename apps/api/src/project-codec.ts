import { replayDomainEvents, type ProjectIntegrityBoundary } from "@hunsu/core";
import { decodeNodeEnvelope, encodeNodeEnvelope, type ProjectStateCodec, type StoreResult } from "@hunsu/github-store";
import {
  computeNodePayloadDigest,
  decodeNodePayload,
  nodePayloadFor,
  type DomainEvent,
  type ProjectState,
  type RunnerValueTypeRegistry
} from "@hunsu/protocol";
import { decodeOpaqueDomainEvent, encodeOpaqueDomainEvent } from "./opaque-domain-event.ts";
import { buildShardedProjectReadModels } from "./sharded-read-models.ts";
import { bundledRunnerRuntime, type TrustedRunnerRuntime } from "./runner-runtime.ts";

export type ProjectCodecBundle = {
  readonly projectIntegrityBoundary: ProjectIntegrityBoundary;
  readonly projectStateCodec: ProjectStateCodec<DomainEvent, ProjectState>;
};

export function createProjectCodec(runtime: TrustedRunnerRuntime): ProjectCodecBundle {
  const projectIntegrityBoundary: ProjectIntegrityBoundary = {
    verifyNodePayload(expected, envelope) {
      const decompressed = decodeNodeEnvelope(envelope);
      if (!decompressed.ok) return { ok: false, error: { message: decompressed.error.message } };
      const decoded = decodeNodePayload(decompressed.value.value, runtime.runnerTypes);
      if (!decoded.ok) return {
        ok: false,
        error: { message: `Encoded Node payload is invalid at ${decoded.error.path}: ${decoded.error.message}` }
      };
      const expectedDigest = computeNodePayloadDigest(expected);
      if (computeNodePayloadDigest(decoded.value) !== expectedDigest || decompressed.value.digest !== expectedDigest) {
        return { ok: false, error: { message: "Encoded Node payload does not match its registration event Node." } };
      }
      return { ok: true, value: true };
    }
  };

  const projectStateCodec: ProjectStateCodec<DomainEvent, ProjectState> = {
    projectId(state) {
      if (state.projects.length !== 1) throw new Error("A repository Project stream must reconstruct exactly one Project.");
      return state.projects[0]!.id;
    },
    nodeAnchors(state) {
      return state.nodes.map(node => ({
        projectId: String(node.projectId),
        nodeSha: String(node.commitSha),
        treeSha: String(node.treeSha),
        managedRef: String(node.managedRef),
        commitTitle: String(node.commitTitle)
      }));
    },
    encodeEvent(event) {
      return encodeOpaqueDomainEvent(event);
    },
    decodeEvent(input) {
      const decoded = decodeOpaqueDomainEvent(input, runtime.runnerTypes);
      if (!decoded.ok) return decoded;
      const payload = validateRegistrationPayload(decoded.value, projectIntegrityBoundary);
      return payload.ok ? storeOk(decoded.value) : payload;
    },
    replay(events) {
      const replayed = replayDomainEvents(events, projectIntegrityBoundary);
      if (!replayed.ok) return storeFailure(`GitHub Project event replay failed: ${replayed.error.message}`);
      if (replayed.value.projects.length !== 1) return storeFailure("A Project event stream must reconstruct exactly one Project.");
      return storeOk(replayed.value);
    },
    materialize(state, events) {
      const project = state.projects[0];
      if (!project) return storeFailure("A Project materialization requires exactly one Project.");
      const encodedNodes: Record<string, unknown> = {};
      for (const node of state.nodes) {
        const envelope = encodeNodeEnvelope(nodePayloadFor(node));
        if (!envelope.ok) return envelope;
        encodedNodes[`nodes/${node.commitSha}/node.hunsu`] = envelope.value;
      }
      const readModels = buildShardedProjectReadModels(state, events);
      if (!readModels.ok) return readModels;
      return storeOk({ ...encodedNodes, ...readModels.value });
    }
  };

  return { projectIntegrityBoundary, projectStateCodec };
}

export const bundledRunnerTypes: RunnerValueTypeRegistry = bundledRunnerRuntime.runnerTypes;
const bundledProjectCodec = createProjectCodec(bundledRunnerRuntime);
export const projectIntegrityBoundary = bundledProjectCodec.projectIntegrityBoundary;
export const projectStateCodec = bundledProjectCodec.projectStateCodec;

function validateRegistrationPayload(event: DomainEvent, integrityBoundary: ProjectIntegrityBoundary): StoreResult<void> {
  if (event.type !== "RootNodeRegistered"
    && event.type !== "RunChildNodeRegistered"
    && event.type !== "CoachingChildNodeRegistered"
  ) return storeOk(undefined);
  const verified = integrityBoundary.verifyNodePayload(nodePayloadFor(event.node), event.payload);
  return verified.ok ? storeOk(undefined) : storeFailure(verified.error.message);
}

function storeOk<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function storeFailure(message: string): StoreResult<never> {
  return { ok: false, error: { code: "invalid_event", message } };
}
