/**
 * EMAIL_PROVIDER=smtp — Nodemailer over any standard SMTP server (Gmail
 * app passwords, Brevo, institutional/gov relays). Works on Vercel
 * serverless: 465 (implicit TLS) and 587 (STARTTLS) both reach out on
 * the public internet from the function.
 *
 * Credentials are read from getServerEnv() by the factory — never logged,
 * never bundled (no NEXT_PUBLIC_ prefix).
 */
import nodemailer from "nodemailer";
import { EmailSendError, type EmailMessage, type EmailProvider, type EmailSendResult } from "../types";

export interface SmtpProviderConfig {
  host: string;
  port: number;
  /** true = implicit TLS (usually port 465); false = STARTTLS (587). */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Maps nodemailer failures onto the API contract without leaking banners/credentials. */
function smtpError(error: unknown): EmailSendError {
  const err = error as { code?: string; responseCode?: number };
  const code = typeof err?.code === "string" ? err.code : "";
  const responseCode = typeof err?.responseCode === "number" ? err.responseCode : 0;

  if (code === "EAUTH") {
    return new EmailSendError(
      "EMAIL_SEND_FAILED",
      "SMTP authentication failed — check SMTP_USER and SMTP_PASS.",
    );
  }
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNREFUSED") {
    return new EmailSendError(
      "EMAIL_SEND_FAILED",
      "Could not reach the mail server. Try again shortly.",
    );
  }
  // 4xx SMTP replies are temporary (rate limits, greylisting, full queues).
  if (responseCode >= 400 && responseCode < 500) {
    return new EmailSendError(
      "EMAIL_RATE_LIMITED",
      `The mail server deferred the message (${responseCode}). Try again in a few minutes.`,
      429,
      300,
    );
  }
  return new EmailSendError(
    "EMAIL_SEND_FAILED",
    "The mail server rejected the message. Try again shortly.",
  );
}

export function createSmtpProvider(config: SmtpProviderConfig): EmailProvider {
  return {
    id: "smtp",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });

      try {
        const info = await transport.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          attachments: [
            ...(message.inlineImages ?? []).map((image) => ({
              filename: image.filename,
              content: image.content,
              cid: image.cid,
              contentType: image.contentType,
              contentDisposition: "inline" as const,
            })),
            ...(message.attachments ?? []).map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              contentType: attachment.contentType,
            })),
          ],
        });
        return { provider: "smtp", messageId: info.messageId || "smtp-accepted" };
      } catch (error) {
        throw smtpError(error);
      } finally {
        // No-op without a pool, but keeps connections from lingering when one exists.
        transport.close();
      }
    },
  };
}
