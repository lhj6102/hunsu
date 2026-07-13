import { DurableObject } from "cloudflare:workers";
import {
  decodePendingAuthorizationCode,
  encodePendingAuthorizationCode,
  type ConsentState,
  type PendingAuthorizationCode
} from "../auth/ephemeral-store.ts";

type RecordKind =
  | "consent"
  | "authorization_code"
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

  async #scheduleExpiry(expiresAt: number): Promise<void> {
    await this.ctx.storage.setAlarm(expiresAt * 1000);
  }
}
