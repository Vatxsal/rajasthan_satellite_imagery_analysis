"use client";

import { Lock, LogIn, LogOut, Send } from "lucide-react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { QuotaReadout } from "@/components/ui/FeatureLock";
import { goRequestAccess, goSignIn } from "@/lib/auth/nav";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  PERMISSIONS,
  type Capability,
} from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useSession } from "@/store/useSession";

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-text">{children}</dd>
    </div>
  );
}

/**
 * Account dialog from the top-right menu: session identity, when the session
 * was issued/expires, today's binding quotas, every capability with an
 * allowed/locked chip, and the session actions. Passwords are never managed
 * (or shown) here — the note points at the administrator.
 */
export default function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  const status = useSession((s) => s.status);
  const role = useSession((s) => s.role);
  const name = useSession((s) => s.name);
  const username = useSession((s) => s.username);
  const issuedAt = useSession((s) => s.issuedAt);
  const expiresAt = useSession((s) => s.expiresAt);
  const capabilities = useSession((s) => s.capabilities);
  const usageToday = useSession((s) => s.usageToday);
  const signOut = useSession((s) => s.signOut);
  const timeZone = usePreferencesStore((s) => s.values.units.timeZone);

  const effective = capabilities ?? (role ? PERMISSIONS[role].capabilities : null);
  const signedIn = status === "signed-in";
  const displayName = name ?? (role === "guest" ? "Guest" : "User");
  const badge = role === "sso" ? "SSO" : role === "guest" ? "Guest" : null;
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Profile</DialogTitle>
        <DialogDescription>
          {signedIn
            ? role === "sso"
              ? "State department SSO account"
              : "Guest session — limited access"
            : status === "signed-out"
              ? "Not signed in"
              : "Checking session…"}
        </DialogDescription>

        <div className="mt-3 flex items-center gap-3 rounded border border-border bg-surface-2 p-3">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
          >
            {initials || "…"}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text">{displayName}</p>
            <p className="text-xs text-muted">{badge ? `${badge} session` : "No active session"}</p>
          </div>
          {badge && (
            <Chip tone={role === "sso" ? "accent" : "neutral"} className="ml-auto shrink-0">
              {badge}
            </Chip>
          )}
        </div>

        <dl className="mt-3 divide-y divide-border rounded border border-border px-3">
          <Detail label="Account">
            {signedIn && role === "sso" ? (
              <span className="mono-nums">{username}</span>
            ) : signedIn ? (
              "—"
            ) : (
              "Not signed in"
            )}
          </Detail>
          <Detail label="Role">{role ? PERMISSIONS[role].label : "…"}</Detail>
          <Detail label="Session issued">
            {issuedAt ? formatDateTime(issuedAt, { timeZone }) : "—"}
          </Detail>
          <Detail label="Session expires">
            {expiresAt ? formatDateTime(expiresAt, { timeZone }) : "—"}
          </Detail>
        </dl>

        {role === "sso" && (
          <p className="mt-2 text-xs text-muted">Passwords are managed by your administrator.</p>
        )}

        {usageToday && (
          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Today&apos;s usage (UTC day)
            </h3>
            <div className="mt-1 grid gap-0.5">
              <QuotaReadout kind="search" showWhenFull />
              <QuotaReadout kind="compare" showWhenFull />
              <QuotaReadout kind="aiSummary" showWhenFull />
            </div>
          </section>
        )}

        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Access</h3>
          <ul className="mt-1 grid gap-x-3 gap-y-1 sm:grid-cols-2">
            {CAPABILITIES.map((id: Capability) => {
              const allowed = effective?.[id] === true;
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2 py-1"
                >
                  <span className="truncate text-xs text-text">{CAPABILITY_LABELS[id]}</span>
                  <Chip tone={allowed ? "success" : "neutral"} className="shrink-0 whitespace-nowrap">
                    {allowed ? (
                      "Available"
                    ) : (
                      <>
                        <Lock size={10} aria-hidden />
                        Available with an SSO ID
                      </>
                    )}
                  </Chip>
                </li>
              );
            })}
          </ul>
        </section>

        {status !== "unknown" && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {signedIn && role === "sso" && (
              <Button variant="secondary" size="sm" onClick={() => void signOut()}>
                <LogOut size={13} aria-hidden />
                Sign out
              </Button>
            )}
            {(!signedIn || role === "guest") && (
              <>
                <Button variant="primary" size="sm" onClick={goSignIn}>
                  <LogIn size={13} aria-hidden />
                  Sign in with SSO
                </Button>
                <Button variant="secondary" size="sm" onClick={goRequestAccess}>
                  <Send size={13} aria-hidden />
                  Request access
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
