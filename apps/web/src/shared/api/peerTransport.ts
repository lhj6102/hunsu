import type {
  RemoteCommandName,
  RemoteControlMessage,
  RemotePeerServerHello,
  RemotePeerSignal,
  RemoteStreamMessage,
  RemoteWorkspaceMetadata,
  RemoteWorkspaceScope
} from "@hunsu/protocol";
import {
  REMOTE_PEER_MAX_ACTIVE_STREAMS,
  REMOTE_PEER_MAX_FRAME_BYTES,
  REMOTE_PEER_PROTOCOL_VERSION,
  REMOTE_PEER_STUN_URL,
  decodeRemotePeerSignal,
  isRemoteCommandName,
  isRemoteWorkspaceScope,
  requiredScopesForRemoteCommand
} from "@hunsu/protocol";
import type { ConnectDevice, ConnectSignalingChannel, ConnectSignalingFactory } from "@/shared/api/connectClient";
import { openConnectSignalingChannel } from "@/shared/api/connectClient";
import {
  HUNSU_CONTROL_CHANNEL,
  HUNSU_STREAM_CHANNEL,
  PeerCryptoContext,
  PeerSecurityError,
  base64UrlDecode,
  base64UrlEncode,
  completeBrowserPeerHandshake,
  createBrowserAgreementKey,
  createBrowserSignalCryptoContext
} from "@/shared/api/peerCrypto";

export const HUNSU_STUN_URL = REMOTE_PEER_STUN_URL;
export const HUNSU_PEER_RTC_CONFIGURATION: RTCConfiguration = Object.freeze({
  iceServers: [{ urls: HUNSU_STUN_URL }],
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
});

export const PEER_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
export const PEER_BUFFER_LOW_WATER_BYTES = 128 * 1024;
export const DEFAULT_PEER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PEER_CONNECT_TIMEOUT_MS = 20_000;
const MAX_PENDING_REQUESTS = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{12,128}$/u;

export type PeerWorkspaceScope = RemoteWorkspaceScope;
export type PeerWorkspaceGrant = RemoteWorkspaceMetadata;

export type PeerCommandDescriptor = {
  name: string;
  payload?: unknown;
};

export type PeerDataChannelAdapter = {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string): void;
  close(): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: () => void): () => void;
  onBufferedAmountLow(listener: () => void): () => void;
};

export type PeerConnectionAdapter = {
  readonly connectionState: RTCPeerConnectionState;
  createDataChannel(label: string, options: RTCDataChannelInit): PeerDataChannelAdapter;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
  onIceCandidate(listener: (candidate: RTCIceCandidateInit | null) => void): () => void;
  onStateChange(listener: () => void): () => void;
};

export type PeerConnectionFactory = (configuration: RTCConfiguration) => PeerConnectionAdapter;

type PendingRequest = {
  workspaceId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number;
  removeAbort?: () => void;
};

type PendingStream = {
  workspaceId: string;
  streamId?: string;
  sequence: number;
  cancelled: boolean;
  onEvent(value: unknown, event: string): void;
  onError(): void;
  timer: number;
};

export class RemotePeerTransport {
  readonly device: ConnectDevice;
  readonly sessionId: string;
  private readonly peer: PeerConnectionAdapter;
  private readonly control: PeerDataChannelAdapter;
  private readonly stream: PeerDataChannelAdapter;
  private readonly cryptoContext: PeerCryptoContext;
  private readonly now: () => number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private readonly streamRequests = new Map<string, string>();
  private readonly sendQueues: Record<"control" | "stream", Promise<void>> = { control: Promise.resolve(), stream: Promise.resolve() };
  private readonly receiveQueues: Record<"control" | "stream", Promise<void>> = { control: Promise.resolve(), stream: Promise.resolve() };
  private workspaces: PeerWorkspaceGrant[] = [];
  private closed = false;
  private ready = false;
  private closeReason = "Remote Bridge peer is not ready.";
  private leaseTimer: number | undefined;
  private workspaceReadyResolve?: (workspaces: PeerWorkspaceGrant[]) => void;
  private workspaceReadyReject?: (error: Error) => void;
  private readonly workspaceReady: Promise<PeerWorkspaceGrant[]>;

  constructor(
    device: ConnectDevice,
    sessionId: string,
    peer: PeerConnectionAdapter,
    control: PeerDataChannelAdapter,
    stream: PeerDataChannelAdapter,
    cryptoContext: PeerCryptoContext,
    now: () => number = Date.now
  ) {
    this.device = device;
    this.sessionId = sessionId;
    this.peer = peer;
    this.control = control;
    this.stream = stream;
    this.cryptoContext = cryptoContext;
    this.now = now;
    this.workspaceReady = new Promise((resolve, reject) => {
      this.workspaceReadyResolve = resolve;
      this.workspaceReadyReject = reject;
    });
    this.bindDataChannel("control", control);
    this.bindDataChannel("stream", stream);
    const leaseDelay = Math.max(0, cryptoContext.leaseExpiresAtMs - now());
    this.leaseTimer = window.setTimeout(() => this.failClosed("Remote Bridge peer lease expired."), leaseDelay);
    peer.onStateChange(() => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed" || peer.connectionState === "disconnected") {
        this.failClosed("Remote Bridge peer connection was lost.");
      }
    });
  }

  get isOpen(): boolean {
    return this.ready
      && !this.closed
      && this.control.readyState === "open"
      && this.stream.readyState === "open"
      && this.now() < this.cryptoContext.leaseExpiresAtMs;
  }

  grantedWorkspaces(): PeerWorkspaceGrant[] {
    return this.workspaces.map(workspace => ({ ...workspace, scopes: [...workspace.scopes] }));
  }

  async confirm(): Promise<void> {
    await this.sendControl({ type: "session.confirm", sessionId: this.sessionId, transcriptHash: this.cryptoContext.transcriptHash });
  }

  async waitForWorkspaceSnapshot(timeoutMs = DEFAULT_PEER_CONNECT_TIMEOUT_MS): Promise<PeerWorkspaceGrant[]> {
    return withTimeout(this.workspaceReady, timeoutMs, "Bridge did not publish its granted Workspace list.");
  }

  async request<T>(workspaceId: string, command: PeerCommandDescriptor, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const name = this.assertCommandAuthority(workspaceId, command.name);
    if (this.pendingRequests.size + this.pendingStreams.size >= MAX_PENDING_REQUESTS) throw new Error("Remote Bridge peer request limit is reached.");
    const requestId = randomId();
    const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_PEER_REQUEST_TIMEOUT_MS, this.cryptoContext.leaseExpiresAtMs - this.now());
    const result = new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.rejectPendingRequest(requestId, new Error("Remote command deadline expired."));
      }, timeoutMs);
      const pending: PendingRequest = { workspaceId, resolve: value => resolve(value as T), reject, timer };
      if (options.signal) {
        const handleAbort = () => this.rejectPendingRequest(requestId, abortError());
        options.signal.addEventListener("abort", handleAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", handleAbort);
      }
      this.pendingRequests.set(requestId, pending);
    });
    try {
      await this.sendCommandRequest(requestId, workspaceId, timeoutMs, name, command.payload);
    } catch (error) {
      this.rejectPendingRequest(requestId, error instanceof Error ? error : new Error("Remote command could not be sent."));
    }
    return result;
  }

  subscribe(
    workspaceId: string,
    command: PeerCommandDescriptor,
    onEvent: (value: unknown, event: string) => void,
    onError: () => void,
    timeoutMs = 10 * 60 * 1_000
  ): () => void {
    let name: RemoteCommandName;
    try {
      name = this.assertCommandAuthority(workspaceId, command.name);
      if (this.pendingStreams.size >= REMOTE_PEER_MAX_ACTIVE_STREAMS || this.pendingRequests.size + this.pendingStreams.size >= MAX_PENDING_REQUESTS) {
        throw new Error("Remote Bridge stream limit is reached.");
      }
    } catch {
      queueMicrotask(onError);
      return () => undefined;
    }
    const requestId = randomId();
    const bounded = boundedTimeout(timeoutMs, this.cryptoContext.leaseExpiresAtMs - this.now());
    const timer = window.setTimeout(() => this.cancelStream(requestId, "deadline"), bounded);
    this.pendingStreams.set(requestId, { workspaceId, sequence: 0, cancelled: false, onEvent, onError, timer });
    void this.sendCommandRequest(requestId, workspaceId, bounded, name, command.payload).catch(() => this.failStream(requestId));
    return () => this.cancelStream(requestId, "cancelled");
  }

  close(reason = "Remote Bridge peer closed by Studio."): void {
    if (!this.closed && this.ready) {
      void this.sendControl({ type: "session.close", sessionId: this.sessionId, reason: "canceled" }).catch(() => undefined);
    }
    this.failClosed(reason);
  }

  private assertCommandAuthority(workspaceId: string, commandName: string): RemoteCommandName {
    if (!this.isOpen) throw new Error(this.closeReason);
    if (!isRemoteCommandName(commandName)) throw new Error("Remote Bridge command is not supported.");
    const workspace = this.workspaces.find(candidate => candidate.workspaceId === workspaceId);
    if (!workspace) throw new Error("Bridge did not grant this Workspace to the peer session.");
    const missing = requiredScopesForRemoteCommand(commandName).find(scope => !workspace.scopes.includes(scope));
    if (missing) throw new Error(`Bridge Workspace grant does not include ${missing}.`);
    return commandName;
  }

  private async sendCommandRequest(requestId: string, workspaceId: string, timeoutMs: number, command: RemoteCommandName, payload: unknown): Promise<void> {
    await this.sendControl({
      type: "command.request",
      sessionId: this.sessionId,
      requestId,
      workspaceId,
      deadline: new Date(this.now() + timeoutMs).toISOString(),
      command,
      ...(payload === undefined ? {} : { payload: sanitizePeerValue(payload) })
    } satisfies RemoteControlMessage);
  }

  private bindDataChannel(channelName: "control" | "stream", channel: PeerDataChannelAdapter): void {
    channel.bufferedAmountLowThreshold = PEER_BUFFER_LOW_WATER_BYTES;
    channel.onMessage(data => {
      this.receiveQueues[channelName] = this.receiveQueues[channelName]
        .then(() => this.consumeEncryptedMessage(channelName, data))
        .catch(error => this.failClosed(error instanceof Error ? error.message : "Remote Bridge peer frame failed."));
    });
    channel.onClose(() => this.failClosed(`${channel.label} closed.`));
  }

  private async consumeEncryptedMessage(channel: "control" | "stream", encoded: string): Promise<void> {
    const message = await this.cryptoContext.decryptJson<unknown>(encoded, channel);
    if (channel === "control") this.handleControlMessage(message);
    else this.handleStreamMessage(message);
  }

  private handleControlMessage(value: unknown): void {
    const message = parseControlMessage(value, this.sessionId);
    if (message.type === "session.ready") {
      if (this.ready
        || message.deviceId !== this.device.deviceId
        || message.transcriptHash !== this.cryptoContext.transcriptHash
        || message.leaseExpiresAt !== new Date(this.cryptoContext.leaseExpiresAtMs).toISOString()) {
        throw new PeerSecurityError("INVALID_HANDSHAKE", "Bridge session readiness binding is invalid.");
      }
      this.workspaces = message.workspaces;
      this.ready = true;
      this.closeReason = "Remote Bridge peer is closed.";
      this.workspaceReadyResolve?.(this.grantedWorkspaces());
      this.workspaceReadyResolve = undefined;
      this.workspaceReadyReject = undefined;
      return;
    }
    if (message.type === "session.close") {
      this.failClosed(`Bridge closed the peer session: ${message.reason}.`);
      return;
    }
    if (message.type !== "command.result") throw new Error("Unexpected Remote Bridge control message.");
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      if (message.workspaceId !== request.workspaceId) throw new Error("Remote command Workspace binding changed.");
      this.pendingRequests.delete(message.requestId);
      window.clearTimeout(request.timer);
      request.removeAbort?.();
      if (message.ok) request.resolve(sanitizePeerValue(message.body));
      else request.reject(new Error(safePeerError(message.error)));
      return;
    }
    const stream = this.pendingStreams.get(message.requestId);
    if (stream) {
      if (message.workspaceId !== stream.workspaceId) throw new Error("Remote stream Workspace binding changed.");
      if (!message.ok) this.failStream(message.requestId);
    }
  }

  private handleStreamMessage(value: unknown): void {
    const message = parseStreamMessage(value, this.sessionId);
    if (message.type === "stream.open") {
      const pending = this.pendingStreams.get(message.requestId);
      if (!pending || pending.workspaceId !== message.workspaceId || this.streamRequests.has(message.streamId)) throw new Error("Remote stream opening is invalid.");
      pending.streamId = message.streamId;
      this.streamRequests.set(message.streamId, message.requestId);
      if (pending.cancelled) void this.sendStreamCancel(message.requestId, pending, "cancelled");
      return;
    }
    const requestId = this.streamRequests.get(message.streamId);
    const pending = requestId ? this.pendingStreams.get(requestId) : undefined;
    if (!pending || requestId !== message.requestId || pending.workspaceId !== message.workspaceId) throw new Error("Remote stream binding is invalid.");
    if (message.type === "stream.chunk") {
      if (message.chunkSequence !== pending.sequence + 1) throw new PeerSecurityError("SEQUENCE_GAP", "Remote stream chunk sequence is not contiguous.");
      pending.sequence = message.chunkSequence;
      pending.onEvent(sanitizePeerValue(message.data), message.event);
      return;
    }
    this.finishStream(message.requestId, message.status >= 200 && message.status < 300 && !message.error);
  }

  private sendControl(value: unknown): Promise<void> {
    return this.queueSend("control", value);
  }

  private queueSend(channel: "control" | "stream", value: unknown): Promise<void> {
    const next = this.sendQueues[channel].then(async () => {
      if (this.closed) throw new Error(this.closeReason);
      const frame = await this.cryptoContext.encryptJson(channel, value);
      const dataChannel = channel === "control" ? this.control : this.stream;
      await waitForBackpressure(dataChannel, this.cryptoContext.leaseExpiresAtMs - this.now());
      if (this.closed || dataChannel.readyState !== "open") throw new Error(`${channel} channel is closed.`);
      dataChannel.send(frame);
    });
    this.sendQueues[channel] = next.catch(() => undefined);
    return next;
  }

  private rejectPendingRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.pendingRequests.delete(requestId);
    window.clearTimeout(pending.timer);
    pending.removeAbort?.();
    pending.reject(error);
  }

  private cancelStream(requestId: string, reason: string): void {
    const pending = this.pendingStreams.get(requestId);
    if (!pending) return;
    pending.cancelled = true;
    if (pending.streamId) void this.sendStreamCancel(requestId, pending, reason);
  }

  private async sendStreamCancel(requestId: string, pending: PendingStream, reason: string): Promise<void> {
    if (!pending.streamId) return;
    await this.sendControl({
      type: "stream.cancel",
      sessionId: this.sessionId,
      requestId,
      streamId: pending.streamId,
      workspaceId: pending.workspaceId,
      reason
    } satisfies RemoteControlMessage).catch(() => undefined);
    this.finishStream(requestId, reason === "cancelled");
  }

  private finishStream(requestId: string, ok: boolean): void {
    const pending = this.pendingStreams.get(requestId);
    if (!pending) return;
    this.pendingStreams.delete(requestId);
    if (pending.streamId) this.streamRequests.delete(pending.streamId);
    window.clearTimeout(pending.timer);
    if (!ok) pending.onError();
  }

  private failStream(requestId: string): void {
    this.finishStream(requestId, false);
  }

  private failClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.closeReason = reason;
    if (this.leaseTimer !== undefined) window.clearTimeout(this.leaseTimer);
    this.workspaceReadyReject?.(new Error(reason));
    this.workspaceReadyResolve = undefined;
    this.workspaceReadyReject = undefined;
    for (const [requestId] of this.pendingRequests) this.rejectPendingRequest(requestId, new Error(reason));
    for (const [requestId] of this.pendingStreams) this.failStream(requestId);
    this.control.close();
    this.stream.close();
    this.peer.close();
  }
}

export async function establishRemotePeer(input: {
  device: ConnectDevice;
  signalingFactory?: ConnectSignalingFactory;
  peerFactory?: PeerConnectionFactory;
  subtle?: SubtleCrypto;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RemotePeerTransport> {
  const subtle = input.subtle ?? crypto.subtle;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PEER_CONNECT_TIMEOUT_MS;
  const agreement = await createBrowserAgreementKey(subtle);
  const signaling = await (input.signalingFactory ?? openConnectSignalingChannel)({
    deviceId: input.device.deviceId,
    browserAgreementPublicJwk: agreement.publicKeyJwk,
    signal: input.signal,
    timeoutMs
  });
  let peer: PeerConnectionAdapter | undefined;
  try {
    if (signaling.deviceId !== input.device.deviceId) throw new Error("Connect signaling device binding is invalid.");
    const signalCrypto = await createBrowserSignalCryptoContext({
      agreement,
      deviceAgreementPublicJwk: input.device.agreementPublicKeyJwk,
      sessionId: signaling.sessionId,
      subtle
    });
    peer = (input.peerFactory ?? createNativePeerConnection)(HUNSU_PEER_RTC_CONFIGURATION);
    const control = peer.createDataChannel(HUNSU_CONTROL_CHANNEL, { ordered: true });
    const stream = peer.createDataChannel(HUNSU_STREAM_CHANNEL, { ordered: true });
    assertReliableOrderedChannel(control);
    assertReliableOrderedChannel(stream);
    const signalingBinding = bindEncryptedSignaling({ signaling, signalCrypto, peer, timeoutMs, signal: input.signal });
    const offer = await peer.createOffer();
    if (offer.type !== "offer" || typeof offer.sdp !== "string") throw new Error("Browser peer offer is invalid.");
    assertSafeSdp(offer.sdp);
    await peer.setLocalDescription(offer);
    await signalingBinding.send({ type: "peer.offer", sdp: offer.sdp });
    signalingBinding.releaseOfferCandidates();
    await Promise.all([
      signalingBinding.answer,
      waitForDataChannelOpen(control, input.signal, timeoutMs),
      waitForDataChannelOpen(stream, input.signal, timeoutMs)
    ]);
    const browserNonce = randomNonce();
    const serverHello = await exchangePeerHello({
      control,
      clientHello: {
        type: "peer.client-hello",
        protocolVersion: REMOTE_PEER_PROTOCOL_VERSION,
        sessionId: signaling.sessionId,
        ticket: signaling.ticket,
        browserAgreementPublicJwk: agreement.publicKeyJwk,
        browserNonce
      },
      sessionId: signaling.sessionId,
      timeoutMs,
      signal: input.signal
    });
    const cryptoContext = await completeBrowserPeerHandshake({
      agreement,
      sessionId: signaling.sessionId,
      accountId: signaling.accountId,
      deviceId: input.device.deviceId,
      ticket: signaling.ticket,
      browserNonce,
      serverHello,
      deviceSigningPublicKeyJwk: input.device.signingPublicKeyJwk,
      subtle,
      now
    });
    const transport = new RemotePeerTransport(input.device, signaling.sessionId, peer, control, stream, cryptoContext, now);
    await transport.confirm();
    await transport.waitForWorkspaceSnapshot(timeoutMs);
    signalingBinding.close();
    signaling.close();
    return transport;
  } catch (error) {
    peer?.close();
    signaling.close();
    throw error;
  }
}

let activePeer: RemotePeerTransport | undefined;

export async function ensureActiveRemotePeer(device: ConnectDevice, options: Omit<Parameters<typeof establishRemotePeer>[0], "device"> = {}): Promise<RemotePeerTransport> {
  if (activePeer?.device.deviceId === device.deviceId && activePeer.isOpen) return activePeer;
  activePeer?.close("Replacing the active Remote Bridge peer.");
  activePeer = await establishRemotePeer({ device, ...options });
  return activePeer;
}

export function currentActiveRemotePeer(): RemotePeerTransport | undefined {
  return activePeer?.isOpen ? activePeer : undefined;
}

export function closeActiveRemotePeer(): void {
  activePeer?.close();
  activePeer = undefined;
}

export function requiredScopesForPeerCommand(name: string): PeerWorkspaceScope[] {
  return isRemoteCommandName(name) ? requiredScopesForRemoteCommand(name) : ["remote.access"];
}

export function assertWorkspaceScopeAuthority(workspace: PeerWorkspaceGrant, commandName: string): void {
  if (!isRemoteCommandName(commandName)) throw new Error("Remote Bridge command is not supported.");
  const missing = requiredScopesForRemoteCommand(commandName).find(scope => !workspace.scopes.includes(scope));
  if (missing) throw new Error(`Bridge Workspace grant does not include ${missing}.`);
}

export function createNativePeerConnection(configuration: RTCConfiguration): PeerConnectionAdapter {
  if (typeof RTCPeerConnection === "undefined") throw new Error("This browser does not support WebRTC peer connections.");
  const peer = new RTCPeerConnection(configuration);
  return {
    get connectionState() { return peer.connectionState; },
    createDataChannel(label, options) { return nativeDataChannel(peer.createDataChannel(label, options)); },
    createOffer: () => peer.createOffer(),
    setLocalDescription: description => peer.setLocalDescription(description),
    setRemoteDescription: description => peer.setRemoteDescription(description),
    addIceCandidate: candidate => peer.addIceCandidate(candidate),
    close: () => peer.close(),
    onIceCandidate(listener) {
      const handler = (event: RTCPeerConnectionIceEvent) => listener(event.candidate?.toJSON() ?? null);
      peer.addEventListener("icecandidate", handler);
      return () => peer.removeEventListener("icecandidate", handler);
    },
    onStateChange(listener) {
      peer.addEventListener("connectionstatechange", listener);
      return () => peer.removeEventListener("connectionstatechange", listener);
    }
  };
}

function nativeDataChannel(channel: RTCDataChannel): PeerDataChannelAdapter {
  return {
    get label() { return channel.label; },
    get ordered() { return channel.ordered; },
    get maxRetransmits() { return channel.maxRetransmits; },
    get maxPacketLifeTime() { return channel.maxPacketLifeTime; },
    get readyState() { return channel.readyState; },
    get bufferedAmount() { return channel.bufferedAmount; },
    get bufferedAmountLowThreshold() { return channel.bufferedAmountLowThreshold; },
    set bufferedAmountLowThreshold(value: number) { channel.bufferedAmountLowThreshold = value; },
    send: data => channel.send(data),
    close: () => channel.close(),
    onOpen(listener) { channel.addEventListener("open", listener); return () => channel.removeEventListener("open", listener); },
    onMessage(listener) {
      const handler = (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") listener(event.data);
        else channel.close();
      };
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
    onClose(listener) { channel.addEventListener("close", listener); return () => channel.removeEventListener("close", listener); },
    onBufferedAmountLow(listener) { channel.addEventListener("bufferedamountlow", listener); return () => channel.removeEventListener("bufferedamountlow", listener); }
  };
}

function bindEncryptedSignaling(input: {
  signaling: ConnectSignalingChannel;
  signalCrypto: Awaited<ReturnType<typeof createBrowserSignalCryptoContext>>;
  peer: PeerConnectionAdapter;
  timeoutMs: number;
  signal?: AbortSignal;
}): {
  answer: Promise<void>;
  send(value: RemotePeerSignal): Promise<void>;
  releaseOfferCandidates(): void;
  close(): void;
} {
  let receiveQueue = Promise.resolve();
  let sendQueue = Promise.resolve();
  let remoteDescriptionSet = false;
  let closed = false;
  const queuedCandidates: RTCIceCandidateInit[] = [];
  let releaseCandidates: (() => void) | undefined;
  const offerSent = new Promise<void>(resolve => { releaseCandidates = resolve; });
  let resolveAnswer!: () => void;
  let rejectAnswer!: (error: Error) => void;
  const answer = new Promise<void>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  const timeout = window.setTimeout(() => rejectAnswer(new Error("Remote Bridge answer timed out.")), input.timeoutMs);
  const removeFrame = input.signaling.onFrame(frame => {
    receiveQueue = receiveQueue.then(async () => {
      const value = await input.signalCrypto.decrypt(frame);
      const decoded = decodeRemotePeerSignal(value);
      if (!decoded.ok) throw new Error(decoded.error.message);
      if (decoded.value.type === "peer.answer") {
        if (remoteDescriptionSet) throw new Error("Remote Bridge sent more than one answer.");
        assertSafeSdp(decoded.value.sdp);
        await input.peer.setRemoteDescription({ type: "answer", sdp: decoded.value.sdp });
        remoteDescriptionSet = true;
        for (const candidate of queuedCandidates.splice(0)) await input.peer.addIceCandidate(candidate);
        window.clearTimeout(timeout);
        resolveAnswer();
      } else if (decoded.value.type === "peer.ice") {
        const candidate = remoteIceCandidate(decoded.value);
        if (remoteDescriptionSet) await input.peer.addIceCandidate(candidate);
        else if (queuedCandidates.length < 64) queuedCandidates.push(candidate);
        else throw new Error("Remote Bridge sent too many early ICE candidates.");
      } else if (decoded.value.type === "peer.close") {
        throw new Error(`Remote Bridge signaling closed: ${decoded.value.reason}.`);
      } else {
        throw new Error("Remote Bridge sent an invalid signaling direction.");
      }
    }).catch(error => {
      const failure = error instanceof Error ? error : new Error("Encrypted Connect signaling failed.");
      rejectAnswer(failure);
      input.peer.close();
      input.signaling.close();
    });
  });
  const removeClose = input.signaling.onClose(() => {
    if (!closed && !remoteDescriptionSet) rejectAnswer(new Error("Connect signaling closed before the Remote Bridge answer."));
  });
  const removeIce = input.peer.onIceCandidate(candidate => {
    if (!candidate) return;
    sendQueue = sendQueue.then(async () => {
      await offerSent;
      await sendSignal(input.signaling, input.signalCrypto, localIceSignal(candidate));
    }).catch(error => {
      rejectAnswer(error instanceof Error ? error : new Error("Browser ICE signaling failed."));
      input.peer.close();
    });
  });
  return {
    answer,
    send(value) {
      if (value.type === "peer.offer") return sendSignal(input.signaling, input.signalCrypto, value);
      const next = sendQueue.then(() => sendSignal(input.signaling, input.signalCrypto, value));
      sendQueue = next.catch(() => undefined);
      return next;
    },
    releaseOfferCandidates() { releaseCandidates?.(); releaseCandidates = undefined; },
    close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(timeout);
      removeFrame();
      removeClose();
      removeIce();
    }
  };
}

async function sendSignal(signaling: ConnectSignalingChannel, cryptoContext: Awaited<ReturnType<typeof createBrowserSignalCryptoContext>>, value: RemotePeerSignal): Promise<void> {
  signaling.send(await cryptoContext.encrypt(value));
}

function exchangePeerHello(input: {
  control: PeerDataChannelAdapter;
  clientHello: Record<string, unknown>;
  sessionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<RemotePeerServerHello> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(undefined, new Error("Remote Bridge peer hello timed out.")), input.timeoutMs);
    const removeMessage = input.control.onMessage(raw => {
      if (new TextEncoder().encode(raw).byteLength > REMOTE_PEER_MAX_FRAME_BYTES) return finish(undefined, new Error("Remote Bridge peer hello is too large."));
      let value: unknown;
      try { value = JSON.parse(raw) as unknown; } catch { return finish(undefined, new Error("Remote Bridge peer hello is invalid.")); }
      try { finish(parseServerHello(value, input.sessionId)); } catch (error) { finish(undefined, error instanceof Error ? error : new Error("Remote Bridge peer hello is invalid.")); }
    });
    const removeClose = input.control.onClose(() => finish(undefined, new Error("Control channel closed during peer authentication.")));
    const handleAbort = () => finish(undefined, abortError());
    const finish = (hello?: RemotePeerServerHello, error?: Error) => {
      window.clearTimeout(timeout);
      removeMessage();
      removeClose();
      input.signal?.removeEventListener("abort", handleAbort);
      if (hello) resolve(hello); else reject(error ?? new Error("Remote Bridge peer hello failed."));
    };
    input.signal?.addEventListener("abort", handleAbort, { once: true });
    if (input.signal?.aborted) return handleAbort();
    input.control.send(JSON.stringify(input.clientHello));
  });
}

function parseServerHello(value: unknown, sessionId: string): RemotePeerServerHello {
  if (!isRecord(value)
    || !exactKeys(value, ["type", "protocolVersion", "sessionId", "bridgeEphemeralPublicJwk", "bridgeNonce", "leaseExpiresAt", "transcriptHash", "signature"])
    || value.type !== "peer.server-hello"
    || value.protocolVersion !== REMOTE_PEER_PROTOCOL_VERSION
    || value.sessionId !== sessionId
    || !isRecord(value.bridgeEphemeralPublicJwk)
    || typeof value.bridgeNonce !== "string"
    || typeof value.leaseExpiresAt !== "string"
    || typeof value.transcriptHash !== "string"
    || typeof value.signature !== "string") throw new Error("Remote Bridge peer hello fields are invalid.");
  base64UrlDecode(value.bridgeNonce, 24, 64);
  base64UrlDecode(value.transcriptHash, 32, 32);
  base64UrlDecode(value.signature, 64, 64);
  return value as unknown as RemotePeerServerHello;
}

function parseControlMessage(value: unknown, sessionId: string): Exclude<RemoteControlMessage, { type: "session.confirm" | "command.request" | "stream.cancel" }> {
  if (!isRecord(value) || value.sessionId !== sessionId || typeof value.type !== "string") throw new Error("Remote Bridge control message is invalid.");
  if (value.type === "session.ready") {
    if (!exactKeys(value, ["type", "sessionId", "deviceId", "transcriptHash", "leaseExpiresAt", "workspaces"])
      || typeof value.deviceId !== "string"
      || typeof value.transcriptHash !== "string"
      || typeof value.leaseExpiresAt !== "string"
      || !Array.isArray(value.workspaces)) throw new Error("Remote Bridge readiness message is invalid.");
    return { type: "session.ready", sessionId, deviceId: value.deviceId, transcriptHash: value.transcriptHash, leaseExpiresAt: value.leaseExpiresAt, workspaces: parseWorkspaces(value.workspaces) };
  }
  if (value.type === "command.result") {
    if (!exactKeys(value, ["type", "sessionId", "requestId", "workspaceId", "status", "ok", "body", "error"])
      || !REQUEST_ID_PATTERN.test(String(value.requestId))
      || typeof value.workspaceId !== "string"
      || !Number.isInteger(value.status)
      || typeof value.ok !== "boolean"
      || (value.error !== undefined && typeof value.error !== "string")) throw new Error("Remote command result is invalid.");
    return value as unknown as Extract<RemoteControlMessage, { type: "command.result" }>;
  }
  if (value.type === "session.close") {
    if (!exactKeys(value, ["type", "sessionId", "reason"])
      || (value.reason !== "lease_expired" && value.reason !== "replaced" && value.reason !== "canceled" && value.reason !== "protocol_error")) throw new Error("Remote Bridge close message is invalid.");
    return value as unknown as Extract<RemoteControlMessage, { type: "session.close" }>;
  }
  throw new Error("Remote Bridge control message type is invalid.");
}

function parseStreamMessage(value: unknown, sessionId: string): RemoteStreamMessage {
  if (!isRecord(value) || value.sessionId !== sessionId || typeof value.type !== "string") throw new Error("Remote Bridge stream message is invalid.");
  if (value.type === "stream.open") {
    if (!exactKeys(value, ["type", "sessionId", "requestId", "streamId", "workspaceId"])) throw new Error("Remote stream opening fields are invalid.");
  } else if (value.type === "stream.chunk") {
    if (!exactKeys(value, ["type", "sessionId", "requestId", "streamId", "workspaceId", "chunkSequence", "event", "data"])
      || !Number.isSafeInteger(value.chunkSequence) || Number(value.chunkSequence) < 1 || typeof value.event !== "string") throw new Error("Remote stream chunk fields are invalid.");
  } else if (value.type === "stream.end") {
    if (!exactKeys(value, ["type", "sessionId", "requestId", "streamId", "workspaceId", "status", "error"])
      || !Number.isInteger(value.status) || (value.error !== undefined && typeof value.error !== "string")) throw new Error("Remote stream end fields are invalid.");
  } else throw new Error("Remote Bridge stream message type is invalid.");
  if (!REQUEST_ID_PATTERN.test(String(value.requestId)) || !REQUEST_ID_PATTERN.test(String(value.streamId)) || typeof value.workspaceId !== "string") throw new Error("Remote stream identifiers are invalid.");
  return value as unknown as RemoteStreamMessage;
}

function parseWorkspaces(values: unknown[]): PeerWorkspaceGrant[] {
  if (values.length > 256) throw new Error("Remote Bridge Workspace list is too large.");
  const seen = new Set<string>();
  return values.map(value => {
    if (!isRecord(value) || !exactKeys(value, ["workspaceId", "displayName", "scopes"])
      || typeof value.workspaceId !== "string" || !value.workspaceId || value.workspaceId.length > 256
      || typeof value.displayName !== "string" || !value.displayName || value.displayName.length > 256
      || !Array.isArray(value.scopes) || !value.scopes.every(isRemoteWorkspaceScope)
      || !value.scopes.includes("remote.access") || seen.has(value.workspaceId)) throw new Error("Remote Bridge Workspace grant is invalid.");
    seen.add(value.workspaceId);
    return { workspaceId: value.workspaceId, displayName: value.displayName, scopes: [...new Set(value.scopes)] };
  });
}

function waitForDataChannelOpen(channel: PeerDataChannelAdapter, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error(`${channel.label} did not open.`)), timeoutMs);
    const removeOpen = channel.onOpen(() => finish());
    const removeClose = channel.onClose(() => finish(new Error(`${channel.label} closed before opening.`)));
    const handleAbort = () => finish(abortError());
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      removeOpen();
      removeClose();
      signal?.removeEventListener("abort", handleAbort);
      if (error) reject(error); else resolve();
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function waitForBackpressure(channel: PeerDataChannelAdapter, remainingLeaseMs: number): Promise<void> {
  if (channel.bufferedAmount <= PEER_BUFFER_HIGH_WATER_BYTES) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Peer channel backpressure deadline expired.")), Math.max(1, Math.min(5_000, remainingLeaseMs)));
    const removeLow = channel.onBufferedAmountLow(() => finish());
    const removeClose = channel.onClose(() => finish(new Error("Peer channel closed under backpressure.")));
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      removeLow();
      removeClose();
      if (error) reject(error); else resolve();
    };
  });
}

function assertReliableOrderedChannel(channel: PeerDataChannelAdapter): void {
  if ((channel.label !== HUNSU_CONTROL_CHANNEL && channel.label !== HUNSU_STREAM_CHANNEL)
    || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
    throw new Error("Remote Bridge DataChannels must be the two reliable ordered protocol channels.");
  }
}

function localIceSignal(candidate: RTCIceCandidateInit): RemotePeerSignal {
  if (typeof candidate.candidate !== "string" || !validIceCandidate(candidate.candidate)) throw new Error("Browser ICE candidate is invalid.");
  return {
    type: "peer.ice",
    candidate: candidate.candidate,
    ...(candidate.sdpMid == null ? {} : { sdpMid: candidate.sdpMid }),
    ...(candidate.sdpMLineIndex == null ? {} : { sdpMLineIndex: candidate.sdpMLineIndex }),
    ...(candidate.usernameFragment == null ? {} : { usernameFragment: candidate.usernameFragment })
  };
}

function remoteIceCandidate(signal: Extract<RemotePeerSignal, { type: "peer.ice" }>): RTCIceCandidateInit {
  if (!validIceCandidate(signal.candidate)) throw new Error("Remote Bridge ICE candidate is invalid.");
  return { candidate: signal.candidate, sdpMid: signal.sdpMid ?? null, sdpMLineIndex: signal.sdpMLineIndex ?? null, usernameFragment: signal.usernameFragment ?? null };
}

function validIceCandidate(candidate: string): boolean {
  if (candidate.length > 2_048 || !/^candidate:[^\r\n]+$/u.test(candidate)) return false;
  const candidateType = candidate.match(/ typ ([A-Za-z0-9_-]+)(?: |$)/u)?.[1];
  return candidateType === "host" || candidateType === "srflx";
}

function assertSafeSdp(sdp: string): void {
  if (!sdp.startsWith("v=0\r\n") || new TextEncoder().encode(sdp).byteLength > 64 * 1024 || /[\u0000\u000b\u000c]/u.test(sdp)) throw new Error("Peer SDP is invalid.");
  const media = sdp.split("\r\n").filter(line => line.startsWith("m="));
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/u.test(media[0]!)) throw new Error("Peer SDP must contain exactly one DataChannel section.");
  const candidates = sdp.split("\r\n").filter(line => line.startsWith("a=candidate:"));
  if (/^m=(?:audio|video)\b/mu.test(sdp)
    || candidates.length > 64
    || candidates.some(line => !validIceCandidate(line.slice(2)))) {
    throw new Error("Peer SDP contains forbidden media or ICE candidates.");
  }
}

function sanitizePeerValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizePeerValue(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) throw new Error("Remote Bridge payload is cyclic.");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("token") || normalized.includes("authorization") || normalized.includes("credential") || containsLocalLocationField(key, child)) continue;
    result[key] = sanitizePeerValue(child, seen);
  }
  seen.delete(value);
  return result;
}

function containsLocalLocationField(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase();
  if (["projectpath", "repositorypath", "repositoryroot", "worktreepath", "runtimepath", "cwd"].includes(normalized)) return true;
  return (normalized === "path" || normalized === "root") && typeof value === "string" && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value.trim());
}

function safePeerError(value: unknown): string {
  return typeof value === "string" && value.trim() && value.length <= 240 && !/(?:^|\s)(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value)
    ? value.trim()
    : "Remote Bridge command failed.";
}

function boundedTimeout(value: number, remainingLeaseMs: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Remote command timeout is invalid.");
  const timeout = Math.floor(Math.min(value, remainingLeaseMs - 1_000));
  if (timeout <= 0) throw new Error("Remote Bridge peer lease is too close to expiry.");
  return timeout;
}

function randomId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
}

function randomNonce(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

function abortError(): DOMException {
  return new DOMException("Operation aborted.", "AbortError");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
