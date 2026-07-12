import { Buffer } from "node:buffer";
import {
  REMOTE_PEER_CONTROL_CHANNEL,
  REMOTE_PEER_STUN_URL,
  REMOTE_PEER_STREAM_CHANNEL
} from "@hunsu/protocol";
import { validateRemoteIceCandidate, validateRemoteSdp } from "./peerCrypto.ts";

export type PeerData = string | Uint8Array;

export type PeerDataChannel = {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits?: number;
  readonly maxPacketLifeTime?: number;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(value: string | Uint8Array): void;
  close(): void;
  onMessage(listener: (value: PeerData) => void): () => void;
  onStateChange(listener: (state: PeerDataChannel["readyState"]) => void): () => void;
  onBufferedAmountLow(listener: () => void): () => void;
};

export type PeerTransport = {
  acceptOffer(sdp: string, signal?: AbortSignal): Promise<{ answerSdp: string }>;
  waitForChannels(signal?: AbortSignal): Promise<{
    control: PeerDataChannel;
    stream: PeerDataChannel;
  }>;
  addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    usernameFragment?: string;
  }): Promise<void>;
  close(): Promise<void>;
};

export type PeerTransportFactory = () => Promise<PeerTransport>;

type WeriftEvent<T extends unknown[]> = {
  subscribe(listener: (...args: T) => void): { unSubscribe(): void };
};

type WeriftChannel = {
  label: string;
  ordered: boolean;
  maxRetransmits?: number;
  maxPacketLifeTime?: number;
  isCreatedByRemote: boolean;
  readyState: PeerDataChannel["readyState"];
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onMessage: WeriftEvent<[string | Buffer]>;
  stateChange: WeriftEvent<[PeerDataChannel["readyState"]]>;
  bufferedAmountLow: WeriftEvent<[]>;
  send(value: string | Buffer): void;
  close(): void;
};

type WeriftConnection = {
  onDataChannel: WeriftEvent<[WeriftChannel]>;
  connectionStateChange: WeriftEvent<[string]>;
  iceGatheringState: "new" | "gathering" | "complete";
  iceGatheringStateChange: WeriftEvent<["new" | "gathering" | "complete"]>;
  localDescription?: { sdp: string };
  setRemoteDescription(value: { type: "offer"; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: "answer"; sdp: string }>;
  setLocalDescription(value: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(value: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    usernameFragment?: string;
  }): Promise<void>;
  close(): Promise<void>;
};

type WeriftModule = {
  RTCPeerConnection: new (configuration: {
    iceServers: Array<{ urls: string }>;
    iceTransportPolicy: "all";
    maxMessageSize: number;
  }) => WeriftConnection;
};

export function createWeriftPeerTransportFactory(input: {
  loadWerift?: () => Promise<WeriftModule>;
  channelTimeoutMs?: number;
} = {}): PeerTransportFactory {
  return async () => {
    const werift = await (input.loadWerift ?? loadWerift)();
    const connection = new werift.RTCPeerConnection({
      iceServers: [{ urls: REMOTE_PEER_STUN_URL }],
      iceTransportPolicy: "all",
      maxMessageSize: 128 * 1024
    });
    return createWeriftTransport(connection, input.channelTimeoutMs ?? 10_000);
  };
}

export async function sendPeerDataWithBackpressure(input: {
  channel: PeerDataChannel;
  value: string | Uint8Array;
  signal: AbortSignal;
  highWaterMark?: number;
  lowWaterMark?: number;
  timeoutMs?: number;
}): Promise<void> {
  const highWaterMark = input.highWaterMark ?? 1024 * 1024;
  const lowWaterMark = input.lowWaterMark ?? 256 * 1024;
  if (input.channel.readyState !== "open") throw new Error("Peer DataChannel is not open.");
  if (input.channel.bufferedAmount > highWaterMark) {
    input.channel.bufferedAmountLowThreshold = lowWaterMark;
    await waitForBufferedAmountLow(input.channel, input.signal, input.timeoutMs ?? 10_000);
  }
  if (input.signal.aborted || input.channel.readyState !== "open") throw new Error("Peer DataChannel send was canceled.");
  input.channel.send(input.value);
  if (input.channel.bufferedAmount > highWaterMark * 2) throw new Error("Peer DataChannel backpressure bound was exceeded.");
}

function createWeriftTransport(connection: WeriftConnection, channelTimeoutMs: number): PeerTransport {
  const channels = new Map<string, PeerDataChannel>();
  let channelError: Error | undefined;
  let closed = false;
  const dataSubscription = connection.onDataChannel.subscribe(raw => {
    try {
      const channel = wrapWeriftChannel(raw);
      if (!raw.isCreatedByRemote
        || (channel.label !== REMOTE_PEER_CONTROL_CHANNEL && channel.label !== REMOTE_PEER_STREAM_CHANNEL)
        || channels.has(channel.label)) {
        throw new Error("Peer offered an unexpected DataChannel.");
      }
      assertReliableOrderedChannel(channel);
      channels.set(channel.label, channel);
    } catch (error) {
      channelError = error instanceof Error ? error : new Error("Peer DataChannel is invalid.");
      void connection.close();
    }
  });

  return {
    async acceptOffer(sdp, signal) {
      if (closed) throw new Error("Peer transport is closed.");
      validateRemoteSdp("offer", sdp);
      await connection.setRemoteDescription({ type: "offer", sdp });
      if (channelError) throw channelError;
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await waitForIceGathering(connection, signal, channelTimeoutMs);
      const answerSdp = connection.localDescription?.sdp;
      if (!answerSdp) throw new Error("Peer answer SDP is unavailable.");
      validateRemoteSdp("answer", answerSdp);
      return { answerSdp };
    },
    waitForChannels(signal) {
      if (closed) return Promise.reject(new Error("Peer transport is closed."));
      return waitForRequiredChannels(channels, () => channelError, signal, channelTimeoutMs);
    },
    async addIceCandidate(candidate) {
      if (closed) throw new Error("Peer transport is closed.");
      validateRemoteIceCandidate(candidate.candidate);
      await connection.addIceCandidate(candidate);
    },
    async close() {
      if (closed) return;
      closed = true;
      dataSubscription.unSubscribe();
      for (const channel of channels.values()) channel.close();
      channels.clear();
      await connection.close();
    }
  };
}

function wrapWeriftChannel(channel: WeriftChannel): PeerDataChannel {
  return {
    get label() { return channel.label; },
    get ordered() { return channel.ordered; },
    get maxRetransmits() { return channel.maxRetransmits; },
    get maxPacketLifeTime() { return channel.maxPacketLifeTime; },
    get readyState() { return channel.readyState; },
    get bufferedAmount() { return channel.bufferedAmount; },
    get bufferedAmountLowThreshold() { return channel.bufferedAmountLowThreshold; },
    set bufferedAmountLowThreshold(value) { channel.bufferedAmountLowThreshold = value; },
    send(value) { channel.send(typeof value === "string" ? value : Buffer.from(value)); },
    close() { channel.close(); },
    onMessage(listener) {
      const subscription = channel.onMessage.subscribe(value => listener(typeof value === "string" ? value : new Uint8Array(value)));
      return () => subscription.unSubscribe();
    },
    onStateChange(listener) {
      const subscription = channel.stateChange.subscribe(listener);
      return () => subscription.unSubscribe();
    },
    onBufferedAmountLow(listener) {
      const subscription = channel.bufferedAmountLow.subscribe(listener);
      return () => subscription.unSubscribe();
    }
  };
}

function assertReliableOrderedChannel(channel: PeerDataChannel): void {
  if (!channel.ordered || channel.maxRetransmits !== undefined || channel.maxPacketLifeTime !== undefined) {
    throw new Error("Peer DataChannels must be reliable and ordered.");
  }
}

async function waitForRequiredChannels(
  channels: Map<string, PeerDataChannel>,
  error: () => Error | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ control: PeerDataChannel; stream: PeerDataChannel }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Peer negotiation was canceled.");
    const failure = error();
    if (failure) throw failure;
    const control = channels.get(REMOTE_PEER_CONTROL_CHANNEL);
    const stream = channels.get(REMOTE_PEER_STREAM_CHANNEL);
    if (control && stream) {
      assertReliableOrderedChannel(control);
      assertReliableOrderedChannel(stream);
      return { control, stream };
    }
    await shortDelay(signal);
  }
  throw new Error("Peer did not open both required DataChannels.");
}

async function waitForIceGathering(connection: WeriftConnection, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Peer ICE gathering timed out.")), timeoutMs);
    timeout.unref?.();
    const subscription = connection.iceGatheringStateChange.subscribe(state => {
      if (state === "complete") finish();
    });
    const onAbort = () => finish(new Error("Peer ICE gathering was canceled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(error?: Error): void {
      clearTimeout(timeout);
      subscription.unSubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function waitForBufferedAmountLow(channel: PeerDataChannel, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Peer DataChannel remained backpressured.")), timeoutMs);
    timeout.unref?.();
    const offLow = channel.onBufferedAmountLow(() => finish());
    const offState = channel.onStateChange(state => {
      if (state !== "open") finish(new Error("Peer DataChannel closed while backpressured."));
    });
    const onAbort = () => finish(new Error("Peer DataChannel send was canceled."));
    signal.addEventListener("abort", onAbort, { once: true });
    function finish(error?: Error): void {
      clearTimeout(timeout);
      offLow();
      offState();
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function shortDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 5);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Peer negotiation was canceled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function loadWerift(): Promise<WeriftModule> {
  return await import("werift") as unknown as WeriftModule;
}
