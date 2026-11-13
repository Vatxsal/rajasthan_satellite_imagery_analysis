"use client";

/**
 * Access sheet for /login: shared-credential sign-in, guest entry, and the
 * access-request form. Talks only to /api/auth/* and /api/access-request; on
 * success it stores the { role, name } session and navigates to the
 * sanitised `next` path. Errors are announced via aria-live; 429 responses
 * show a live retry countdown from Retry-After.
 *
 * Layout: a flush ruled sheet on desktop (inline mode swap under a view
 * transition); below 1024px the request form opens as a full-screen dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, X } from "lucide-react";
import Button from "@/components/ui/Button";
import TurnstileWidget from "@/components/ui/TurnstileWidget";
import { cn } from "@/components/ui/cn";
import { useIsDesktop } from "@/lib/hooks/useMediaQuery";
import { useSession } from "@/store/useSession";

interface AccessPanelProps {
  next: string | null;
  guestEnabled: boolean;
  accessEnabled: boolean;
  captchaRequired: boolean;
  turnstileSiteKey: string | null;
  guestTtlHours: number;
  ssoTtlHours: number;
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

function formatTtl(hours: number): string {
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const labelClass =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted";

// Ruled survey-sheet fields: underline only, no boxes.
const fieldClass =
  "w-full rounded-none border-0 border-b border-border bg-transparent px-0 py-2 text-[15px] leading-6 text-text transition-colors duration-150 placeholder:text-muted/80 focus:border-accent disabled:opacity-60";

function Counter({ current, max }: { current: number; max: number }) {
  const near = current > max * 0.9;
  return (
    <span className={cn("mono-nums text-[11px]", near ? "text-warning" : "text-muted")}>
      {current}/{max}
    </span>
  );
}

export default function AccessPanel({
  next,
  guestEnabled,
  accessEnabled,
  captchaRequired,
  turnstileSiteKey,
  guestTtlHours,
  ssoTtlHours,
}: AccessPanelProps) {
  const [mode, setMode] = useState<Mode>("sso");
  const setSession = useSession((s) => s.setSession);
  const wide = useIsDesktop();
  const sheetMode = mode === "request" && !wide;

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

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);

  const showCaptcha = captchaRequired && Boolean(turnstileSiteKey);
  // Buttons must wait for the widget: sending `turnstileToken: null` fails
  // the API schema with a 400 (single-use tokens arrive asynchronously).
  const captchaReady = !showCaptcha || Boolean(turnstileToken);

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

  // Full-screen sheet: lock scrolling, focus the first field, Escape closes.
  useEffect(() => {
    if (!sheetMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nameFieldRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeRequest();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetMode]);

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

  // Panel swap under a view transition (skipped when unsupported/reduced).
  // Resolves when the transition finishes so focus can move afterwards.
  const runTransition = (apply: () => void): Promise<void> => {
    const doc = document as Document & {
      startViewTransition?: (callback: () => void) => { finished: Promise<unknown> };
    };
    if (doc.startViewTransition && !prefersReducedMotion()) {
      return doc
        .startViewTransition(() => flushSync(apply))
        .finished.catch(() => undefined)
        .then(() => undefined);
    }
    apply();
    return Promise.resolve();
  };

  const switchMode = (nextMode: Mode) => {
    void runTransition(() => {
      setMode(nextMode);
      setAuthError(null);
      setRequestError(null);
      setSentTo(null);
      setRetryAfter(0);
      refreshCaptcha();
    });
  };

  const openRequest = () => {
    triggerRef.current = document.activeElement as HTMLButtonElement | null;
    switchMode("request");
  };

  const closeRequest = () => {
    void runTransition(() => {
      setMode("sso");
      setAuthError(null);
      setRequestError(null);
      setSentTo(null);
      setRetryAfter(0);
      refreshCaptcha();
    }).then(() => triggerRef.current?.focus());
  };

  const authDisabled =
    busy !== null || (retryAfter > 0 && authError !== null) || !captchaReady;

  /* ------------------------------------------------------------ request form */

  const requestForm = sentTo ? (
    <div className="flex flex-col items-start gap-4">
      <CheckCircle2 size={28} className="text-success" aria-hidden />
      <div>
        <p className="font-display text-lg font-semibold text-text">Request received.</p>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          We&apos;ll reply to <span className="mono-nums break-all">{sentTo}</span> within a few
          days.
        </p>
      </div>
      <Button type="button" variant="quiet" size="md" onClick={closeRequest}>
        Back to sign in
      </Button>
    </div>
  ) : (
    <form onSubmit={submitRequest} className="flex flex-col gap-5" noValidate>
      <div>
        <label htmlFor="req-name" className={labelClass}>
          Full name
        </label>
        <input
          ref={nameFieldRef}
          id="req-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          disabled={requestBusy}
          className={fieldClass}
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
          className={fieldClass}
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
          className={fieldClass}
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
          className={cn(fieldClass, "h-auto resize-none py-2 leading-5")}
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
          <p className="rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
            {requestError}
          </p>
        )}
      </div>

      <Button
        type="submit"
        variant="ink"
        size="md"
        disabled={
          requestBusy ||
          !captchaReady ||
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
          "Send request"
        )}
      </Button>
    </form>
  );

  /* --------------------------------------------------- full-screen sheet */

  if (sheetMode && typeof document !== "undefined") {
    // Minimal focus trap: Tab cycles inside the dialog while it is modal.
    const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Tab") return;
      const root = event.currentTarget;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    return createPortal(
      <div
        id="auth-card"
        role="dialog"
        aria-modal="true"
        aria-label="Request access"
        onKeyDown={trapFocus}
        className="rse-rise fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-bg"
      >
        <div className="mx-auto w-full max-w-[560px] px-5 pb-16 pt-4 sm:px-8 sm:pt-6">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <span className="section-label">Rajasthan Imagery Explorer</span>
            <button
              type="button"
              onClick={closeRequest}
              aria-label="Close request form"
              className="grid h-11 w-11 place-items-center rounded-sm text-muted transition-colors duration-150 hover:text-text"
            >
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="mt-5">
            <h2 className="font-display text-[26px] font-semibold leading-8 text-text">
              Request access
            </h2>
            <p className="mt-1.5 text-[13px] leading-5 text-muted">
              Tell us who you are and we&apos;ll email your credentials.
            </p>
            <div className="mt-6">{requestForm}</div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  /* ------------------------------------------------------- inline sheet */

  if (mode === "request") {
    return (
      <div id="auth-card" className="w-full max-w-[440px]">
        <button
          type="button"
          onClick={closeRequest}
          className="mb-4 flex items-center gap-1.5 text-[13px] text-muted transition-colors duration-150 hover:text-text"
        >
          <ArrowLeft size={14} aria-hidden />
          Back to sign in
        </button>
        <h2 className="font-display text-[26px] font-semibold leading-8 text-text">
          Request access
        </h2>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">
          Tell us who you are and we&apos;ll email your credentials.
        </p>
        <div className="mt-6">{requestForm}</div>
      </div>
    );
  }

  return (
    <div
      id="auth-card"
      className="rse-rise w-full max-w-[440px]"
      style={{ animationDelay: "220ms" }}
    >
      <h2 className="font-display text-[26px] font-semibold leading-8 text-text">Sign in</h2>
      <p className="mt-1.5 text-[13px] leading-5 text-muted">
        Use your organisation credentials to open the explorer.
      </p>

      <form onSubmit={submitLogin} className="mt-6 flex flex-col gap-5" noValidate>
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
            className={fieldClass}
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
              className={cn(fieldClass, "pr-11")}
              placeholder="Your password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-0 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-sm text-muted transition-colors duration-150 hover:text-text"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
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
            <p className="rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">
              {retryAfter > 0 ? `Too many attempts. Try again in ${retryAfter}s.` : authError}
            </p>
          )}
        </div>

        <Button
          type="submit"
          variant="ink"
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
            "Sign in"
          )}
        </Button>
      </form>

      {guestEnabled && (
        <>
          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-[0.08em] text-muted">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="quiet"
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
              "Continue as guest"
            )}
          </Button>
          <p className="mt-2 text-[12px] leading-5 text-muted">
            Opens the full dashboard for {formatTtl(guestTtlHours)} — no account needed. Signing
            in keeps a session for {formatTtl(ssoTtlHours)}.
          </p>
        </>
      )}

      {accessEnabled && (
        <button
          ref={triggerRef}
          type="button"
          onClick={openRequest}
          className="mt-5 text-[13px] text-accent transition-colors duration-150 hover:underline"
        >
          Request SSO access
        </button>
      )}
    </div>
  );
}
