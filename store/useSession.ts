import { create } from "zustand";
import {
  PERMISSIONS,
  type Capability,
  type QuotaKind,
  type RoleLimits,
} from "@/lib/auth/permissions";
import type { QuotaUsage } from "@/lib/auth/quota";
import { seedFromPreferences } from "@/store/useAppStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useQueriesStore } from "@/store/useQueriesStore";

/**
 * Session state for the UI: filled from GET /api/auth/session
 * ({ role, name, capabilities, limits, usageToday }) and refreshed after
 * login/guest/logout. Login responses only carry { role, name } — capability
 * lookups fall back to the client-side PERMISSIONS table (same single source
 * the server enforces) until the next fetchSession fills the live payload.
 * No subject, token or secret is ever stored.
 */
export type SessionRole = "guest" | "sso";

export interface SessionInfo {
  role: SessionRole;
  name: string;
  /** Explicit alias of `name` from the session endpoint (profile dialog). */
  displayName?: string;
  /** SSO account identifier (used as the preferences storage subject). */
  username?: string;
  /** Session JWT epoch seconds (null for the cookie-less ambient guest). */
  issuedAt?: number | null;
  expiresAt?: number | null;
  capabilities?: Partial<Record<Capability, boolean>>;
  limits?: RoleLimits;
  usageToday?: Partial<Record<QuotaKind, QuotaUsage>>;
}

interface SessionState {
  /** unknown → fetch in flight; the shell renders neutrally until then. */
  status: "unknown" | "signed-out" | "signed-in";
  role: SessionRole | null;
  name: string | null;
  username: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  capabilities: Partial<Record<Capability, boolean>> | null;
  limits: RoleLimits | null;
  usageToday: Partial<Record<QuotaKind, QuotaUsage>> | null;
  fetchSession: () => Promise<void>;
  setSession: (info: SessionInfo) => void;
  clearSession: () => void;
  signOut: () => Promise<void>;
}

function applyInfo(
  info: SessionInfo,
): Pick<
  SessionState,
  | "status"
  | "role"
  | "name"
  | "username"
  | "issuedAt"
  | "expiresAt"
  | "capabilities"
  | "limits"
  | "usageToday"
> {
  return {
    status: "signed-in",
    role: info.role,
    name: info.displayName ?? info.name,
    username: info.username ?? null,
    issuedAt: info.issuedAt ?? null,
    expiresAt: info.expiresAt ?? null,
    capabilities: info.capabilities ?? PERMISSIONS[info.role].capabilities,
    limits: info.limits ?? PERMISSIONS[info.role].limits,
    usageToday: info.usageToday ?? null,
  };
}

const CLEARED = {
  status: "signed-out" as const,
  role: null,
  name: null,
  username: null,
  issuedAt: null,
  expiresAt: null,
  capabilities: null,
  limits: null,
  usageToday: null,
};

/** Preferences + saved-queries subject: the SSO username (fallback: display name), or "guest". */
function subjectFor(info: SessionInfo | null): string {
  if (!info || info.role !== "sso") return "guest";
  const username = info.username?.trim();
  if (username) return username;
  return info.name?.trim() || "sso";
}

/**
 * Load this account's saved preferences and seed untouched filter/map defaults,
 * and drop any cached saved-query rows from the previous subject (login/logout
 * must never render one account's list under another's session).
 */
function syncPreferencesSubject(info: SessionInfo | null): void {
  const subject = subjectFor(info);
  usePreferencesStore.getState().setSubject(subject);
  useQueriesStore.getState().setSubject(subject);
  seedFromPreferences();
}

export const useSession = create<SessionState>((set) => ({
  status: "unknown",
  role: null,
  name: null,
  username: null,
  issuedAt: null,
  expiresAt: null,
  capabilities: null,
  limits: null,
  usageToday: null,
  fetchSession: async () => {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (response.ok) {
        const data = (await response.json()) as SessionInfo;
        set(applyInfo(data));
        syncPreferencesSubject(data);
        return;
      }
      set(CLEARED);
      syncPreferencesSubject(null);
    } catch {
      // Network blip: treat as signed-out; middleware still protects routes.
      set(CLEARED);
      syncPreferencesSubject(null);
    }
  },
  setSession: (info) => {
    set(applyInfo(info));
    syncPreferencesSubject(info);
  },
  clearSession: () => {
    set(CLEARED);
    syncPreferencesSubject(null);
  },
  signOut: async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } catch {
      // Cookie clearing is best-effort; the redirect below still applies.
    }
    set(CLEARED);
    syncPreferencesSubject(null);
    window.location.assign("/login");
  },
}));

/** True when the current session holds `capability` (server payload first, PERMISSIONS fallback). */
export function selectCan(
  state: Pick<SessionState, "role" | "capabilities">,
  capability: Capability,
): boolean {
  if (!state.role) return false;
  if (state.capabilities) return state.capabilities[capability] === true;
  return PERMISSIONS[state.role].capabilities[capability] === true;
}

/** Live capability probe — false until the session role is known. */
export function useCan(capability: Capability): boolean {
  return useSession((state) => selectCan(state, capability));
}

/**
 * True when the feature should render locked for this session. The session
 * probe has not answered yet (status "unknown") → not locked, so the shell
 * never flashes locks during the first paint; the API still enforces 401/403.
 */
export function useLocked(capability: Capability): boolean {
  return useSession((state) => {
    if (state.status === "unknown") return false;
    return !selectCan(state, capability);
  });
}

/** Numeric role limits (server payload first, PERMISSIONS fallback). */
export function useRoleLimits(): RoleLimits | null {
  return useSession((state) => state.limits ?? (state.role ? PERMISSIONS[state.role].limits : null));
}

/** Today's binding quota usage for a metered kind, when the session payload carried it. */
export function useQuotaToday(kind: QuotaKind): QuotaUsage | null {
  return useSession((state) => state.usageToday?.[kind] ?? null);
}
