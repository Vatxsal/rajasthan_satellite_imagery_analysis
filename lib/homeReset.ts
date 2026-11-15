/**
 * Cross-store home-reset hooks. Stores that must clear state on "home"
 * (compare run, fields/pattern, …) register a hook at module load; the app
 * store's resetToHome runs them. A registry avoids importing sibling stores
 * into the app store (compare already imports app — a direct call would
 * create an import cycle).
 */
const hooks = new Set<() => void>();

/** Register a hook; returns an unregister function (tests). */
export function registerHomeResetHook(hook: () => void): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/** Run every registered hook in registration order; never throws. */
export function runHomeResetHooks(): void {
  for (const hook of [...hooks]) {
    try {
      hook();
    } catch {
      // One store failing must not block the rest of the home reset.
    }
  }
}
