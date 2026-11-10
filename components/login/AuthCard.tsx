"use client";

/**
 * Right column of /login: shared-credential SSO sign-in, guest entry, and
 * the in-card access-request form. Talks only to /api/auth/* and
 * /api/access-request; on success it stores the { role, name } session in
 * the zustand store and navigates to the sanitised `next` path (emailed
 * deep links round-trip through the login bounce). Errors are announced via
 * aria-live; 429 responses show a live retry countdown from Retry-After.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
} from "lucide-react";
import Button from "@/components/ui/Button";
import TurnstileWidget from "@/components/ui/TurnstileWidget";
import { cn } from "@/components/ui/cn";
import { useSession } from "@/store/useSession";

interface AuthCardProps {
  next: string | null;
  guestEnabled: boolean;
  accessEnabled: boolean;
  captchaRequired: boolean;
  turnstileSiteKey: string | null;
}

type Mode = "sso" | "request";

const AUTH_FALLBACK: Record<string, string> = {
  INVALID_CREDENTIALS: "Invalid username or password.",
  AUTH_NOT_CONFIGURED: "Authentication is not configured on this deployment.",
  GUEST_DISABLED: "Guest access is disabled on this deployment.",
  AUTH_CAPTCHA_FAILED: "Captcha verification failed. Try again.",
  INVALID_REQUEST: "Invalid request.",
};

const ACCESS_FALLBACK: Record<string, string> = {
  ACCESS_UNAVAILABLE: "Access requests are unavailable right now. Please try again later.",
  ACCESS_CAPTCHA_FAILED: "Captcha verification failed. Try again.",
  ACCESS_SEND_FAILED: "Your request could not be sent. Try again shortly.",
  INVALID_REQUEST: "Invalid request.",
};

function messageFor(
  code: string | null,
  serverMessage: string | null,
  fallback: Record<string, string>,
): string {
  if (serverMessage) return serverMessage;
  if (code && fallback[code]) return fallback[code]!;
  return "Something went wrong. Try again.";
}

const inputClass =
  "h-9 w-full rounded border border-border bg-bg px-3 text-sm text-text placeholder:text-muted transition-colors duration-150 focus:border-accent focus:outline-none focus-visible:outline-none disabled:opacity-60";

const labelClass = "mb-1 block text-[12px] font-medium text-muted";

function Counter({ current, max }: { current: number; max: number }) {
  const near = current > max * 0.9;
  return (
    <span className={cn("mono-nums text-[11px]", near ? "text-warning" : "text-muted")}>
      {current}/{max}
    </span>
  );
}

export default function AuthCard({
  next,
  guestEnabled,
  accessEnabled,
  captchaRequired,
  turnstileSiteKey,
}: AuthCardProps) {
  const [mode, setMode] = useState<Mode>("sso");
  const setSession = useSession((s) => s.setSession);

  // Shared SSO + guest state.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<"sso" | "guest" | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);

  // Access-request state.
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Captcha: one shared token; remounted after every attempt (single-use).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);

  const showCaptcha = captchaRequired && Boolean(turnstileSiteKey);

  const refreshCaptcha = useCallback(() => {
    if (!captchaRequired) return;
    setTurnstileToken(null);
    setCaptchaAttempt((value) => value + 1);
  }, [captchaRequired]);

  // Retry-After countdown for 429 responses.
  const countingDown = retryAfter > 0;
  useEffect(() => {
    if (!countingDown) return;
    const id = window.setInterval(() => {
      setRetryAfter((value) => (value <= 1 ? 0 : value - 1));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [countingDown]);

  const navigateHome = () => {
    window.location.assign(next ?? "/");
  };

  const handleAuthFailure = async (response: Response) => {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    setAuthError(messageFor(payload?.code ?? null, payload?.message ?? null, AUTH_FALLBACK));
    if (response.status === 429) {
      const header = Number(response.headers.get("Retry-After") ?? "0");
      if (Number.isFinite(header) && header > 0) setRetryAfter(header);
    }
    refreshCaptcha();
    setBusy(null);
  };

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy("sso");
    setAuthError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(showCaptcha ? { turnstileToken } : {}),
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { role: "guest" | "sso"; name: string };
        setSession({ role: data.role, name: data.name });
        navigateHome();
        return; // stay busy while the browser navigates
      }
      await handleAuthFailure(response);
    } catch {
      setAuthError("Network error. Check your connection and try again.");
      refreshCaptcha();
      setBusy(null);
    }
  };

  const submitGuest = async () => {
    if (busy) return;
    setBusy("guest");
    setAuthError(null);
    try {
      const response = await fetch("/api/auth/guest", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(showCaptcha ? { turnstileToken } : {}),
      });
      if (response.ok) {
        const data = (await response.json()) as { role: "guest" | "sso"; name: string };
        setSession({ role: data.role, name: data.name });
        navigateHome();
        return;
      }
      await handleAuthFailure(response);
    } catch {
      setAuthError("Network error. Check your connection and try again.");
      refreshCaptcha();
      setBusy(null);
    }
  };

  const submitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (requestBusy) return;
    setRequestBusy(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/access-request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          company,
          email,
          reason,
          website,
          ...(showCaptcha ? { turnstileToken } : {}),
        }),
      });
      if (response.ok) {
        setSentTo(email);
        refreshCaptcha();
        setRequestBusy(false);
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      setRequestError(
        messageFor(payload?.code ?? null, payload?.message ?? null, ACCESS_FALLBACK),
      );
      refreshCaptcha();
      setRequestBusy(false);
    } catch {
      setRequestError("Network error. Check your connection and try again.");
      refreshCaptcha();
      setRequestBusy(false);
    }
  };

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setAuthError(null);
    setRequestError(null);
    setRetryAfter(0);
    refreshCaptcha();
  };

  const authDisabled =
    busy !== null || (retryAfter > 0 && authError !== null);

  return (
    <div
      id="auth-card"
      className="rse-rise w-full max-w-[420px] rounded-lg border border-border bg-surface p-6 shadow-float"
      style={{ animationDelay: "220ms" }}
    >
      {mode === "sso" ? (
        <>
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-text">Sign in</h2>
            <p className="mt-1 text-[13px] text-muted">
              Use your organisation credentials to open the explorer.
            </p>
          </div>

          <form onSubmit={submitLogin} className="flex flex-col gap-3.5" noValidate>
            <div>
              <label htmlFor="auth-username" className={labelClass}>
                Username
              </label>
              <input
                id="auth-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                maxLength={64}
                required
                disabled={busy !== null}
                className={inputClass}
                placeholder="e.g. rdos.user"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className={labelClass}>
                Password
              </label>
              <div className="relative">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  maxLength={256}
                  required
                  disabled={busy !== null}
                  className={cn(inputClass, "pr-10")}
                  placeholder="Your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-muted transition-colors duration-150 hover:text-text"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {showCaptcha && turnstileSiteKey && (
              <TurnstileWidget
                key={`auth-${captchaAttempt}`}
                siteKey={turnstileSiteKey}
                onVerify={setTurnstileToken}
              />
            )}

            <div aria-live="polite" className="min-h-0">
              {authError && (
                <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
                  {retryAfter > 0
                    ? `Too many attempts. Try again in ${retryAfter}s.`
                    : authError}
                </p>
              )}
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={authDisabled || username.length === 0 || password.length === 0}
              className="w-full"
            >
              {busy === "sso" ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  <Lock size={14} />
                  Sign in
                </>
              )}
            </Button>
          </form>

          {guestEnabled && (
            <>
              <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-[0.08em] text-muted">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="md"
                disabled={authDisabled}
                onClick={() => void submitGuest()}
                className="w-full"
              >
                {busy === "guest" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Starting guest session…
                  </>
                ) : (
                  "Explore the full dashboard, no account needed"
                )}
              </Button>
            </>
          )}

          <div aria-live="polite">
            {accessEnabled && (
              <button
                type="button"
                onClick={() => switchMode("request")}
                className="mt-4 flex w-full items-center justify-center gap-1.5 text-[13px] text-accent transition-colors duration-150 hover:underline"
              >
                <Send size={13} />
                Request access with your work email
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => switchMode("sso")}
            className="mb-3 flex items-center gap-1.5 text-[13px] text-muted transition-colors duration-150 hover:text-text"
          >
            <ArrowLeft size={14} />
            Back to sign in
          </button>

          <div className="mb-4">
            <h2 className="text-lg font-semibold text-text">Request access</h2>
            <p className="mt-1 text-[13px] text-muted">
              Tell us who you are and we&apos;ll email your credentials.
            </p>
          </div>

          {sentTo ? (
            <div className="flex flex-col items-start gap-3">
              <CheckCircle2 size={28} className="text-success" aria-hidden />
              <div>
                <p className="text-sm font-medium text-text">Request received.</p>
                <p className="mt-1 text-[13px] leading-5 text-muted">
                  We&apos;ll reply to <span className="mono-nums break-all">{sentTo}</span> within
                  a few days.
                </p>
              </div>
              <Button type="button" variant="secondary" size="md" onClick={() => switchMode("sso")}>
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submitRequest} className="flex flex-col gap-3.5" noValidate>
              <div>
                <label htmlFor="req-name" className={labelClass}>
                  Full name
                </label>
                <input
                  id="req-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={requestBusy}
                  className={inputClass}
                />
                <div className="mt-1 flex justify-end">
                  <Counter current={name.length} max={80} />
                </div>
              </div>

              <div>
                <label htmlFor="req-company" className={labelClass}>
                  Company / organisation
                </label>
                <input
                  id="req-company"
                  type="text"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                  maxLength={120}
                  required
                  disabled={requestBusy}
                  className={inputClass}
                />
                <div className="mt-1 flex justify-end">
                  <Counter current={company.length} max={120} />
                </div>
              </div>

              <div>
                <label htmlFor="req-email" className={labelClass}>
                  Email
                </label>
                <input
                  id="req-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  maxLength={254}
                  required
                  disabled={requestBusy}
                  className={inputClass}
                  placeholder="you@organisation.in"
                />
              </div>

              <div>
                <label htmlFor="req-reason" className={labelClass}>
                  Reason for access
                </label>
                <textarea
                  id="req-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={1_000}
                  rows={4}
                  required
                  disabled={requestBusy}
                  className={cn(inputClass, "h-auto resize-none py-2 leading-5")}
                  placeholder="What would you use the explorer for?"
                />
                <div className="mt-1 flex justify-end">
                  <Counter current={reason.length} max={1_000} />
                </div>
              </div>

              {/* Honeypot — visually hidden, bots fill it. */}
              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                className="absolute left-[-9999px] h-0 w-0 opacity-0"
              />

              {showCaptcha && turnstileSiteKey && (
                <TurnstileWidget
                  key={`request-${captchaAttempt}`}
                  siteKey={turnstileSiteKey}
                  onVerify={setTurnstileToken}
                />
              )}

              <div aria-live="polite" className="min-h-0">
                {requestError && (
                  <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
                    {requestError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={
                  requestBusy ||
                  name.trim().length === 0 ||
                  company.trim().length === 0 ||
                  email.trim().length === 0 ||
                  reason.trim().length === 0
                }
                className="w-full"
              >
                {requestBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={14} />
                    Send request
                  </>
                )}
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
