/**
 * Shared contract for the email-report delivery layer (/api/compare/email).
 *
 * Server-only: SMTP/Resend credentials come from getServerEnv() and these
 * modules must never be imported by client components — nothing here carries
 * secrets, but the providers that consume it do.
 */

export type EmailProviderId = "console" | "smtp" | "resend";

export interface EmailAttachment {
  filename: string;
  /** Raw bytes (e.g. events.csv). */
  content: Buffer;
  contentType: string;
}

export interface EmailInlineImage {
  /** CID referenced from the HTML as src="cid:…" (no brackets, <128 chars). */
  cid: string;
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  /** Single line — callers must strip CR/LF before building the message. */
  subject: string;
  html: string;
  /** Plain-text alternative (parity is unit-tested against the HTML). */
  text: string;
  attachments?: EmailAttachment[];
  inlineImages?: EmailInlineImage[];
}

export interface EmailSendResult {
  provider: EmailProviderId;
  /** Provider message id or preview path — never contains the recipient. */
  messageId: string;
}

export interface EmailProvider {
  readonly id: EmailProviderId;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Contract error codes for /api/compare/email (documented in README). */
export type EmailErrorCode =
  | "EMAIL_DISABLED"
  | "EMAIL_INVALID"
  | "EMAIL_RATE_LIMITED"
  | "EMAIL_CAPTCHA_FAILED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_ANALYSIS_FAILED";

/**
 * Carries the { status, code } API contract so errorResponse() maps it the
 * same way as apiError(); retryAfterSeconds feeds a Retry-After header.
 */
export class EmailSendError extends Error {
  readonly status: number;
  readonly code: EmailErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: EmailErrorCode, message: string, status = 502, retryAfterSeconds?: number) {
    super(message);
    // `extends Error` under ES5 transpile (tsconfig.test.json) returns a bare
    // Error from super() — restore the prototype so instanceof keeps working.
    Object.setPrototypeOf(this, EmailSendError.prototype);
    this.name = "EmailSendError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
