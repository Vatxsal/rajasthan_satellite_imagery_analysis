import { create } from "zustand";

/**
 * Session state for the UI: filled from GET /api/auth/session (which only
 * ever returns { role, name }) and refreshed after login/guest/logout.
 * The role lives here so features can be gated per role later without
 * touching the auth layer. No subject, token or secret is ever stored.
 */
export type SessionRole = "guest" | "sso";

export interface SessionInfo {
  role: SessionRole;
  name: string;
}

interface SessionState {
  /** unknown → fetch in flight; the shell renders neutrally until then. */
  status: "unknown" | "signed-out" | "signed-in";
  role: SessionRole | null;
  name: string | null;
  fetchSession: () => Promise<void>;
  setSession: (info: SessionInfo) => void;
  clearSession: () => void;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: "unknown",
  role: null,
  name: null,
  fetchSession: async () => {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (response.ok) {
        const data = (await response.json()) as SessionInfo;
        set({ status: "signed-in", role: data.role, name: data.name });
        return;
      }
      set({ status: "signed-out", role: null, name: null });
    } catch {
      // Network blip: treat as signed-out; middleware still protects routes.
      set({ status: "signed-out", role: null, name: null });
    }
  },
  setSession: (info) => set({ status: "signed-in", role: info.role, name: info.name }),
  clearSession: () => set({ status: "signed-out", role: null, name: null }),
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
    set({ status: "signed-out", role: null, name: null });
    window.location.assign("/login");
  },
}));
