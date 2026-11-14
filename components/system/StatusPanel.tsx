"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Database, Mail, RefreshCw, Sparkles, Satellite } from "lucide-react";
import type { QuotaKind } from "@/lib/auth/permissions";
import { cn } from "@/components/ui/cn";
import Button from "@/components/ui/Button";
import { QuotaReadout } from "@/components/ui/FeatureLock";

interface HealthCheck {
  status: string;
  message?: string;
  tokenValidForSeconds?: number;
  model?: string;
  provider?: string;
}

interface SystemStatusPayload {
  dataSource: string;
  buildVersion: string;
  districts: number;
  tehsils: number;
  health: { cdse: HealthCheck; gemini: HealthCheck; email: HealthCheck };
  today: { render: number; analyze: number; ai: number; email: number };
  roleUsage: Record<QuotaKind, { used: number; limit: number; remaining: number }>;
  limits: {
    searchWindowDays: number | null;
    tileZoomMax: number;
    searchesPerDay: number;
    comparePerDay: number;
    aiSummariesPerDay: number;
    downloadMaxPx: number;
  };
  emailProvider: string;
}

const STATUS_TONE: Record<string, string> = {
  ok: "bg-accent-soft text-accent",
  mock: "bg-surface-2 text-muted",
  unconfigured: "bg-surface-2 text-warning",
  disabled: "bg-surface-2 text-muted",
  error: "bg-surface-2 text-danger",
  checking: "bg-surface-2 text-muted",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold", STATUS_TONE[status] ?? STATUS_TONE.checking)}
    >
      {status === "ok" ? "✓" : status === "error" ? "!" : "·"}
    </span>
  );
}

function HealthRow({ label, Icon, health }: { label: string; Icon: typeof Satellite; health: HealthCheck }) {
  return (
    <li className="flex items-start gap-2 rounded border border-border bg-surface px-2 py-1.5">
      <Icon size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <StatusDot status={health.status} />
          <span className="text-xs font-medium text-text">{label}</span>
          <span className="mono-nums ml-auto text-[10px] uppercase tracking-wide text-muted">
            {health.status}
          </span>
        </div>
        {health.message && (
          <p className="mt-0.5 break-words text-[11px] leading-snug text-muted">{health.message}</p>
        )}
        {!health.message && health.tokenValidForSeconds !== undefined && (
          <p className="mono-nums mt-0.5 text-[11px] text-muted">
            Token valid ~{Math.round(health.tokenValidForSeconds / 60)} min
          </p>
        )}
        {!health.message && health.model && (
          <p className="mono-nums mt-0.5 text-[11px] text-muted">Model {health.model}</p>
        )}
      </div>
    </li>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface px-2 py-1.5">
      <p className="mono-nums text-lg font-semibold leading-tight text-text">{value.toLocaleString("en")}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

/**
 * SSO-only System status rail panel: CDSE / Gemini / email health with
 * reason codes, today's deployment counters, the caller's quota usage and
 * build/boundary facts. Data from GET /api/system/status (system.status).
 */
export default function StatusPanel() {
  const [data, setData] = useState<SystemStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/system/status", { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `Status unavailable (HTTP ${response.status}).`);
        setData(null);
        return;
      }
      setData((await response.json()) as SystemStatusPayload);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 section-label">
          <Activity size={13} aria-hidden />
          System status
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh system status"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} aria-hidden />
        </Button>
      </div>

      {loading && !data && (
        <p role="status" className="text-xs text-muted">
          Loading status…
        </p>
      )}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {data && (
        <>
          <ul className="flex flex-col gap-1.5">
            <HealthRow label="Copernicus (CDSE)" Icon={Satellite} health={data.health.cdse} />
            <HealthRow label="AI summary (Gemini)" Icon={Sparkles} health={data.health.gemini} />
            <HealthRow label="Email report" Icon={Mail} health={data.health.email} />
          </ul>

          <section className="flex flex-col gap-1.5">
            <p className="section-label">Today (UTC)</p>
            <div className="grid grid-cols-2 gap-1.5">
              <Counter label="Renders" value={data.today.render} />
              <Counter label="Analyses" value={data.today.analyze} />
              <Counter label="AI summaries" value={data.today.ai} />
              <Counter label="Emails" value={data.today.email} />
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <p className="section-label">Your session quota</p>
            <QuotaReadout kind="search" showWhenFull />
            <QuotaReadout kind="compare" showWhenFull />
            <QuotaReadout kind="aiSummary" showWhenFull />
          </section>

          <section className="flex flex-col gap-1 rounded border border-border bg-surface-2 px-2 py-1.5 text-[11px] text-muted">
            <p className="flex items-center gap-1.5">
              <Database size={12} aria-hidden />
              <span className="text-text">{data.dataSource === "cdse" ? "Live Copernicus data" : "Demo data"}</span>
            </p>
            <p className="mono-nums">
              Build {data.buildVersion} · {data.districts} districts · {data.tehsils} tehsils
            </p>
            <p className="mono-nums">
              Window {data.limits.searchWindowDays === null ? "full archive" : `${data.limits.searchWindowDays} d`} ·
              tiles z≤{data.limits.tileZoomMax} · PNG ≤{data.limits.downloadMaxPx} px
            </p>
            <p className="mono-nums">
              Email provider {data.emailProvider} · search {data.roleUsage.search.used}/{data.roleUsage.search.limit} ·
              analyses {data.roleUsage.compare.used}/{data.roleUsage.compare.limit}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
