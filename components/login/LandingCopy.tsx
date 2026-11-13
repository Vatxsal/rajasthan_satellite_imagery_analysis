/**
 * Left-column copy for /login: the editorial headline (two revealed lines),
 * the value sentence, three numbered change lines, and the computed facts
 * strip. Server component — motion is CSS-only (rse-line / rse-settle in
 * login.css), counts arrive as props from the boundary GeoJSON (never
 * hard-coded; guarded by scripts/boundaries.test.ts).
 */

interface LandingCopyProps {
  districtCount: number;
  tehsilCount: number;
  resolutionM: number;
  revisitDays: number;
}

const CHANGE_LINES: { index: string; head: string; body: string }[] = [
  { index: "01", head: "Water.", body: "Lake and reservoir extents, pre- and post-monsoon." },
  { index: "02", head: "Land.", body: "Construction, bare ground, and cleared plots." },
  { index: "03", head: "Crops.", body: "Kharif fields green up, then harvest, in weeks." },
];

export default function LandingCopy({
  districtCount,
  tehsilCount,
  resolutionM,
  revisitDays,
}: LandingCopyProps) {
  const facts: { label: string; value: string }[] = [
    { label: "Districts", value: String(districtCount) },
    { label: "Tehsils", value: String(tehsilCount) },
    { label: "Resolution", value: `${resolutionM} m` },
    { label: "Revisit", value: `~${revisitDays} d` },
  ];

  return (
    <div className="mt-4 flex flex-col gap-5 lg:mt-5">
      <h1 className="text-fluid-landing font-display font-semibold leading-[1.04] tracking-[-0.015em] text-text">
        <span className="block overflow-hidden pb-[0.06em] -mb-[0.06em]">
          <span className="rse-line block" style={{ animationDelay: "140ms" }}>
            Rajasthan,
          </span>
        </span>
        <span className="block overflow-hidden pb-[0.08em] -mb-[0.02em]">
          <span className="rse-line block" style={{ animationDelay: "300ms" }}>
            week by week.
          </span>
        </span>
      </h1>

      <p
        className="rse-rise max-w-[54ch] text-[15px] leading-6 text-muted"
        style={{ animationDelay: "420ms" }}
      >
        Compare any two dates across the state at {resolutionM} m detail, and get an AI-written
        change report in your inbox.
      </p>

      <ol
        className="rse-rise flex flex-col gap-2.5 border-t border-border pt-4"
        style={{ animationDelay: "500ms" }}
      >
        {CHANGE_LINES.map((line) => (
          <li key={line.index} className="flex gap-3 text-sm leading-5">
            <span className="mono-nums shrink-0 text-[12px] font-medium text-muted">
              {line.index}
            </span>
            <span className="text-text">
              <span className="font-semibold">{line.head}</span>{" "}
              <span className="text-muted">{line.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <dl
        className="rse-rise grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 @md:grid-cols-4"
        style={{ animationDelay: "580ms" }}
      >
        {facts.map((fact, index) => (
          <div key={fact.label} className="flex flex-col gap-0.5">
            <dt className="section-label">{fact.label}</dt>
            <dd
              className="rse-settle font-display text-[26px] font-semibold leading-7 text-text"
              style={{ animationDelay: `${640 + index * 70}ms` }}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
