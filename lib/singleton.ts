/**
 * globalThis-backed module singletons.
 *
 * `next dev` evaluates each route from its own module graph (and HMR can
 * re-evaluate modules mid-session), while Vercel bundles every route into its
 * own serverless process — so plain module-level caches/stores fork per route
 * or per instance. Hanging them off globalThis keeps ONE instance per runtime
 * (dev server, Node process, or warm serverless instance) regardless of how
 * many copies of the module get evaluated.
 *
 * Interface note: values created here are process-local by nature. A durable
 * cross-instance backend (Supabase Storage / Vercel Blob / KV) would replace
 * the *storage* behind the cache interfaces in lib/cache.ts — the singletons
 * below stay as the in-process front layer.
 */
export function sharedInstance<T>(globalKey: string, create: () => T): T {
  const holder = globalThis as { [key: string]: unknown };
  if (holder[globalKey] === undefined) holder[globalKey] = create();
  return holder[globalKey] as T;
}
