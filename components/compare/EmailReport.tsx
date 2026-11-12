"use client";

/**
 * "Send report to mail" button in the results header + the dialog that POSTs
 * /api/compare/email. Capability comes from the public config endpoint
 * (same assertEmailReady as the route): a console provider in production or
 * any incomplete setup hides the button instead of offering a submit that
 * would 503.
 *
 * Two dialog shapes:
 *   fixed (EMAIL_FIXED_RECIPIENT) — confirm-only: "This comparison will be
 *     emailed to {recipientHint}." with language/options/captcha; no email
 *     input, and the request body never carries an `email` field.
 *   open — the classic dialog with a typed address.
 * Params are rebuilt from the displayed result's metadata — the exact field
 * set every cache-backed compare route derives keys from — so the emailed
 * analysis always matches what the user is looking at.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  Clock,
  Image as ImageIcon,
  Languages,
  Loader2,
  Mail,
  Sparkles,
  X,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import TurnstileWidget from "@/components/ui/TurnstileWidget";
import { cn } from "@/components/ui/cn";
import type { SummaryLanguage } from "@/lib/analysis/types";
import { analysisParamsFromMetadata } from "@/lib/compare/params";
import { isValidEmail, maskEmail } from "@/lib/email/addressCore";
import { useCompareStore } from "@/store/useCompareStore";

interface EmailConfig {
  enabled: boolean;
  mode: "fixed" | "open";
  /** Masked recipient (m***@gmail.com) in fixed mode; null in open mode. */
  recipientHint: string | null;
  summaryAvailable: boolean;
  captchaRequired: boolean;
  dailyCapReached: boolean;
  provider: "console" | "smtp" | "resend";
  turnstileSiteKey: string | null;
}

/** Survives drawer close/reopen within a session; failures are not cached. */
let configCache: EmailConfig | null = null;

async function loadEmailConfig(): Promise<EmailConfig | null> {
  if (configCache) return configCache;
  // Retry: the first drawer open can race a dev-server recompile, and a
  // non-OK/HTML response resolves without a network error (silent null).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/compare/email/config");
      if (response.ok) {
        const payload = (await response.json()) as Partial<EmailConfig>;
        if (typeof payload.enabled === "boolean") {
          const config: EmailConfig = {
            enabled: payload.enabled,
            mode: payload.mode === "fixed" ? "fixed" : "open",
            recipientHint:
              typeof payload.recipientHint === "string" ? payload.recipientHint : null,
            summaryAvailable: payload.summaryAvailable === true,
            captchaRequired: payload.captchaRequired === true,
            dailyCapReached: payload.dailyCapReached === true,
            provider:
              payload.provider === "smtp" || payload.provider === "resend"
                ? payload.provider
                : "console",
            turnstileSiteKey:
              typeof payload.turnstileSiteKey === "string" ? payload.turnstileSiteKey : null,
          };
          configCache = config;
          return config;
        }
      }
      console.warn(`email config: unexpected response (HTTP ${response.status})`);
    } catch (error) {
      console.warn(`email config: fetch failed (${error instanceof Error ? error.message : error})`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return null;
}

const FALLBACK_MESSAGES: Record<string, string> = {
  EMAIL_INVALID: "Enter a valid email address.",
  EMAIL_RATE_LIMITED: "The daily report limit has been reached. Try again later.",
  EMAIL_CAPTCHA_FAILED: "Captcha verification failed. Try again.",
  EMAIL_SEND_FAILED: "The mail server rejected the request. Try again shortly.",
  EMAIL_DISABLED: "Email sending isn't configured on this deployment.",
  EMAIL_ANALYSIS_FAILED:
    "This analysis couldn't be rebuilt for the report. Re-run the comparison and try again.",
};

function messageFor(code: string | null, serverMessage: string | null): string {
  if (serverMessage) return serverMessage;
  if (code && FALLBACK_MESSAGES[code]) return FALLBACK_MESSAGES[code]!;
  return "Sending the report failed. Try again.";
}

/** Client-side cooldown after any send (fresh or duplicate) — ms. */
const SEND_COOLDOWN_MS = 30_000;

type DialogStatus = "idle" | "sending" | "success" | "alreadySent" | "error";

export default function EmailReport() {
  const running = useCompareStore((s) => s.running);
  const [config, setConfig] = useState<EmailConfig | null>(configCache);
  const [open, setOpen] = useState(false);
  // Cooldown lives here (not in the dialog) so it survives close/reopen.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const handleClose = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (configCache) {
      setConfig(configCache);
      return;
    }
    let alive = true;
    void loadEmailConfig().then((value) => {
      if (alive && value) setConfig(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!config?.enabled) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Send report to mail"
        title={running ? "Wait for the analysis to finish" : "Send report to mail"}
        disabled={running}
        onClick={() => setOpen(true)}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Mail size={14} aria-hidden />
        {/* Icon-only below the @sm container width — the title stays as tooltip. */}
        <span className="hidden @sm:block">Send report to mail</span>
      </button>
      {open && (
        <EmailDialog
          config={config}
          cooldownUntil={cooldownUntil}
          onSent={() => setCooldownUntil(Date.now() + SEND_COOLDOWN_MS)}
          onClose={handleClose}
        />
      )}
    </>
  );
}

function EmailDialog({
  config,
  cooldownUntil,
  onSent,
  onClose,
}: {
  config: EmailConfig;
  cooldownUntil: number;
  onSent: () => void;
  onClose: () => void;
}) {
  const result = useCompareStore((s) => s.result);
  const defaultLanguage = useCompareStore((s) => s.summaryLanguage);
  const fixed = config.mode === "fixed";
  const recipientHint = config.recipientHint ?? "the configured address";

  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState<SummaryLanguage>(defaultLanguage);
  const [includeSummary, setIncludeSummary] = useState(Boolean(result?.aiEnabled));
  const [includeImage, setIncludeImage] = useState(true);
  const [website, setWebsite] = useState(""); // honeypot — bots fill it, humans can't see it
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [status, setStatus] = useState<DialogStatus>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const close = useCallback(() => {
    if (statusRef.current === "sending") return;
    onClose();
  }, [onClose]);

  // 30-second client-side cooldown after a send; ticks once a second while on.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);
  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  // Focus trap, Esc-to-close, focus restored to the header button on exit.
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    if (inputRef.current) inputRef.current.focus();
    else dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (statusRef.current === "sending") return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus?.();
    };
  }, [close]);

  if (!result) return null;
  const metadata = result.stats.metadata;
  const aiAvailable = Boolean(result.aiEnabled);
  const captchaReady = !config.turnstileSiteKey || Boolean(turnstileToken);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (status === "sending" || cooldownRemaining > 0) return;
    let recipient = "";
    if (!fixed) {
      recipient = email.trim();
      if (!isValidEmail(recipient)) {
        setStatus("error");
        setErrorCode("EMAIL_INVALID");
        setServerMessage(null);
        return;
      }
    }
    setStatus("sending");
    setErrorCode(null);
    setServerMessage(null);
    try {
      const response = await fetch("/api/compare/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Fixed mode must never carry an email field — the server rejects it.
          ...(fixed ? {} : { email: recipient }),
          params: analysisParamsFromMetadata(metadata),
          language,
          includeSummary,
          includeImage,
          ...(config.turnstileSiteKey && turnstileToken ? { turnstileToken } : {}),
          ...(website ? { website } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        alreadySent?: boolean;
        code?: string;
        message?: string;
      } | null;
      if (response.ok && payload?.ok) {
        setStatus(payload.alreadySent ? "alreadySent" : "success");
        if (!fixed) setSentTo(recipient);
        onSent();
        setNow(Date.now());
        return;
      }
      setStatus("error");
      setErrorCode(typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`);
      setServerMessage(typeof payload?.message === "string" ? payload.message : null);
    } catch {
      setStatus("error");
      setErrorCode("NETWORK");
      setServerMessage("Couldn't reach the server. Check your connection and try again.");
    }
  };

  const terminal = status === "success" || status === "alreadySent";

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4 max-sm:p-0"
      role="presentation"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-report-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-sm flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-float focus:outline-none max-sm:h-full max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-4 pt-4">
          <h2 id="email-report-title" className="min-w-0 flex-1 text-sm font-semibold text-text">
            {fixed ? "Send report to mail" : "Email report"}
          </h2>
          <button
            type="button"
            aria-label="Close email report"
            onClick={close}
            disabled={status === "sending"}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3">
            {config.provider === "console" && (
              <p className="mb-3 text-[11px] leading-relaxed text-muted">
                Preview mode — reports are saved to{" "}
                <code className="mono-nums">.email-preview/</code> instead of being delivered.
              </p>
            )}
            <div className="flex flex-col gap-3">
          {fixed ? (
            <p className="text-xs leading-relaxed text-text">
              This comparison will be emailed to{" "}
              <span className="mono-nums font-medium">{recipientHint}</span>.
            </p>
          ) : (
            <div>
              <label htmlFor="email-report-recipient" className="mb-1 block text-[11px] text-muted">
                Email address
              </label>
              <input
                ref={inputRef}
                id="email-report-recipient"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                maxLength={254}
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (status === "error" || status === "success") setStatus("idle");
                }}
                placeholder="you@example.org"
                className="w-full rounded border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          )}

          <input
            type="text"
            name="website"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="absolute -left-[9999px] h-0 w-0 opacity-0"
          />

          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
              <Languages size={12} aria-hidden />
              Language
            </p>
            <Segmented
              ariaLabel="Report language"
              value={language}
              onChange={(value) => setLanguage(value as SummaryLanguage)}
              options={[
                { value: "en", label: "English" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <ToggleRow
              checked={includeSummary}
              disabled={!aiAvailable}
              onChange={setIncludeSummary}
              icon={Sparkles}
              label="Include AI summary"
              title={
                aiAvailable
                  ? "Adds the plain-language AI summary when one is available."
                  : "AI summaries are disabled on this deployment (no GEMINI_API_KEY)."
              }
            />
            <ToggleRow
              checked={includeImage}
              onChange={setIncludeImage}
              icon={ImageIcon}
              label="Include change-map image"
              title="Attaches the change map as an inline image."
            />
          </div>

          {!aiAvailable && (
            <p className="text-[11px] leading-relaxed text-muted">
              AI summary unavailable — this server has no{" "}
              <code className="mono-nums">GEMINI_API_KEY</code>.
            </p>
          )}

          {!fixed && (
            <p className="text-[11px] leading-relaxed text-muted">
              Used only to send you this report — no marketing, no tracking.
            </p>
          )}

          {config.turnstileSiteKey && (
            <div className="flex flex-col gap-1.5">
              <TurnstileWidget siteKey={config.turnstileSiteKey} onVerify={setTurnstileToken} />
              {!turnstileToken && (
                <p className="text-[11px] text-muted">Complete the verification to send.</p>
              )}
            </div>
          )}

          <div aria-live="polite" className="min-h-0">
            {status === "sending" && (
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 size={13} className="animate-spin" aria-hidden />
                Sending the report…
              </p>
            )}
            {status === "success" && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-text">
                <CheckCircle2 size={14} className="shrink-0 text-accent" aria-hidden />
                <span>
                  {fixed ? (
                    <>
                      Report sent to{" "}
                      <span className="mono-nums font-medium">{recipientHint}</span>. It can take
                      a minute; check spam.
                    </>
                  ) : (
                    <>
                      Report sent to{" "}
                      <span className="mono-nums font-medium">{maskEmail(sentTo)}</span> — it may
                      take a minute to arrive.
                    </>
                  )}
                </span>
              </p>
            )}
            {status === "alreadySent" && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-text">
                <Clock size={14} className="shrink-0 text-accent" aria-hidden />
                <span>This report was already sent a few minutes ago.</span>
              </p>
            )}
            {status === "error" && (
              <p className="flex flex-wrap items-baseline gap-1.5 text-xs text-danger">
                <span>{messageFor(errorCode, serverMessage)}</span>
                {errorCode && (
                  <span className="mono-nums rounded-sm border border-border bg-surface px-1 py-px text-[10px] text-muted">
                    {errorCode}
                  </span>
                )}
              </p>
            )}
            {status === "idle" && cooldownRemaining > 0 && (
              <p className="text-xs text-muted">
                You can send another report in {cooldownRemaining}s.
              </p>
            )}
            </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {terminal ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setStatus("idle");
                    if (!fixed) setEmail("");
                  }}
                >
                  Send another
                </Button>
                <Button variant="primary" type="button" autoFocus onClick={close}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" type="button" onClick={close} disabled={status === "sending"}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={status === "sending" || !captchaReady || cooldownRemaining > 0}
                  title={
                    cooldownRemaining > 0
                      ? `Wait ${cooldownRemaining}s before sending another report.`
                      : !captchaReady
                        ? "Complete the captcha verification first."
                        : undefined
                  }
                >
                  {status === "sending" ? (
                    <>
                      <Loader2 size={13} className="animate-spin" aria-hidden />
                      Sending…
                    </>
                  ) : status === "error" ? (
                    "Try again"
                  ) : (
                    "Send report"
                  )}
                </Button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  disabled = false,
  onChange,
  icon: Icon,
  label,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  icon: LucideIcon;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center gap-2 rounded border border-border bg-surface px-2 py-1.5 text-left text-xs transition-colors duration-150",
        checked && !disabled ? "text-text" : "text-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border",
          checked && !disabled ? "border-accent bg-accent" : "border-border bg-surface",
        )}
      >
        {checked && !disabled && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgb(var(--accent-fg))"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-2.5 w-2.5"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <Icon size={13} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}
