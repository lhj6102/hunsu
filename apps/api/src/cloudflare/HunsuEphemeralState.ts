import { DurableObject } from "cloudflare:workers";
import {
  cloneRefreshGrant,
  decodePendingAuthorizationCode,
  decodeRefreshGrant,
  decodeRefreshGrantRotation,
  encodePendingAuthorizationCode,
  encodeRefreshGrant,
  type ConsentState,
  type PendingAuthorizationCode,
  type RefreshGrant,
  type RefreshGrantRotation,
  type RefreshGrantRotationResult
} from "../auth/ephemeral-store.ts";

type RecordKind =
  | "consent"
  | "authorization_code"
  | "refresh_grant"
  | "webhook_processing"
  | "webhook_completed";
type StoredRow = { kind: string; payload: string | null; expires_at: number };
type ConsumedRow = Readonly<{ row: StoredRow | undefined; removed: boolean }>;

export class HunsuEphemeralState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ephemeral_record (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          kind TEXT NOT NULL,
          payload TEXT,
          expires_at INTEGER NOT NULL
        )
      `);
    });
  }

  async createConsent(input: ConsentState): Promise<void> {
    this.#replace("consent", null, input.expiresAt);
    await this.#scheduleExpiry(input.expiresAt);
  }

  async consumeConsent(now: number): Promise<boolean> {
    const consumed = this.#consume("consent", now);
    if (consumed.removed) await this.ctx.storage.deleteAlarm();
    return consumed.row !== undefined;
  }

  async createAuthorizationCode(input: PendingAuthorizationCode): Promise<void> {
    this.#replace(
      "authorization_code",
      JSON.stringify(encodePendingAuthorizationCode(input)),
      input.expiresAt
    );
    await this.#scheduleExpiry(input.expiresAt);
  }

  async consumeAuthorizationCode(now: number): Promise<PendingAuthorizationCode | undefined> {
    const consumed = this.#consume("authorization_code", now);
    if (consumed.removed) await this.ctx.storage.deleteAlarm();
    if (!consumed.row?.payload) return undefined;
    try {
      const decoded = decodePendingAuthorizationCode(JSON.parse(consumed.row.payload) as unknown);
      return decoded.ok ? decoded.value : undefined;
    } catch {
      return undefined;
    }
  }

  async createRefreshGrant(input: unknown, now: number): Promise<boolean> {
    const decoded = decodeRefreshGrant(input);
    if (!decoded.ok || decoded.value.expiresAt <= now) return false;
    const current = this.#read();
    if (current && current.expires_at > now) return false;
    if (current) this.#delete();
    const grant = decoded.value;
    this.#replace(
      "refresh_grant",
      JSON.stringify(encodeRefreshGrant(grant)),
      grant.expiresAt
    );
    await this.#scheduleExpiry(grant.expiresAt);
    return true;
  }

  async rotateRefreshGrant(input: unknown, now: number): Promise<RefreshGrantRotationResult> {
    const rotationResult = decodeRefreshGrantRotation(input);
    if (!rotationResult.ok) return { status: "invalid" };
    const rotation = rotationResult.value;
    const row = this.#read();
    if (!row) return { status: "missing" };
    if (row.kind !== "refresh_grant" || !row.payload) {
      this.#delete();
      await this.ctx.storage.deleteAlarm();
      return { status: "corrupt" };
    }
    if (row.expires_at <= now) {
      this.#delete();
      await this.ctx.storage.deleteAlarm();
      return { status: "expired" };
    }
    const grant = decodeRefreshGrantPayload(row.payload);
    if (!grant) {
      this.#delete();
      await this.ctx.storage.deleteAlarm();
      return { status: "corrupt" };
    }
    if (grant.expiresAt <= now) {
      this.#delete();
      await this.ctx.storage.deleteAlarm();
      return { status: "expired" };
    }
    if (grant.status === "revoked") return { status: "revoked" };
    if (!rotationBindingsMatch(grant, rotation)) return { status: "invalid" };
    if (rotation.presentedGeneration < grant.currentGeneration) {
      this.#storeRefreshGrant({ ...grant, status: "revoked" });
      return { status: "replayed" };
    }
    if (rotation.presentedGeneration !== grant.currentGeneration
      || rotation.presentedTokenDigest !== grant.currentTokenDigest) {
      return { status: "invalid" };
    }
    const rotated = cloneRefreshGrant({
      ...grant,
      currentGeneration: rotation.nextGeneration,
      currentTokenDigest: rotation.nextTokenDigest
    });
    this.#storeRefreshGrant(rotated);
    return { status: "rotated", grant: cloneRefreshGrant(rotated) };
  }

  async claimWebhookDelivery(expiresAt: number, now: number): Promise<boolean> {
    if (expiresAt <= now) return false;
    const current = this.#read();
    if (current && current.expires_at > now) return false;
    this.#replace("webhook_processing", null, expiresAt);
    await this.#scheduleExpiry(expiresAt);
    return true;
  }

  async completeWebhookDelivery(
    leaseExpiresAt: number,
    completedExpiresAt: number,
    now: number
  ): Promise<boolean> {
    const current = this.#read();
    if (!current
      || current.kind !== "webhook_processing"
      || current.expires_at !== leaseExpiresAt) {
      return false;
    }
    if (current.expires_at <= now) {
      this.#delete();
      await this.ctx.storage.deleteAlarm();
      return false;
    }
    if (completedExpiresAt <= now) return false;
    this.#replace("webhook_completed", null, completedExpiresAt);
    await this.#scheduleExpiry(completedExpiresAt);
    return true;
  }

  async releaseWebhookDelivery(leaseExpiresAt: number): Promise<boolean> {
    const current = this.#read();
    if (current?.kind !== "webhook_processing" || current.expires_at !== leaseExpiresAt) {
      return false;
    }
    this.#delete();
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async alarm(): Promise<void> {
    const row = this.#read();
    if (row && row.expires_at <= Math.floor(Date.now() / 1000)) this.#delete();
  }

  #read(): StoredRow | undefined {
    return this.ctx.storage.sql.exec<StoredRow>(
      "SELECT kind, payload, expires_at FROM ephemeral_record WHERE singleton = 1"
    ).toArray()[0];
  }

  #consume(kind: RecordKind, now: number): ConsumedRow {
    const row = this.#read();
    if (!row || row.kind !== kind || row.expires_at <= now) {
      if (row && row.expires_at <= now) {
        this.#delete();
        return { row: undefined, removed: true };
      }
      return { row: undefined, removed: false };
    }
    this.#delete();
    return { row, removed: true };
  }

  #replace(kind: RecordKind, payload: string | null, expiresAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ephemeral_record (singleton, kind, payload, expires_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         kind = excluded.kind,
         payload = excluded.payload,
         expires_at = excluded.expires_at`,
      kind,
      payload,
      expiresAt
    );
  }

  #delete(): void {
    this.ctx.storage.sql.exec("DELETE FROM ephemeral_record WHERE singleton = 1");
  }

  #storeRefreshGrant(input: RefreshGrant): void {
    this.#replace(
      "refresh_grant",
      JSON.stringify(encodeRefreshGrant(input)),
      input.expiresAt
    );
  }

  async #scheduleExpiry(expiresAt: number): Promise<void> {
    await this.ctx.storage.setAlarm(expiresAt * 1000);
  }
}

function decodeRefreshGrantPayload(payload: string): RefreshGrant | undefined {
  try {
    const decoded = decodeRefreshGrant(JSON.parse(payload) as unknown);
    return decoded.ok ? decoded.value : undefined;
  } catch {
    return undefined;
  }
}

function rotationBindingsMatch(
  grant: RefreshGrant,
  input: RefreshGrantRotation
): boolean {
  return grant.familyId === input.familyId
    && grant.clientDigest === input.clientDigest
    && grant.scope === input.scope
    && grant.audience === input.audience;
}
