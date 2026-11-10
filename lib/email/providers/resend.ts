/**
 * EMAIL_PROVIDER=resend — plain HTTPS to the Resend Email API (no SDK, so
 * the dependency surface stays one small adapter). Requires RESEND_API_KEY
 * and a verified sending domain on the Resend account.
 *
 * Inline images ride as base64 attachments with content_id — the same CID
 * scheme the SMTP adapter uses, so the template only ever knows `cid:…`.
 * https://resend.com/docs/dashboard/emails/embed-inline-images.md
 */
import { EmailSendError, type EmailMessage, type EmailProvider, type EmailSendResult } from "../types";

const RESEND_API_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 30_000;

export interface ResendProviderConfig {
  apiKey: string;
  from: string;
}

interface ResendAttachment {
  content: string; // base64
  filename: string;
  content_type?: string;
  content_id?: string;
}

function buildAttachments(message: EmailMessage): ResendAttachment[] | undefined {
  const attachments: ResendAttachment[] = [
    ...(message.inlineImages ?? []).map((image) => ({
      content: image.content.toString("base64"),
      filename: image.filename,
      content_type: image.contentType,
      content_id: image.cid,
    })),
    ...(message.attachments ?? []).map((attachment) => ({
      content: attachment.content.toString("base64"),
      filename: attachment.filename,
      content_type: attachment.contentType,
    })),
  ];
  return attachments.length > 0 ? attachments : undefined;
}

export function createResendProvider(config: ResendProviderConfig): EmailProvider {
  return {
    id: "resend",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      let response: Response;
      try {
        response = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: buildAttachments(message),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new EmailSendError(
          "EMAIL_SEND_FAILED",
          "Could not reach the email service. Try again shortly.",
        );
      }

      if (!response.ok) {
        // Detail is logged server-side only — never returned to the client.
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        console.warn(`[email:resend] HTTP ${response.status}: ${detail}`);

        if (response.status === 429) {
          const header = Number(response.headers.get("retry-after"));
          const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : 60;
          throw new EmailSendError(
            "EMAIL_RATE_LIMITED",
            "The email service is rate limiting requests. Try again in a few minutes.",
            429,
            retryAfterSeconds,
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new EmailSendError(
            "EMAIL_SEND_FAILED",
            "The email service rejected the credentials (RESEND_API_KEY).",
          );
        }
        throw new EmailSendError(
          "EMAIL_SEND_FAILED",
          "The email service rejected the message. Try again shortly.",
        );
      }

      const data = (await response.json().catch(() => ({}))) as { id?: string };
      return { provider: "resend", messageId: data.id || "resend-accepted" };
    },
  };
}
