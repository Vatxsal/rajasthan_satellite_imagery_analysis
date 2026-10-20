import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeId = "light" | "dark";

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  toggleTheme: () => void;
}

/** UI-only theme state; persisted to localStorage. Does not touch app data state. */
export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "light",
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === "light" ? "dark" : "light" }),
    }),
    { name: "rie-theme" },
  ),
);
