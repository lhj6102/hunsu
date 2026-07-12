import { Buffer } from "node:buffer";
import { hostname } from "node:os";
import { randomBytes, webcrypto } from "node:crypto";
import {
  CONNECT_CONTROL_FRAME_SCHEMA,
  CONNECT_ENROLLMENT_SCHEMA,
  CONNECT_SIGNAL_FRAME_SCHEMA,
  REMOTE_PEER_MAX_ACTIVE_STREAMS,
  REMOTE_PEER_PROTOCOL_VERSION,
  decodeConnectSignalFrame,
  decodeRemoteControlMessage,
  decodeRemotePeerClientHello,
  decodeRemotePeerSignal,
  type ConnectDeviceTokenResponse,
  type ConnectEnrollmentCreated,
  type ConnectServerControlFrame,
  type ConnectSignalFrame,
  type RemoteControlMessage,
  type RemotePeerSignal,
  type RemoteStreamMessage,
  type RemoteWorkspaceMetadata
} from "@hunsu/protocol";
import type { BridgeDeploymentProfile } from "../deploymentProfile.ts";
import { BridgeError } from "../client/cliResult.ts";
import type {
  ConfigStore,
  CredentialStore,
  StoredConnectCredential
} from "../state/index.ts";
import type { WorkspaceService } from "../workspaces/workspaceService.ts";
import type {
  RemoteBridgeCommandRequest,
  RemoteBridgeCommandResult,
  RemoteCommandStreamContext
} from "./remoteCommandRouter.ts";
import {
  canonicalPublicJwk,
  createPeerDataCryptoContext,
  createSignalCryptoContext,
  generateDeviceKeySet,
  signEnrollmentProof,
  verifyConnectTicket,
  type ConnectTicketClaims,
  type PeerDataCryptoContext,
  type SignalCryptoContext
} from "./peerCrypto.ts";
import {
  createWeriftPeerTransportFactory,
  sendPeerDataWithBackpressure,
  type PeerData,
  type PeerDataChannel,
  type PeerTransport,
  type PeerTransportFactory
} from "./peerTransport.ts";

export type RemoteConnectionState = "disabled" | "signed_out" | "connecting" | "connected" | "offline";

export type RemoteStatus = {
  enabled: boolean;
  signedIn: boolean;
  accountId?: string;
  connection: RemoteConnectionState;
  deviceId?: string;
  peerSessionId?: string;
  grantedWorkspaceIds: string[];
  protocolVersion: typeof REMOTE_PEER_PROTOCOL_VERSION;
};

export type SafeDeviceLogin = {
  state: "pending";
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
  browserOpened: boolean;
};

export type ConnectSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
};

export type ConnectSocketFactory = (input: {
  url: string;
  headers: Readonly<Record<string, string>>;
}) => ConnectSocket | Promise<ConnectSocket>;

export type RemoteService = {
  status(): Promise<RemoteStatus>;
  login(input?: { openBrowser?: boolean }): Promise<SafeDeviceLogin>;
  logout(): Promise<void>;
  enable(): Promise<RemoteStatus>;
  disable(): Promise<RemoteStatus>;
  stop(): void;
};

export function createRemoteService(input: {
  configStore: ConfigStore;
  credentialStore: CredentialStore;
  workspaceService: WorkspaceService;
  deploymentProfile: BridgeDeploymentProfile;
  connectApiUrl: string;
  connectWsUrl: string;
  connectTicketIssuer: string;
  connectTicketSigningKeyId: string;
  connectTicketSigningPublicJwk: JsonWebKey;
  fetchImpl?: typeof fetch;
  socketFactory?: ConnectSocketFactory;
  peerTransportFactory?: PeerTransportFactory;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  deviceName?: string;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  onCommand?: (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult>;
  onCommandStream?: (command: RemoteBridgeCommandRequest, context: RemoteCommandStreamContext) => Promise<RemoteBridgeCommandResult>;
}): RemoteService {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? delay;
  const now = input.now ?? (() => new Date());
  const secureRandom = input.randomBytes ?? randomBytes;
  const connectApiUrl = secureHttpBase(input.connectApiUrl);
  const connectWsUrl = secureWebSocketUrl(input.connectWsUrl);
  const socketFactory = input.socketFactory ?? defaultConnectSocketFactory;
  const peerTransportFactory = input.peerTransportFactory ?? createWeriftPeerTransportFactory();
  let connection: RemoteConnectionState = "disabled";
  let socket: ConnectSocket | undefined;
  let activePeer: ActivePeerSession | undefined;
  let stopped = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let authenticatedAccountId: string | undefined;
  let mutationQueue = Promise.resolve();
  const consumedTickets = new Map<string, string>();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = mutationQueue.then(operation, operation);
    mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const status = async (): Promise<RemoteStatus> => {
    const [config, credentials, workspaces] = await Promise.all([
      input.configStore.read(),
      input.credentialStore.read(),
      input.workspaceService.list()
    ]);
    const registered = credentials?.connect?.state === "registered" ? credentials.connect : undefined;
    const grantedWorkspaceIds = workspaces.ok
      ? workspaces.value.filter(workspace => workspace.lifecycle === "active"
        && workspace.remoteAccess.enabled
        && workspace.remoteAccess.scopes.includes("remote.access"))
        .map(workspace => workspace.workspaceId)
      : [];
    return {
      enabled: config.remote.enabled,
      signedIn: Boolean(registered?.refreshToken),
      ...(registered?.accountId ? { accountId: registered.accountId } : {}),
      connection: !registered ? "signed_out" : config.remote.enabled ? connection : "disabled",
      ...(registered?.deviceId ? { deviceId: registered.deviceId } : {}),
      ...(activePeer ? { peerSessionId: activePeer.sessionId } : {}),
      grantedWorkspaceIds: config.remote.enabled && registered ? grantedWorkspaceIds : [],
      protocolVersion: REMOTE_PEER_PROTOCOL_VERSION
    };
  };

  const closeConnection = (reason: "canceled" | "replaced" | "protocol_error" = "canceled"): void => {
    generation += 1;
    const currentSocket = socket;
    socket = undefined;
    currentSocket?.close(1000, reason);
    const currentPeer = activePeer;
    activePeer = undefined;
    void currentPeer?.close(reason);
    authenticatedAccountId = undefined;
  };

  const consumeTicket = (ticketId: string, digest: string): boolean => {
    if (consumedTickets.has(ticketId) || consumedTickets.size >= 1_024) return false;
    consumedTickets.set(ticketId, digest);
    return true;
  };

  const connect = async (): Promise<void> => {
    const ownGeneration = ++generation;
    if (stopped) return;
    const config = await input.configStore.read();
    if (!config.remote.enabled) return;
    connection = "connecting";
    let credential = await registeredCredential(input.credentialStore);
    credential = await refreshIfNeeded({ credential, credentialStore: input.credentialStore, connectApiUrl, fetchImpl, now, secureRandom });
    if (stopped || ownGeneration !== generation) return;
    const wsHtu = dpopTargetUrl(connectWsUrl);
    const proof = await createDpopProof({
      method: "GET",
      url: wsHtu,
      signingPrivateKey: credential.signingPrivateKey,
      signingPublicKey: credential.signingPublicKey,
      accessToken: credential.accessToken,
      now: now(),
      randomBytes: secureRandom
    });
    const currentSocket = await socketFactory({
      url: connectWsUrl,
      headers: { authorization: `DPoP ${credential.accessToken}`, dpop: proof }
    });
    await waitForSocketOpen(currentSocket, 10_000);
    if (stopped || ownGeneration !== generation) {
      currentSocket.close(1000, "superseded");
      return;
    }
    socket = currentSocket;
    reconnectAttempt = 0;
    let messageQueue = Promise.resolve();
    const handleMessage = (event: { data?: unknown }): void => {
      messageQueue = messageQueue
        .then(() => handleSocketMessage(event.data, credential, currentSocket, ownGeneration))
        .catch(() => { currentSocket.close(1008, "invalid_connect_frame"); });
    };
    const handleClose = (): void => {
      if (socket === currentSocket) socket = undefined;
      if (ownGeneration !== generation || stopped) return;
      connection = "offline";
      authenticatedAccountId = undefined;
      const peer = activePeer;
      activePeer = undefined;
      void peer?.close("protocol_error");
      scheduleReconnect(ownGeneration);
    };
    currentSocket.addEventListener("message", handleMessage);
    currentSocket.addEventListener("close", handleClose);
    currentSocket.addEventListener("error", handleClose);
  };

  const scheduleReconnect = (closedGeneration: number): void => {
    const attempt = reconnectAttempt++;
    const waitMs = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
    void sleep(waitMs).then(async () => {
      if (stopped || closedGeneration !== generation) return;
      const config = await input.configStore.read();
      if (!config.remote.enabled) return;
      await connect().catch(() => {
        if (!stopped) scheduleReconnect(generation);
      });
    });
  };

  const handleSocketMessage = async (
    raw: unknown,
    credential: Extract<StoredConnectCredential, { state: "registered" }>,
    currentSocket: ConnectSocket,
    ownGeneration: number
  ): Promise<void> => {
    if (currentSocket !== socket || ownGeneration !== generation) return;
    const parsed = parseSocketJson(raw);
    if (isConnectControlFrame(parsed)) {
      if (parsed.type === "connect.authenticated") {
        if (parsed.deviceId !== credential.deviceId || parsed.accountId !== credential.accountId || Date.parse(parsed.expiresAt) <= now().getTime()) {
          throw new Error("Connect authentication binding is invalid.");
        }
        authenticatedAccountId = parsed.accountId;
        connection = "connected";
        return;
      }
      if (parsed.type === "connect.session") {
        if (authenticatedAccountId !== credential.accountId || Date.parse(parsed.expiresAt) <= now().getTime()) throw new Error("Connect session arrived before authentication.");
        const claims = await verifyConnectTicket({
          ticket: parsed.ticket,
          signingPublicKey: input.connectTicketSigningPublicJwk,
          expectedKeyId: input.connectTicketSigningKeyId,
          expectedIssuer: input.connectTicketIssuer,
          expectedEnvironment: input.deploymentProfile,
          expectedSessionId: parsed.sessionId,
          expectedDeviceId: credential.deviceId,
          now: now(),
          consume: consumeTicket
        });
        if (claims.accountId !== credential.accountId) throw new Error("Connect ticket account binding is invalid.");
        const signalCrypto = await createSignalCryptoContext({
          sessionId: parsed.sessionId,
          browserAgreementPublicJwk: claims.browserAgreementPublicJwk,
          deviceAgreementPrivateKey: credential.agreementPrivateKey
        });
        const previous = activePeer;
        const peer = new ActivePeerSession({
          sessionId: parsed.sessionId,
          ticket: parsed.ticket,
          ticketClaims: claims,
          signalCrypto,
          deviceSigningPrivateKey: credential.signingPrivateKey,
          workspaceService: input.workspaceService,
          peerTransportFactory,
          onCommand: input.onCommand,
          onCommandStream: input.onCommandStream,
          now,
          randomBytes: secureRandom,
          sendSignal: frame => {
            if (currentSocket !== socket || activePeer !== peer) throw new Error("Connect session is no longer active.");
            currentSocket.send(JSON.stringify(frame));
          },
          onClosed: () => {
            if (activePeer === peer) activePeer = undefined;
          }
        });
        activePeer = peer;
        if (previous) await previous.close("replaced");
        return;
      }
      if (parsed.type === "connect.ready") {
        if (activePeer?.sessionId !== parsed.sessionId) throw new Error("Connect ready session binding is invalid.");
        return;
      }
      if (activePeer?.sessionId === parsed.sessionId) {
        const peer = activePeer;
        activePeer = undefined;
        await peer.close(parsed.reason === "replaced" ? "replaced" : "protocol_error");
      }
      return;
    }
    const signal = decodeConnectSignalFrame(parsed);
    if (!signal.ok || !activePeer || signal.value.sessionId !== activePeer.sessionId) throw new Error("Connect signaling frame is invalid.");
    await activePeer.handleSignal(signal.value);
  };

  return {
    status,
    async login(loginInput = {}) {
      return serialize(async () => {
        stopped = false;
        const existing = await input.credentialStore.ensure();
        if (existing.connect?.state === "registered") {
          throw new BridgeError("REMOTE_CONNECTION_FAILED", "This Bridge is already enrolled with Hunsu Connect.");
        }
        const keys = existing.connect ?? await generateDeviceKeySet();
        const issuedAt = now().toISOString();
        const nonce = Buffer.from(secureRandom(24)).toString("base64url");
        const deviceName = safeDeviceName(input.deviceName ?? hostname());
        const request = {
          schema: CONNECT_ENROLLMENT_SCHEMA,
          deviceName,
          signingPublicJwk: canonicalPublicJwk(keys.signingPublicKey),
          agreementPublicJwk: canonicalPublicJwk(keys.agreementPublicKey),
          issuedAt,
          nonce,
          proof: await signEnrollmentProof({
            deviceName,
            signingPublicJwk: keys.signingPublicKey,
            agreementPublicJwk: keys.agreementPublicKey,
            issuedAt,
            nonce,
            signingPrivateKey: keys.signingPrivateKey
          })
        };
        const response = await fetchImpl(new URL("/v1/device-enrollments", connectApiUrl), {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new BridgeError("REMOTE_CONNECTION_FAILED", `Hunsu Connect enrollment could not start (HTTP ${response.status}).`);
        const created = parseEnrollmentCreated(await response.json().catch(() => undefined), now());
        const enrollment: StoredConnectCredential = {
          ...keys,
          state: "enrolling",
          enrollmentId: created.enrollmentId,
          deviceCode: created.deviceCode,
          userCode: created.userCode,
          verificationUri: created.verificationUri,
          verificationUriComplete: created.verificationUriComplete,
          interval: created.interval,
          expiresAt: new Date(now().getTime() + created.expiresIn * 1_000).toISOString()
        };
        await input.credentialStore.write({ connect: enrollment });
        let browserOpened = false;
        if (loginInput.openBrowser !== false && input.openBrowser) {
          try {
            await input.openBrowser(enrollment.verificationUriComplete);
            browserOpened = true;
          } catch {
            browserOpened = false;
          }
        }
        const loginGeneration = generation;
        void pollEnrollment({
          enrollment,
          credentialStore: input.credentialStore,
          connectApiUrl,
          connectWsUrl,
          fetchImpl,
          sleep,
          now,
          randomBytes: secureRandom,
          canceled: () => stopped || loginGeneration !== generation
        }).catch(() => undefined);
        return {
          state: "pending",
          verificationUri: enrollment.verificationUri,
          verificationUriComplete: enrollment.verificationUriComplete,
          userCode: enrollment.userCode,
          expiresAt: enrollment.expiresAt,
          browserOpened
        };
      });
    },
    async logout() {
      return serialize(async () => {
        closeConnection("canceled");
        connection = "disabled";
        await input.configStore.update(config => ({ ...config, remote: { enabled: false } }));
        await input.credentialStore.write({ connect: null });
      });
    },
    async enable() {
      return serialize(async () => {
        stopped = false;
        await registeredCredential(input.credentialStore);
        await input.configStore.update(config => ({ ...config, remote: { enabled: true } }));
        await connect().catch(error => {
          connection = "offline";
          throw new BridgeError("REMOTE_ENABLE_FAILED", "Remote Bridge could not connect to Hunsu Connect.", { cause: error });
        });
        return status();
      });
    },
    async disable() {
      return serialize(async () => {
        closeConnection("canceled");
        connection = "disabled";
        await input.configStore.update(config => ({ ...config, remote: { enabled: false } }));
        return status();
      });
    },
    stop() {
      stopped = true;
      closeConnection("canceled");
    }
  };
}

class ActivePeerSession {
  readonly sessionId: string;
  private readonly input: {
    sessionId: string;
    ticket: string;
    ticketClaims: ConnectTicketClaims;
    signalCrypto: SignalCryptoContext;
    deviceSigningPrivateKey: JsonWebKey;
    workspaceService: WorkspaceService;
    peerTransportFactory: PeerTransportFactory;
    onCommand?: (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult>;
    onCommandStream?: (command: RemoteBridgeCommandRequest, context: RemoteCommandStreamContext) => Promise<RemoteBridgeCommandResult>;
    now: () => Date;
    randomBytes: (size: number) => Uint8Array;
    sendSignal: (frame: ConnectSignalFrame) => void;
    onClosed: () => void;
  };
  private transport?: PeerTransport;
  private control?: PeerDataChannel;
  private stream?: PeerDataChannel;
  private crypto?: PeerDataCryptoContext;
  private confirmed = false;
  private closed = false;
  private signalSendQueue = Promise.resolve();
  private controlReceiveQueue = Promise.resolve();
  private streamReceiveQueue = Promise.resolve();
  private controlSendQueue = Promise.resolve();
  private streamSendQueue = Promise.resolve();
  private readonly requests = new Map<string, AbortController>();
  private readonly seenRequestIds = new Set<string>();
  private readonly lifetime = new AbortController();
  private leaseTimer?: ReturnType<typeof setTimeout>;

  constructor(input: ActivePeerSession["input"]) {
    this.input = input;
    this.sessionId = input.sessionId;
  }

  async handleSignal(frame: ConnectSignalFrame): Promise<void> {
    if (this.closed) throw new Error("Peer session is closed.");
    const plaintext = await this.input.signalCrypto.decrypt(frame);
    const decoded = decodeRemotePeerSignal(plaintext);
    if (!decoded.ok) throw new Error(decoded.error.message);
    const signal = decoded.value;
    if (signal.type === "peer.offer") {
      if (this.transport) throw new Error("Peer offer was repeated.");
      const transport = await this.input.peerTransportFactory();
      this.transport = transport;
      try {
        const accepted = await transport.acceptOffer(signal.sdp);
        if (this.closed || this.transport !== transport) throw new Error("Peer session was superseded.");
        await this.sendSignal({ type: "peer.answer", sdp: accepted.answerSdp });
        void transport.waitForChannels(this.lifetime.signal).then(channels => {
          if (this.closed || this.transport !== transport) return;
          this.control = channels.control;
          this.stream = channels.stream;
          this.attachChannels(channels.control, channels.stream);
        }).catch(() => this.close("protocol_error"));
      } catch (error) {
        await this.close("protocol_error");
        throw error;
      }
      return;
    }
    if (signal.type === "peer.ice") {
      if (!this.transport) throw new Error("Peer ICE arrived before the offer.");
      await this.transport.addIceCandidate(signal);
      return;
    }
    if (signal.type === "peer.answer") throw new Error("Browser cannot send a peer answer.");
    await this.close(signal.reason === "expired" ? "protocol_error" : "canceled");
  }

  async close(reason: "canceled" | "replaced" | "protocol_error"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    for (const controller of this.requests.values()) controller.abort(reason);
    this.requests.clear();
    if (this.confirmed && this.crypto && this.control?.readyState === "open") {
      await this.sendEncryptedControl({
        type: "session.close",
        sessionId: this.sessionId,
        reason: reason === "replaced" ? "replaced" : reason === "canceled" ? "canceled" : "protocol_error"
      }).catch(() => undefined);
    }
    this.lifetime.abort(reason);
    this.control?.close();
    this.stream?.close();
    await this.transport?.close().catch(() => undefined);
    this.input.onClosed();
  }

  private attachChannels(control: PeerDataChannel, stream: PeerDataChannel): void {
    control.onMessage(value => {
      this.controlReceiveQueue = this.controlReceiveQueue
        .then(() => this.handleControlData(value))
        .catch(() => this.close("protocol_error"));
    });
    stream.onMessage(value => {
      this.streamReceiveQueue = this.streamReceiveQueue
        .then(() => this.handleUnexpectedStreamData(value))
        .catch(() => this.close("protocol_error"));
    });
    control.onStateChange(state => { if (state === "closed") void this.close("protocol_error"); });
    stream.onStateChange(state => { if (state === "closed") void this.close("protocol_error"); });
  }

  private async handleControlData(raw: PeerData): Promise<void> {
    if (!this.crypto) {
      const text = peerText(raw, 16 * 1024);
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { throw new Error("Peer hello is invalid."); }
      const hello = decodeRemotePeerClientHello(value);
      if (!hello.ok
        || hello.value.sessionId !== this.sessionId
        || hello.value.ticket !== this.input.ticket
        || !samePublicJwk(hello.value.browserAgreementPublicJwk, this.input.ticketClaims.browserAgreementPublicJwk)) {
        throw new Error("Peer hello binding is invalid.");
      }
      this.crypto = await createPeerDataCryptoContext({
        sessionId: this.sessionId,
        ticket: this.input.ticket,
        ticketClaims: this.input.ticketClaims,
        browserNonce: hello.value.browserNonce,
        deviceSigningPrivateKey: this.input.deviceSigningPrivateKey,
        now: this.input.now,
        randomBytes: this.input.randomBytes
      });
      await this.sendPlainControl(JSON.stringify(this.crypto.serverHello));
      return;
    }
    const value = await this.crypto.decrypt("control", typeof raw === "string" ? raw : raw);
    const message = decodeRemoteControlMessage(value);
    if (!message.ok || message.value.sessionId !== this.sessionId) throw new Error("Peer control message is invalid.");
    if (!this.confirmed) {
      if (message.value.type !== "session.confirm" || message.value.transcriptHash !== this.crypto.transcriptHash) throw new Error("Peer did not confirm the signed transcript.");
      this.confirmed = true;
      const workspaces = await this.pathFreeWorkspaces();
      await this.sendEncryptedControl({
        type: "session.ready",
        sessionId: this.sessionId,
        deviceId: this.input.ticketClaims.deviceId,
        transcriptHash: this.crypto.transcriptHash,
        leaseExpiresAt: this.crypto.serverHello.leaseExpiresAt,
        workspaces
      });
      const delayMs = Math.max(1, Date.parse(this.crypto.serverHello.leaseExpiresAt) - this.input.now().getTime());
      this.leaseTimer = setTimeout(() => { void this.closeForExpiredLease(); }, delayMs);
      this.leaseTimer.unref?.();
      return;
    }
    await this.handleConfirmedControl(message.value);
  }

  private async handleConfirmedControl(message: RemoteControlMessage): Promise<void> {
    if (message.type === "session.close") {
      await this.close("canceled");
      return;
    }
    if (message.type === "stream.cancel") {
      const controller = this.requests.get(message.requestId);
      if (controller) controller.abort(message.reason ?? "browser_cancel");
      return;
    }
    if (message.type !== "command.request") throw new Error("Peer sent a server-only control message.");
    if (this.requests.size >= REMOTE_PEER_MAX_ACTIVE_STREAMS
      || this.seenRequestIds.has(message.requestId)
      || this.seenRequestIds.size >= 1_024) {
      await this.sendCommandResult(message, { ok: false, status: 429, error: "Peer command concurrency or identity bound was exceeded." });
      return;
    }
    const deadlineMs = Date.parse(message.deadline);
    if (!Number.isFinite(deadlineMs)
      || deadlineMs <= this.input.now().getTime()
      || deadlineMs > Date.parse(this.crypto!.serverHello.leaseExpiresAt)) {
      await this.sendCommandResult(message, { ok: false, status: 408, error: "Peer command deadline is invalid or expired." });
      return;
    }
    this.seenRequestIds.add(message.requestId);
    const controller = new AbortController();
    this.requests.set(message.requestId, controller);
    const deadlineTimer = setTimeout(() => controller.abort("deadline"), deadlineMs - this.input.now().getTime());
    deadlineTimer.unref?.();
    const command: RemoteBridgeCommandRequest = {
      requestId: message.requestId,
      workspaceId: message.workspaceId,
      command: message.command,
      deadline: message.deadline,
      ...(message.payload === undefined ? {} : { payload: message.payload })
    };
    try {
      if (message.command === "agentSession.events" || message.command === "live.events") {
        await this.runStreamCommand(message, command, controller);
      } else {
        const result = this.input.onCommand
          ? await this.input.onCommand(command)
          : { ok: false, status: 503, error: "Peer command router is unavailable." } as const;
        await this.sendCommandResult(message, result);
      }
    } finally {
      clearTimeout(deadlineTimer);
      this.requests.delete(message.requestId);
    }
  }

  private async runStreamCommand(
    message: Extract<RemoteControlMessage, { type: "command.request" }>,
    command: RemoteBridgeCommandRequest,
    controller: AbortController
  ): Promise<void> {
    const streamId = `stream_${Buffer.from(this.input.randomBytes(18)).toString("base64url")}`;
    await this.sendEncryptedControl({
      type: "command.result",
      sessionId: this.sessionId,
      requestId: message.requestId,
      workspaceId: message.workspaceId,
      status: 202,
      ok: true,
      body: { streamId }
    });
    await this.sendEncryptedStream({ type: "stream.open", sessionId: this.sessionId, requestId: message.requestId, streamId, workspaceId: message.workspaceId });
    let chunkSequence = 0;
    const result = this.input.onCommandStream
      ? await this.input.onCommandStream(command, {
          signal: controller.signal,
          emit: event => {
            chunkSequence += 1;
            void this.sendEncryptedStream({
              type: "stream.chunk",
              sessionId: this.sessionId,
              requestId: message.requestId,
              streamId,
              workspaceId: message.workspaceId,
              chunkSequence,
              event: event.event,
              ...(event.data === undefined ? {} : { data: event.data })
            }).catch(() => controller.abort("stream_send_failed"));
          }
        })
      : { ok: false, status: 503, error: "Peer stream router is unavailable." } as const;
    await this.streamSendQueue;
    await this.sendEncryptedStream({
      type: "stream.end",
      sessionId: this.sessionId,
      requestId: message.requestId,
      streamId,
      workspaceId: message.workspaceId,
      status: result.status,
      ...(!result.ok ? { error: result.error } : {})
    });
  }

  private sendCommandResult(
    message: Extract<RemoteControlMessage, { type: "command.request" }>,
    result: RemoteBridgeCommandResult
  ): Promise<void> {
    return this.sendEncryptedControl({
      type: "command.result",
      sessionId: this.sessionId,
      requestId: message.requestId,
      workspaceId: message.workspaceId,
      status: result.status,
      ok: result.ok,
      ...(result.ok && result.body !== undefined ? { body: result.body } : {}),
      ...(!result.ok ? { error: result.error } : {})
    });
  }

  private async handleUnexpectedStreamData(raw: PeerData): Promise<void> {
    if (!this.confirmed || !this.crypto) throw new Error("Peer stream data arrived before authentication.");
    await this.crypto.decrypt("stream", raw);
    throw new Error("Browser-to-Bridge stream messages are not supported.");
  }

  private sendSignal(value: RemotePeerSignal): Promise<void> {
    const task = this.signalSendQueue.then(async () => {
      const frame = await this.input.signalCrypto.encrypt(value);
      this.input.sendSignal(frame);
    });
    this.signalSendQueue = task.catch(() => undefined);
    return task;
  }

  private sendPlainControl(value: string): Promise<void> {
    if (!this.control) return Promise.reject(new Error("Peer control channel is unavailable."));
    return sendPeerDataWithBackpressure({ channel: this.control, value, signal: this.lifetime.signal });
  }

  private sendEncryptedControl(value: RemoteControlMessage): Promise<void> {
    const task = this.controlSendQueue.then(async () => {
      if (!this.crypto || !this.control) throw new Error("Peer control channel is unavailable.");
      const encrypted = await this.crypto.encrypt("control", value);
      await sendPeerDataWithBackpressure({ channel: this.control, value: encrypted, signal: this.lifetime.signal });
    });
    this.controlSendQueue = task.catch(() => undefined);
    return task;
  }

  private sendEncryptedStream(value: RemoteStreamMessage): Promise<void> {
    const task = this.streamSendQueue.then(async () => {
      if (!this.crypto || !this.stream) throw new Error("Peer stream channel is unavailable.");
      const encrypted = await this.crypto.encrypt("stream", value);
      await sendPeerDataWithBackpressure({ channel: this.stream, value: encrypted, signal: this.lifetime.signal });
    });
    this.streamSendQueue = task.catch(() => undefined);
    return task;
  }

  private async pathFreeWorkspaces(): Promise<RemoteWorkspaceMetadata[]> {
    const listed = await this.input.workspaceService.list();
    if (!listed.ok) throw new Error("Workspace registry is unavailable.");
    return listed.value.flatMap(workspace => workspace.lifecycle === "active"
      && workspace.remoteAccess.enabled
      && workspace.remoteAccess.scopes.includes("remote.access")
      ? [{ workspaceId: workspace.workspaceId, displayName: workspace.displayName, scopes: [...workspace.remoteAccess.scopes] }]
      : []);
  }

  private async closeForExpiredLease(): Promise<void> {
    if (this.closed) return;
    if (this.crypto && this.control?.readyState === "open") {
      await this.sendEncryptedControl({ type: "session.close", sessionId: this.sessionId, reason: "lease_expired" }).catch(() => undefined);
    }
    await this.close("protocol_error");
  }
}

async function pollEnrollment(input: {
  enrollment: Extract<StoredConnectCredential, { state: "enrolling" }>;
  credentialStore: CredentialStore;
  connectApiUrl: string;
  connectWsUrl: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  randomBytes: (size: number) => Uint8Array;
  canceled: () => boolean;
}): Promise<void> {
  let interval = input.enrollment.interval;
  while (!input.canceled() && input.now().getTime() < Date.parse(input.enrollment.expiresAt)) {
    await input.sleep(interval * 1_000);
    if (input.canceled()) return;
    const endpoint = new URL("/v1/device-enrollment-tokens", input.connectApiUrl);
    const dpop = await createDpopProof({
      method: "POST",
      url: endpoint.toString(),
      signingPrivateKey: input.enrollment.signingPrivateKey,
      signingPublicKey: input.enrollment.signingPublicKey,
      now: input.now(),
      randomBytes: input.randomBytes
    });
    const response = await input.fetchImpl(endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", dpop },
      body: JSON.stringify({ enrollmentId: input.enrollment.enrollmentId, deviceCode: input.enrollment.deviceCode }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) {
      const token = parseDeviceToken(await response.json().catch(() => undefined));
      await input.credentialStore.write({ connect: registeredFromToken(input.enrollment, token, input.connectWsUrl, input.now()) });
      return;
    }
    const body = await response.json().catch(() => undefined);
    const code = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval = Math.min(30, interval + 5);
      continue;
    }
    if (code === "expired_token" || code === "access_denied") return;
    if (response.status >= 500) continue;
    return;
  }
}

async function refreshIfNeeded(input: {
  credential: Extract<StoredConnectCredential, { state: "registered" }>;
  credentialStore: CredentialStore;
  connectApiUrl: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  secureRandom: (size: number) => Uint8Array;
}): Promise<Extract<StoredConnectCredential, { state: "registered" }>> {
  if (Date.parse(input.credential.expiresAt) > input.now().getTime() + 60_000) return input.credential;
  const endpoint = new URL("/v1/device-tokens", input.connectApiUrl);
  const dpop = await createDpopProof({
    method: "POST",
    url: endpoint.toString(),
    signingPrivateKey: input.credential.signingPrivateKey,
    signingPublicKey: input.credential.signingPublicKey,
    now: input.now(),
    randomBytes: input.secureRandom
  });
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", dpop },
    body: JSON.stringify({ refreshToken: input.credential.refreshToken }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new BridgeError("ACCOUNT_LOGIN_REQUIRED", "Hunsu Connect device credentials could not be refreshed.");
  const token = parseDeviceToken(await response.json().catch(() => undefined));
  if (token.deviceId !== input.credential.deviceId || token.accountId !== input.credential.accountId) throw new Error("Refreshed Connect credential binding changed.");
  const refreshed: Extract<StoredConnectCredential, { state: "registered" }> = {
    ...input.credential,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(input.now().getTime() + token.expiresIn * 1_000).toISOString()
  };
  await input.credentialStore.write({ connect: refreshed });
  return refreshed;
}

export async function createDpopProof(input: {
  method: string;
  url: string;
  signingPrivateKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
  accessToken?: string;
  now: Date;
  randomBytes: (size: number) => Uint8Array;
}): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: canonicalPublicJwk(input.signingPublicKey) };
  const payload = {
    jti: Buffer.from(input.randomBytes(24)).toString("base64url"),
    htm: input.method.toUpperCase(),
    htu: dpopTargetUrl(input.url),
    iat: Math.floor(input.now.getTime() / 1_000),
    ...(input.accessToken ? { ath: base64Url(await webcrypto.subtle.digest("SHA-256", utf8(input.accessToken))) } : {})
  };
  const protectedHeader = base64Url(utf8(JSON.stringify(header)));
  const encodedPayload = base64Url(utf8(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("jwk", privateJwk(input.signingPrivateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${protectedHeader}.${encodedPayload}`));
  return `${protectedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

async function registeredCredential(store: CredentialStore): Promise<Extract<StoredConnectCredential, { state: "registered" }>> {
  const credentials = await store.read();
  if (!credentials?.connect || credentials.connect.state !== "registered") {
    throw new BridgeError("ACCOUNT_LOGIN_REQUIRED", "Enroll this Bridge with Hunsu Connect before enabling Remote access.");
  }
  return credentials.connect;
}

function registeredFromToken(
  enrollment: Extract<StoredConnectCredential, { state: "enrolling" }>,
  token: ConnectDeviceTokenResponse,
  connectWsUrl: string,
  now: Date
): Extract<StoredConnectCredential, { state: "registered" }> {
  return {
    signingPrivateKey: enrollment.signingPrivateKey,
    signingPublicKey: enrollment.signingPublicKey,
    agreementPrivateKey: enrollment.agreementPrivateKey,
    agreementPublicKey: enrollment.agreementPublicKey,
    state: "registered",
    deviceId: token.deviceId,
    accountId: token.accountId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(now.getTime() + token.expiresIn * 1_000).toISOString(),
    connectWsUrl
  };
}

function parseEnrollmentCreated(value: unknown, now: Date): ConnectEnrollmentCreated {
  if (!isRecord(value)
    || value.schema !== "hunsu.connect.enrollment-created.v1"
    || !boundedText(value.enrollmentId, 256)
    || !boundedText(value.deviceCode, 512)
    || !boundedText(value.userCode, 64)
    || !Number.isInteger(value.expiresIn)
    || Number(value.expiresIn) < 60
    || Number(value.expiresIn) > 900
    || !Number.isInteger(value.interval)
    || Number(value.interval) < 1
    || Number(value.interval) > 30) throw new Error("Connect enrollment response is invalid.");
  const verificationUri = securePublicUrl(value.verificationUri);
  const verificationUriComplete = securePublicUrl(value.verificationUriComplete);
  if (new URL(verificationUri).origin !== new URL(verificationUriComplete).origin) throw new Error("Connect verification origins do not match.");
  void now;
  return {
    schema: "hunsu.connect.enrollment-created.v1",
    enrollmentId: value.enrollmentId,
    deviceCode: value.deviceCode,
    userCode: value.userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: Number(value.expiresIn),
    interval: Number(value.interval)
  };
}

function parseDeviceToken(value: unknown): ConnectDeviceTokenResponse {
  if (!isRecord(value)
    || value.schema !== "hunsu.connect.device-token.v1"
    || value.tokenType !== "DPoP"
    || !boundedText(value.accessToken, 8 * 1024)
    || !boundedText(value.refreshToken, 8 * 1024)
    || !boundedText(value.deviceId, 256)
    || !boundedText(value.accountId, 256)
    || value.expiresIn !== 300) throw new Error("Connect device token response is invalid.");
  return value as ConnectDeviceTokenResponse;
}

function isConnectControlFrame(value: unknown): value is ConnectServerControlFrame {
  if (!isRecord(value) || value.schema !== CONNECT_CONTROL_FRAME_SCHEMA || typeof value.type !== "string") return false;
  if (value.type === "connect.authenticated") return exactKeys(value, ["schema", "type", "deviceId", "accountId", "expiresAt"])
    && boundedText(value.deviceId, 256) && boundedText(value.accountId, 256) && validTimestamp(value.expiresAt);
  if (value.type === "connect.session") return exactKeys(value, ["schema", "type", "sessionId", "ticket", "expiresAt"])
    && boundedText(value.sessionId, 256) && boundedText(value.ticket, 8 * 1024) && validTimestamp(value.expiresAt);
  if (value.type === "connect.ready") return exactKeys(value, ["schema", "type", "sessionId"]) && boundedText(value.sessionId, 256);
  if (value.type === "connect.closed") return exactKeys(value, ["schema", "type", "sessionId", "reason"])
    && boundedText(value.sessionId, 256)
    && (value.reason === "expired" || value.reason === "replaced" || value.reason === "revoked" || value.reason === "peer_disconnected" || value.reason === "protocol_error");
  return false;
}

function parseSocketJson(raw: unknown): unknown {
  const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw).toString("utf8") : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8") : undefined;
  if (!text || Buffer.byteLength(text, "utf8") > 128 * 1024) throw new Error("Connect frame is invalid or too large.");
  try { return JSON.parse(text) as unknown; } catch { throw new Error("Connect frame is not valid JSON."); }
}

async function waitForSocketOpen(socket: ConnectSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Connect WebSocket open timed out.")), timeoutMs);
    timeout.unref?.();
    const onOpen = () => finish();
    const onFailure = () => finish(new Error("Connect WebSocket could not open."));
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onFailure);
    socket.addEventListener("error", onFailure);
    function finish(error?: Error): void {
      clearTimeout(timeout);
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("close", onFailure);
      socket.removeEventListener?.("error", onFailure);
      if (error) reject(error);
      else resolve();
    }
  });
}

async function defaultConnectSocketFactory(input: { url: string; headers: Readonly<Record<string, string>> }): Promise<ConnectSocket> {
  const module = await import("ws") as unknown as { WebSocket: new (url: string, options: { headers: Readonly<Record<string, string>> }) => ConnectSocket };
  return new module.WebSocket(input.url, { headers: input.headers });
}

function samePublicJwk(left: JsonWebKey, right: JsonWebKey): boolean {
  const a = canonicalPublicJwk(left);
  const b = canonicalPublicJwk(right);
  return a.x === b.x && a.y === b.y;
}

function peerText(raw: PeerData, maxBytes: number): string {
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Peer plaintext frame is too large.");
  return text;
}

function safeDeviceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Bridge device name is invalid.");
  return name;
}

function secureHttpBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new Error("Connect API URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Connect API URL is invalid.");
  return url.toString();
}

function secureWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname))) throw new Error("Connect WebSocket URL must use WSS.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Connect WebSocket URL is invalid.");
  return url.toString();
}

function securePublicUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Connect verification URL is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new Error("Connect verification URL must use HTTPS.");
  if (url.username || url.password || url.hash) throw new Error("Connect verification URL is invalid.");
  return url.toString();
}

function dpopTargetUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.hash = "";
  return url.toString();
}

function privateJwk(value: JsonWebKey): JsonWebKey {
  if (!boundedText(value.d, 128)) throw new Error("Device signing private key is invalid.");
  const publicPart = canonicalPublicJwk({ kty: value.kty, crv: value.crv, x: value.x, y: value.y });
  return { ...publicPart, d: value.d, ext: true };
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTimestamp(value: unknown): value is string {
  return boundedText(value, 64) && Number.isFinite(Date.parse(value));
}

function isLoopback(hostnameValue: string): boolean {
  return hostnameValue === "localhost" || hostnameValue === "127.0.0.1" || hostnameValue === "[::1]" || hostnameValue === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
