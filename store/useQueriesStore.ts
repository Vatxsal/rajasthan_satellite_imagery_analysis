import { create } from "zustand";
import {
  fetchQueriesConfig,
  inputFromQuery,
  queriesClient,
  suggestionOf,
  type QueriesConfig,
} from "@/lib/queries/client";
import {
  isQueryRepoError,
  type QueryRepository,
  type SavedQuery,
  type SavedQueryInput,
  type SavedQueryPatch,
} from "@/lib/queries/repository";

/**
 * Saved-queries UI state: config + repository + the current owner's list,
 * plus the Save/Edit dialog target. Subject-keyed like preferences — a
 * login/logout calls setSubject, which drops every cached row so one
 * account's list can never render under another's session. CRUD runs
 * against the repository chosen by GET /api/queries/config (browser-local
 * for guests/local mode, /api/queries for the Supabase store).
 */

export interface SaveDialogState {
  open: boolean;
  /** null = create mode; a query = edit mode. */
  editing: SavedQuery | null;
}

interface QueriesState {
  /** Storage subject ("guest" | SSO username) — matches preferences. */
  subject: string;
  config: QueriesConfig | null;
  repo: QueryRepository | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  items: SavedQuery[];
  saveDialog: SaveDialogState;
  /** Row awaiting delete confirmation (panel menu → confirm dialog). */
  deleteTarget: SavedQuery | null;
  /** Last query applied by Run — survives the panel unmounting on tab switch. */
  appliedId: string | null;

  /** Sign-in/sign-out boundary: drop cached config, repo and rows. */
  setSubject: (subject: string) => void;
  /** Fetch config, build the repository, list the rows (shared in-flight). */
  load: () => Promise<void>;
  /** Re-read rows from the existing repository (Retry after failure). */
  refresh: () => Promise<void>;
  create: (input: SavedQueryInput) => Promise<SavedQuery>;
  update: (id: string, patch: SavedQueryPatch) => Promise<SavedQuery>;
  duplicate: (id: string) => Promise<SavedQuery>;
  /** Optimistic: removes the row first, restores the snapshot on failure. */
  remove: (id: string) => Promise<boolean>;
  /** Undo of remove: re-creates the exact payload. */
  restore: (input: SavedQueryInput) => Promise<SavedQuery>;
  /** Optimistic pin flip. */
  togglePin: (id: string) => Promise<void>;
  /** Best-effort run counter — never blocks or fails the applied search. */
  touchRun: (id: string) => Promise<void>;

  openSave: () => void;
  openEdit: (query: SavedQuery) => void;
  closeSave: () => void;
  requestDelete: (query: SavedQuery) => void;
  closeDelete: () => void;
  setApplied: (id: string | null) => void;
}

function messageOf(error: unknown): string {
  if (isQueryRepoError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Saved queries are unavailable. Try again shortly.";
}

/** Coalesces concurrent load() calls onto one in-flight promise. */
let loadInflight: Promise<void> | null = null;

export const useQueriesStore = create<QueriesState>((set, get) => {
  /** Repo after load(); surfaces the load error when storage stays broken. */
  async function ensureRepo(): Promise<QueryRepository> {
    const current = get();
    if (current.repo) return current.repo;
    await get().load();
    const after = get();
    if (after.repo) return after.repo;
    throw new Error(after.error ?? "Saved queries are unavailable. Try again shortly.");
  }

  function replace(query: SavedQuery): void {
    set((s) => ({ items: s.items.map((item) => (item.id === query.id ? query : item)) }));
  }

  return {
    subject: "guest",
    config: null,
    repo: null,
    status: "idle",
    error: null,
    items: [],
    saveDialog: { open: false, editing: null },
    deleteTarget: null,
    appliedId: null,

    setSubject: (subject) => {
      if (subject === get().subject) return;
      set({
        subject,
        config: null,
        repo: null,
        status: "idle",
        error: null,
        items: [],
        saveDialog: { open: false, editing: null },
        deleteTarget: null,
        appliedId: null,
      });
    },

    load: () => {
      if (loadInflight) return loadInflight;
      set({ status: "loading", error: null });
      loadInflight = (async () => {
        try {
          const config = await fetchQueriesConfig();
          const repo = queriesClient(config, get().subject);
          const items = await repo.list();
          set({ config, repo, items, status: "ready", error: null });
        } catch (error) {
          set({ config: null, repo: null, status: "error", error: messageOf(error) });
        }
      })().finally(() => {
        loadInflight = null;
      });
      return loadInflight;
    },

    refresh: async () => {
      const repo = get().repo;
      if (!repo) {
        await get().load();
        return;
      }
      try {
        const items = await repo.list();
        set({ items, status: "ready", error: null });
      } catch (error) {
        set({ status: "error", error: messageOf(error) });
      }
    },

    create: async (input) => {
      const repo = await ensureRepo();
      const query = await repo.create(input);
      set((s) => ({ items: [query, ...s.items] }));
      return query;
    },

    update: async (id, patch) => {
      const repo = await ensureRepo();
      const query = await repo.update(id, patch);
      if (!query) {
        // Row vanished (another tab/device) — re-sync instead of lying.
        void get().refresh();
        throw new Error("This saved query no longer exists.");
      }
      replace(query);
      return query;
    },

    duplicate: async (id) => {
      const source = get().items.find((item) => item.id === id);
      if (!source) throw new Error("This saved query no longer exists.");
      const base = inputFromQuery(source);
      const attempt = `${source.name} (copy)`.slice(0, 80);
      try {
        return await get().create({ ...base, name: attempt });
      } catch (error) {
        const suggestion = suggestionOf(error);
        if (isQueryRepoError(error) && error.code === "NAME_TAKEN" && suggestion) {
          return await get().create({ ...base, name: suggestion });
        }
        throw error;
      }
    },

    remove: async (id) => {
      const repo = await ensureRepo();
      const snapshot = get().items;
      set({ items: snapshot.filter((item) => item.id !== id) });
      try {
        const deleted = await repo.delete(id);
        return deleted;
      } catch (error) {
        set({ items: snapshot });
        throw error;
      }
    },

    restore: async (input) => get().create(input),

    togglePin: async (id) => {
      const repo = await ensureRepo();
      const snapshot = get().items;
      const current = snapshot.find((item) => item.id === id);
      if (!current) return;
      const pinned = !current.pinned;
      set({ items: snapshot.map((item) => (item.id === id ? { ...item, pinned } : item)) });
      try {
        const query = await repo.update(id, { pinned });
        if (query) replace(query);
        else set({ items: snapshot });
      } catch (error) {
        set({ items: snapshot });
        throw error;
      }
    },

    touchRun: async (id) => {
      const repo = get().repo;
      if (!repo) return;
      try {
        const query = await repo.touchRun(id);
        if (query) replace(query);
      } catch {
        // Counters are telemetry — the applied search already succeeded.
      }
    },

    openSave: () => set({ saveDialog: { open: true, editing: null } }),
    openEdit: (query) => set({ saveDialog: { open: true, editing: query } }),
    closeSave: () => set((s) => ({ saveDialog: { ...s.saveDialog, open: false } })),
    requestDelete: (query) => set({ deleteTarget: query }),
    closeDelete: () => set({ deleteTarget: null }),
    setApplied: (id) => set({ appliedId: id }),
  };
});
