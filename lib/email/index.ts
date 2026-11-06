/**
 * Email delivery factory for the report feature. Server-only — import this
 * from API routes and scripts, never from client components.
 *
 * EMAIL_PROVIDER selects the backend:
 *   console (default) — writes previews to .email-preview/, never sends
 *   smtp              — any SMTP server (Nodemailer)
 *   resend            — Resend HTTP API
 */
import { getServerEnv, type ServerEnv } from "../env";
import { EmailSendError, type EmailProvider } from "./types";
import { createConsoleProvider } from "./providers/console";
import { createResendProvider } from "./providers/resend";
import { createSmtpProvider } from "./providers/smtp";

export * from "./types";
export {
  EMAIL_MAX_LENGTH,
  emailAddressOf,
  emailHash,
  isValidEmail,
  isValidFromField,
  maskEmail,
  normalizeEmail,
} from "./address";

/** True when this deployment can actually deliver mail (console = previews only). */
export function emailDeliveryEnabled(env: ServerEnv = getServerEnv()): boolean {
  return env.EMAIL_PROVIDER !== "console";
}

/**
 * Canonical site origin for deep links inside emails (scheme + host only —
 * never a path from NEXT_PUBLIC_SITE_URL). Null when unset/unparseable.
 */
export function siteUrl(env: ServerEnv = getServerEnv()): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Throws EMAIL_DISABLED when delivery is impossible — console provider in a
 * production build (dev keeps the .email-preview workflow), missing
 * NEXT_PUBLIC_SITE_URL/EMAIL_FROM, or an incomplete provider config. The
 * route calls this before spending any analysis work.
 */
export function assertEmailReady(env: ServerEnv = getServerEnv()): void {
  const isConsole = env.EMAIL_PROVIDER === "console";
  if (isConsole && process.env.NODE_ENV === "production") {
    throw new EmailSendError(
      "EMAIL_DISABLED",
      "Email sending is disabled on this deployment (EMAIL_PROVIDER=console).",
      503,
    );
  }
  if (!siteUrl(env)) {
    throw new EmailSendError(
      "EMAIL_DISABLED",
      "Email sending is not configured (NEXT_PUBLIC_SITE_URL is missing).",
      503,
    );
  }
  if (!isConsole && !env.EMAIL_FROM) {
    throw new EmailSendError(
      "EMAIL_DISABLED",
      "Email sending is not configured (EMAIL_FROM is missing).",
      503,
    );
  }
  if (env.EMAIL_PROVIDER === "smtp" && !env.SMTP_HOST) {
    throw new EmailSendError(
      "EMAIL_DISABLED",
      "Email sending is not configured (SMTP_HOST is missing).",
      503,
    );
  }
  if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    throw new EmailSendError(
      "EMAIL_DISABLED",
      "Email sending is not configured (RESEND_API_KEY is missing).",
      503,
    );
  }
}

/** Builds the configured provider (throws EMAIL_DISABLED when incomplete). */
export function getEmailProvider(env: ServerEnv = getServerEnv()): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case "smtp":
      assertEmailReady(env);
      return createSmtpProvider({
        host: env.SMTP_HOST as string,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.EMAIL_FROM as string,
      });
    case "resend":
      assertEmailReady(env);
      return createResendProvider({
        apiKey: env.RESEND_API_KEY as string,
        from: env.EMAIL_FROM as string,
      });
    case "console":
      return createConsoleProvider({
        from: env.EMAIL_FROM || "Rajasthan Imagery Explorer <preview@localhost>",
      });
  }
}
