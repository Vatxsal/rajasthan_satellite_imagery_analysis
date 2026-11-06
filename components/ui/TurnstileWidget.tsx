"use client";

/**
 * Cloudflare Turnstile widget: loads the official script once (explicit
 * render mode), mounts one challenge, and reports the token upward. Used by
 * the email dialog only when the server config endpoint exposes a site key.
 */
import { useEffect, useRef, useState } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileNamespace {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    /** api.js?render=explicit exposes the namespace as window.turnstile
     *  (window.grecaptcha exists only with ?compat=recaptcha). */
    turnstile?: TurnstileNamespace;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
    if (existing) {
      // A tag is already on the page (first load in flight): wait for it.
      let attempts = 0;
      const poll = window.setInterval(() => {
        attempts += 1;
        if (window.turnstile) {
          window.clearInterval(poll);
          resolve();
        } else if (attempts > 40) {
          window.clearInterval(poll);
          scriptPromise = null;
          reject(new Error("Turnstile script did not load"));
        }
      }, 100);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string | null) => void;
}

export default function TurnstileWidget({ siteKey, onVerify }: TurnstileWidgetProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest callback without re-running the mount effect each render.
  const callbackRef = useRef(onVerify);
  callbackRef.current = onVerify;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        if (!window.turnstile) {
          setFailed(true); // script executed without exposing the API
          return;
        }
        widgetIdRef.current = window.turnstile.render(hostRef.current, {
          sitekey: siteKey,
          callback: (token: string) => callbackRef.current(token),
          "expired-callback": () => callbackRef.current(null),
          "error-callback": () => callbackRef.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      widgetIdRef.current = null;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Widget already detached with its host node.
        }
      }
      callbackRef.current(null);
    };
  }, [siteKey]);

  if (failed) {
    return (
      <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
        Verification couldn&apos;t load — reload the page to send a report.
      </p>
    );
  }

  return <div ref={hostRef} aria-label="Captcha verification" />;
}
