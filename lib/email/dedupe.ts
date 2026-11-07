/**
 * Send-once guard for /api/compare/email: the same report (identical
 * analysis + language + content flags + recipient) that went out within the
 * last 10 minutes is not sent again — the route answers202 with
 * `alreadySent: true` and consumes no quota.
 *
 * In-memory per process behind a globalThis singleton (like the daily
 * quotas); a durable cross-instance store (Upstash/Vercel KV) is the
 * documented upgrade path if duplicate suppression must survive instance
 * rotation or cold starts.
 */
import { createHash } from "node:crypto";
import { sharedInstance } from "../singleton";

/** Suppression window for an identical send (ms). */
export const EMAIL_DEDUPE_WINDOW_MS = 10 * 60_000;

type SentLog = Map<string, number>; // idempotency key → sentAt (epoch ms)

const sentLog = sharedInstance<SentLog>("rse.emailSentLog", () => new Map());

export interface EmailSendKeyInput {
  /** Body params — already validated by compareParamsSchema. */
  params: {
    areaId: string;
    level: string;
    dateA: string;
    dateB: string;
    sensitivity: string;
    minPatchHa: number;
    inputMode: "single" | "composite";
    compositeWindowDays: number;
  };
  language: "en" | "hi";
  includeSummary: boolean;
  includeImage: boolean;
  /** Server CHANGE_ENGINE — v1 forces single-date inputs, so the key must too. */
  engine: string;
  /** Hashed recipient (sha256) — open mode must not dedupe across mailboxes. */
  recipientHash: string;
}

/**
 * Idempotency key: validated analysis params (dates normalised A-first, the
 * same engine/input-mode rules resolveCompareParams applies) + language +
 * content flags + recipient. Hashed so the raw address never lands in memory
 * keys or logs.
 */
export function emailSendKey(input: EmailSendKeyInput): string {
  const { params } = input;
  const [dateA, dateB] =
    params.dateA < params.dateB ? [params.dateA, params.dateB] : [params.dateB, params.dateA];
  const inputMode = input.engine === "v2" ? params.inputMode : "single";
  const compositeWindowDays = inputMode === "composite" ? params.compositeWindowDays : 0;
  const payload = JSON.stringify([
    params.areaId,
    params.level,
    dateA,
    dateB,
    params.sensitivity,
    params.minPatchHa,
    input.engine,
    inputMode,
    compositeWindowDays,
    input.language,
    input.includeSummary ? 1 : 0,
    input.includeImage ? 1 : 0,
    input.recipientHash,
  ]);
  return createHash("sha256").update(`rse-email-send-v1:${payload}`).digest("hex").slice(0, 32);
}

/** True when this key already produced a send inside the window (prunes old entries). */
export function emailWasRecentlySent(key: string, now = Date.now()): boolean {
  pruneSentLog(now);
  const sentAt = sentLog.get(key);
  return sentAt !== undefined && now - sentAt < EMAIL_DEDUPE_WINDOW_MS;
}

/** Records a successful send (called only after the provider accepted it). */
export function emailMarkSent(key: string, now = Date.now()): void {
  pruneSentLog(now);
  sentLog.set(key, now);
}

function pruneSentLog(now: number): void {
  sentLog.forEach((sentAt, key) => {
    if (now - sentAt >= EMAIL_DEDUPE_WINDOW_MS) sentLog.delete(key);
  });
}
