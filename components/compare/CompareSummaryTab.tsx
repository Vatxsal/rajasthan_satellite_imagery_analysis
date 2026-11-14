"use client";

import { Image as ImageIcon, Languages, Loader2, RefreshCw, Sparkles } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import FeatureLock, { useLocked } from "@/components/ui/FeatureLock";
import { QuotaReadout } from "@/components/ui/FeatureLock";
import { cn } from "@/components/ui/cn";
import type { SummaryLanguage } from "@/lib/analysis/types";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Fifth compare tab: a server-side Gemini summary of the finished analysis
 * (structured JSON: overview + bullet lists). The browser sends the analysis
 * cache key, language, include-images flag and the analysis parameters — the
 * numbers and preview imagery are assembled server-side, and the parameters
 * let a cold cache recompute the artifact instead of failing with "expired".
 * User-initiated (privacy).
 */
export default function CompareSummaryTab() {
  const result = useCompareStore((s) => s.result);
  const language = useCompareStore((s) => s.summaryLanguage);
  const setLanguage = useCompareStore((s) => s.setSummaryLanguage);
  const includeImages = useCompareStore((s) => s.summaryIncludeImages);
  const setIncludeImages = useCompareStore((s) => s.setSummaryIncludeImages);
  const status = useCompareStore((s) => s.summaryStatus);
  const phase = useCompareStore((s) => s.summaryPhase);
  const data = useCompareStore((s) => s.summaryData);
  const error = useCompareStore((s) => s.summaryError);
  const errorCode = useCompareStore((s) => s.summaryErrorCode);
  const imagesFallback = useCompareStore((s) => s.summaryImagesFallback);
  const fetchSummary = useCompareStore((s) => s.fetchSummary);
  const lockedAi = useLocked("ai.summary");

  if (!result) return null;

  const loading = status === "loading";
  const disabled = !result.aiEnabled || lockedAi;
  // The failure involved the preview images when a 400/bad-output hit while
  // they were attached — offer a statistics-only retry.
  const imagesInvolved =
    status === "error" && includeImages && (errorCode === "AI_BAD_REQUEST" || errorCode === "AI_BAD_OUTPUT");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded border border-border bg-surface-2 p-2.5">
        <div className="flex flex-col gap-2">
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
              <Languages size={12} aria-hidden />
              Language
            </p>
            <Segmented
              ariaLabel="Summary language"
              value={language}
              onChange={(value) => setLanguage(value as SummaryLanguage)}
              options={[
                { value: "en", label: "English" },
                { value: "hi", label: "हिन्दी" },
              ]}
            />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={includeImages}
            onClick={() => setIncludeImages(!includeImages)}
            className={cn(
              "flex w-full items-center gap-2 rounded border border-border bg-surface px-2 py-1.5 text-left text-xs transition-colors duration-150",
              includeImages ? "text-text" : "text-muted",
            )}
            title="Sends small (≤768 px) preview crops of the analysed area to the AI model."
          >
            <span
              aria-hidden
              className={cn(
                "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border",
                includeImages ? "border-accent bg-accent" : "border-border bg-surface",
              )}
            >
              {includeImages && (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="rgb(var(--accent-fg))"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-2.5 w-2.5"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
            <ImageIcon size={13} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">Include map previews</span>
          </button>
        </div>
        {includeImages && (
          <p className="text-[10px] leading-relaxed text-muted">
            Preview images of the analysed area (≤768 px) are sent to the AI model together with the
            statistics. Leave off to share numbers only.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              disabled={loading || disabled}
              title={
                lockedAi
                  ? "AI summaries require an SSO ID."
                  : disabled
                    ? "AI summaries are disabled on this deployment (no GEMINI_API_KEY)."
                    : "Ask the AI to explain this result in plain language."
              }
              onClick={() => void fetchSummary()}
            >
              <Sparkles size={13} />
              {status === "done" ? "Regenerate summary" : "Generate summary"}
            </Button>
            <FeatureLock capability="ai.summary" label="AI summary" />
          </div>
          <QuotaReadout kind="aiSummary" className="text-center" />
          {loading && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              {phase === "ensure"
                ? "Re-running the analysis… (cold cache; up to a minute)"
                : "Writing the summary…"}
            </span>
          )}
          {status === "error" && !loading && (
            <Button size="sm" className="w-full" onClick={() => void fetchSummary()}>
              <RefreshCw size={13} />
              Retry
            </Button>
          )}
          {imagesInvolved && !loading && (
            <Button
              size="sm"
              variant="secondary"
              className="w-full"
              title="Retry the summary with the statistics only (no preview images are sent)."
              onClick={() => {
                setIncludeImages(false);
                window.setTimeout(() => void fetchSummary(), 0);
              }}
            >
              Try without images
            </Button>
          )}
        </div>
        {lockedAi && (
          <p className="text-[11px] text-muted">
            AI summaries are part of the full-access SSO session — guests browse maps and statistics
            with tighter limits.
          </p>
        )}
        {disabled && !lockedAi && (
          <p className="text-[11px] text-muted">
            This deployment has no AI key configured — set <code className="mono-nums">GEMINI_API_KEY</code>{" "}
            server-side to enable the summary.
          </p>
        )}
        {status === "error" && error && (
          <p className="flex flex-wrap items-baseline gap-1.5 text-xs text-danger">
            <span>{error}</span>
            {errorCode && (
              <span className="mono-nums rounded-sm border border-border bg-surface px-1 py-px text-[10px] text-muted">
                {errorCode}
              </span>
            )}
          </p>
        )}
      </div>

      {data && status === "done" && (
        <article className="flex flex-col gap-3 text-xs leading-relaxed text-text">
          {imagesFallback && (
            <p className="rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-text">
              Generated from statistics only because the images could not be processed.
            </p>
          )}
          <p className="whitespace-pre-wrap">{data.overview}</p>
          <SummaryList title="Key changes" items={data.keyChanges} />
          <SummaryList title="Where the changes occurred" items={data.whereChangesOccurred} />
          <SummaryList title="Visual observations" items={data.visualObservations} />
          <SummaryList title="Reliability & caveats" items={data.reliabilityAndCaveats} />
          <SummaryList title="Suggested next checks" items={data.suggestedNextChecks} />
          <p className="text-[10px] text-muted">
            AI-generated summary — verify every statement against the maps and statistics.
          </p>
        </article>
      )}

      {!data && status !== "loading" && status !== "error" && (
        <p className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
          Generate a plain-language summary of this comparison — what changed, where, and how much
          to trust it.
        </p>
      )}
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <section>
      <p className="mb-1 text-[11px] font-medium text-muted">{title}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
