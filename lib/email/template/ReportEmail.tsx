import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import { getCopy } from "./copy";
import {
  buildPreheader,
  escapeHtml,
  formatEmailDate,
  formatHa,
  formatNumber,
  formatPct,
  type ReportEmailData,
} from "./data";

/**
 * The emailed change report: 600 px, table-based, fully inline-styled,
 * no JavaScript, no external CSS, web-safe fonts + Devanagari fallback.
 * Rendered twice by renderReportEmail() — HTML and plain-text parity —
 * so every string here must survive both channels.
 */

const FONT =
  'Arial, Helvetica, "Noto Sans Devanagari", "Nirmala UI", sans-serif';
const MONO = '"Courier New", Courier, monospace';

const C = {
  page: "#f1f5f9",
  surface: "#ffffff",
  band: "#0f172a",
  bandText: "#ffffff",
  text: "#0f172a",
  muted: "#475569",
  border: "#e2e8f0",
  subtle: "#f8fafc",
  accent: "#1d4ed8",
  accentText: "#ffffff",
};

function headingStyle(): React.CSSProperties {
  return {
    margin: "0 0 8px 0",
    fontSize: "16px",
    fontWeight: "bold",
    color: C.text,
    fontFamily: FONT,
  };
}

function mutedStyle(size = 12): React.CSSProperties {
  return {
    margin: "0",
    fontSize: `${size}px`,
    lineHeight: "18px",
    color: C.muted,
    fontFamily: FONT,
  };
}

function bodyStyle(size = 13): React.CSSProperties {
  return {
    margin: "0",
    fontSize: `${size}px`,
    lineHeight: "20px",
    color: C.text,
    fontFamily: FONT,
  };
}

function thStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    padding: "8px 6px",
    textAlign: "left",
    fontSize: "11px",
    fontWeight: "bold",
    color: C.muted,
    borderBottom: `1px solid ${C.border}`,
    fontFamily: FONT,
    ...extra,
  };
}

function tdStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    padding: "7px 6px",
    fontSize: "12px",
    color: C.text,
    borderBottom: `1px solid ${C.border}`,
    fontFamily: FONT,
    verticalAlign: "top",
    ...extra,
  };
}

function swatch(label: string, hex: string): ReactNode {
  return (
    <span>
      <span
        style={{
          display: "inline-block",
          width: "10px",
          height: "10px",
          marginRight: "6px",
          backgroundColor: hex,
          border: "1px solid rgba(15,23,42,0.3)",
          borderRadius: "2px",
          verticalAlign: "middle",
        }}
      />
      {label}
    </span>
  );
}

function cellPair(label: string, value: string): ReactNode {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ width: "100%", borderCollapse: "collapse" }}
    >
      <tbody>
        <tr>
          <td style={{ paddingBottom: "2px" }}>
            <Text style={mutedStyle(11)}>{label}</Text>
          </td>
        </tr>
        <tr>
          <td>
            <Text
              style={{
                ...bodyStyle(17),
                fontWeight: "bold",
                lineHeight: "22px",
              }}
            >
              {value}
            </Text>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Outlook-safe bulletproof CTA (table + bgcolor + VML conditional). */
function ctaHtml(href: string, label: string): string {
  const h = escapeHtml(href);
  const l = escapeHtml(label);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;border-collapse:separate;">` +
    `<tr><td align="center" bgcolor="${C.accent}" style="border-radius:6px;">` +
    `<a href="${h}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:bold;color:${C.accentText};text-decoration:none;border-radius:6px;">${l}</a>` +
    `</td></tr></table>` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:44px;width:250px;vtext-anchor:middle;" arcsize="14%" strokecolor="${C.accent}" fillcolor="${C.accent}"><w:anchorlock/><center style="color:${C.accentText};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${l}</center></v:roundrect><![endif]-->`
  );
}

function summaryList(title: string, items: string[]): ReactNode {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: "10px" }}>
      <Text style={{ ...bodyStyle(13), fontWeight: "bold" }}>{title}</Text>
      {items.map((item, index) => (
        <Text
          key={index}
          style={{
            ...bodyStyle(13),
            marginLeft: "12px",
            whiteSpace: "pre-wrap",
          }}
        >
          • {item}
        </Text>
      ))}
    </div>
  );
}

export function ReportEmail(data: ReportEmailData): ReactNode {
  const copy = getCopy(data.language);
  const dateA = formatEmailDate(data.dateA);
  const dateB = formatEmailDate(data.dateB);
  const eventLink = (id: string): string => `${data.deepLink}&e=${id}`;
  const generated = formatEmailDate(data.generatedAt.slice(0, 10));

  return (
    <Html lang={data.language}>
      <Head />
      <Preview>{buildPreheader(data)}</Preview>
      <Body
        style={{
          margin: "0",
          padding: "0",
          backgroundColor: C.page,
          fontFamily: FONT,
        }}
      >
        <Container
          width={600}
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            backgroundColor: C.surface,
          }}
        >
          {/* Header band */}
          <table
            role="presentation"
            cellPadding={0}
            cellSpacing={0}
            border={0}
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <tbody>
              <tr>
                <td
                  bgcolor={C.band}
                  style={{
                    backgroundColor: C.band,
                    padding: "18px 24px",
                  }}
                >
                  <Text
                    style={{
                      margin: "0",
                      fontSize: "18px",
                      fontWeight: "bold",
                      color: C.bandText,
                      fontFamily: FONT,
                    }}
                  >
                    {copy.reportTitle}
                  </Text>
                  <Text
                    style={{
                      margin: "4px 0 0 0",
                      fontSize: "13px",
                      color: "#cbd5e1",
                      fontFamily: FONT,
                    }}
                  >
                    {data.areaName} · {dateA} → {dateB}
                  </Text>
                </td>
              </tr>
            </tbody>
          </table>

          <table
            role="presentation"
            cellPadding={0}
            cellSpacing={0}
            border={0}
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <tbody>
              <tr>
                <td style={{ padding: "10px 24px 0 24px" }}>
                  <Text style={mutedStyle(11)}>{copy.doNotReply}</Text>
                </td>
              </tr>

              {/* Overview card */}
              <tr>
                <td style={{ padding: "14px 24px 0 24px" }}>
                  <table
                    role="presentation"
                    cellPadding={0}
                    cellSpacing={0}
                    border={0}
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      border: `1px solid ${C.border}`,
                      borderRadius: "6px",
                    }}
                  >
                    <tbody>
                      <tr>
                        <td style={{ padding: "12px 14px" }}>
                          <Text style={headingStyle()}>{copy.overviewHeading}</Text>
                          <Text style={{ ...bodyStyle(15), fontWeight: "bold" }}>
                            {data.areaName}
                          </Text>
                          <Text style={{ ...bodyStyle(12), marginTop: "6px" }}>
                            <strong>{copy.levelLabel[data.areaLevel]}</strong>
                            {" · "}
                            {copy.datesLabel}:{" "}
                            <strong>
                              {dateA} → {dateB}
                            </strong>
                            {" · "}
                            {copy.gapLabel(data.gapDays)}
                            {" · "}
                            {copy.sensitivityLabel}:{" "}
                            <strong>{copy.sensitivity[data.sensitivity]}</strong>
                            {" · "}
                            {copy.minPatchLabel}:{" "}
                            <strong>{formatHa(data.minPatchHa)}</strong>
                            {" · "}
                            {copy.inputModeLabel}:{" "}
                            <strong>{copy.inputMode[data.inputMode]}</strong>
                          </Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>

              {/* At a glance */}
              <tr>
                <td style={{ padding: "16px 24px 0 24px" }}>
                  <Text style={headingStyle()}>{copy.glanceHeading}</Text>
                  <table
                    role="presentation"
                    cellPadding={0}
                    cellSpacing={0}
                    border={0}
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      border: `1px solid ${C.border}`,
                      borderRadius: "6px",
                    }}
                  >
                    <tbody>
                      <tr>
                        <td
                          style={{
                            width: "50%",
                            padding: "10px 14px",
                            borderBottom: `1px solid ${C.border}`,
                          }}
                        >
                          {cellPair(copy.changedArea, formatHa(data.changedHa))}
                        </td>
                        <td
                          style={{
                            width: "50%",
                            padding: "10px 14px",
                            borderBottom: `1px solid ${C.border}`,
                            borderLeft: `1px solid ${C.border}`,
                          }}
                        >
                          {cellPair(copy.shareOfValid, formatPct(data.changedPct))}
                        </td>
                      </tr>
                      <tr>
                        <td style={{ width: "50%", padding: "10px 14px" }}>
                          {cellPair(
                            copy.patchCount,
                            formatNumber(data.patchCount, 0),
                          )}
                        </td>
                        <td
                          style={{
                            width: "50%",
                            padding: "10px 14px",
                            borderLeft: `1px solid ${C.border}`,
                          }}
                        >
                          {cellPair(copy.validCoverage, formatPct(data.validPct))}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>

              {/* Change classes */}
              {data.classes.length > 0 && (
                <tr>
                  <td style={{ padding: "16px 24px 0 24px" }}>
                    <Text style={headingStyle()}>{copy.classesHeading}</Text>
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        border: `1px solid ${C.border}`,
                        borderRadius: "6px",
                      }}
                    >
                      <tbody>
                        <tr bgcolor={C.subtle}>
                          <td style={thStyle({ width: "52%" })}>{copy.colClass}</td>
                          <td style={thStyle({ textAlign: "right" })}>
                            {copy.colArea}
                          </td>
                          <td style={thStyle({ textAlign: "right" })}>
                            {copy.shareOfChange}
                          </td>
                        </tr>
                        {data.classes.map((row) => (
                          <tr key={row.code}>
                            <td style={tdStyle()}>{swatch(row.label, row.hex)}</td>
                            <td
                              style={tdStyle({
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              })}
                            >
                              {formatHa(row.areaHa)}
                            </td>
                            <td
                              style={tdStyle({
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              })}
                            >
                              {formatPct(row.pctOfChange)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}

              {/* Top events */}
              <tr>
                <td style={{ padding: "16px 24px 0 24px" }}>
                  <Text style={headingStyle()}>{copy.eventsHeading}</Text>
                  <Text style={{ ...mutedStyle(11), marginBottom: "8px" }}>
                    {copy.eventsNote}
                  </Text>
                  {data.events.length === 0 ? (
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        border: `1px solid ${C.border}`,
                        borderRadius: "6px",
                      }}
                    >
                      <tbody>
                        <tr>
                          <td style={{ padding: "12px 14px" }}>
                            <Text style={mutedStyle(12)}>{copy.noEvents}</Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : (
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        border: `1px solid ${C.border}`,
                        borderRadius: "6px",
                      }}
                    >
                      <tbody>
                        <tr bgcolor={C.subtle}>
                          <td style={thStyle({ width: "26px" })}>{copy.colRank}</td>
                          <td style={thStyle({ width: "30%" })}>{copy.colClass}</td>
                          <td style={thStyle({ width: "54px" })}>
                            {copy.colConfidence}
                          </td>
                          <td
                            style={thStyle({
                              textAlign: "right",
                              whiteSpace: "nowrap",
                            })}
                          >
                            {copy.colArea}
                          </td>
                          <td style={thStyle({ width: "66px" })}>{copy.colWhere}</td>
                          <td style={thStyle({ width: "94px" })}>
                            {copy.colCoords}
                          </td>
                          <td
                            style={thStyle({
                              width: "70px",
                              whiteSpace: "nowrap",
                            })}
                          >
                            {copy.colMap}
                          </td>
                        </tr>
                        {data.events.map((event) => (
                          <tr key={event.id}>
                            <td
                              style={tdStyle({
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: "bold",
                              })}
                            >
                              {event.rank}
                            </td>
                            <td style={tdStyle()}>
                              {swatch(event.classLabel, event.hex)}
                            </td>
                            <td style={tdStyle({ fontSize: "11px" })}>
                              {event.confidence
                                ? copy.confidence[event.confidence]
                                : copy.confidenceUnknown}
                            </td>
                            <td
                              style={tdStyle({
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                                whiteSpace: "nowrap",
                              })}
                            >
                              {formatHa(event.areaHa)}
                            </td>
                            <td
                              style={tdStyle({
                                fontSize: "11px",
                                maxWidth: "66px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              })}
                              title={event.place}
                            >
                              {event.place || copy.dash}
                            </td>
                            <td
                              style={tdStyle({
                                fontFamily: MONO,
                                fontSize: "10px",
                                whiteSpace: "nowrap",
                                color: C.muted,
                              })}
                            >
                              {event.lat.toFixed(5)}, {event.lon.toFixed(5)}
                            </td>
                            <td
                              style={tdStyle({
                                fontSize: "11px",
                                whiteSpace: "nowrap",
                              })}
                            >
                              <a
                                href={eventLink(event.id)}
                                style={{ color: C.accent, textDecoration: "underline" }}
                              >
                                {copy.viewOnMap}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </td>
              </tr>

              {/* Top tehsils */}
              {data.tehsils.length > 0 && (
                <tr>
                  <td style={{ padding: "16px 24px 0 24px" }}>
                    <Text style={headingStyle()}>{copy.tehsilsHeading}</Text>
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        border: `1px solid ${C.border}`,
                        borderRadius: "6px",
                      }}
                    >
                      <tbody>
                        <tr bgcolor={C.subtle}>
                          <td style={thStyle({ width: "52%" })}>{copy.colTehsil}</td>
                          <td style={thStyle({ textAlign: "right" })}>
                            {copy.colChanged}
                          </td>
                          <td style={thStyle({ textAlign: "right" })}>
                            {copy.shareOfChange}
                          </td>
                        </tr>
                        {data.tehsils.map((row) => (
                          <tr key={row.name}>
                            <td style={tdStyle()}>{row.name}</td>
                            <td
                              style={tdStyle({
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              })}
                            >
                              {formatHa(row.changedHa)}
                            </td>
                            <td
                              style={tdStyle({
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              })}
                            >
                              {formatPct(row.pctOfChange)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}

              {/* AI summary */}
              {data.includeSummary && (
                <tr>
                  <td style={{ padding: "16px 24px 0 24px" }}>
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        border: `1px solid ${C.border}`,
                        borderLeft: `3px solid ${C.accent}`,
                        borderRadius: "6px",
                        backgroundColor: C.subtle,
                      }}
                    >
                      <tbody>
                        <tr>
                          <td style={{ padding: "12px 14px" }}>
                            <Text style={headingStyle()}>{copy.summaryHeading}</Text>
                            {data.summaryUnavailable || !data.summary ? (
                              <Text style={mutedStyle(12)}>
                                {copy.summaryUnavailable}
                              </Text>
                            ) : (
                              <>
                                <Text
                                  style={{
                                    ...bodyStyle(13),
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  {data.summary.overview}
                                </Text>
                                {summaryList(
                                  copy.summarySections.keyChanges,
                                  data.summary.keyChanges,
                                )}
                                {summaryList(
                                  copy.summarySections.where,
                                  data.summary.whereChangesOccurred,
                                )}
                                {summaryList(
                                  copy.summarySections.visual,
                                  data.summary.visualObservations,
                                )}
                                {summaryList(
                                  copy.summarySections.reliability,
                                  data.summary.reliabilityAndCaveats,
                                )}
                                {summaryList(
                                  copy.summarySections.next,
                                  data.summary.suggestedNextChecks,
                                )}
                              </>
                            )}
                            <Text
                              style={{
                                ...mutedStyle(11),
                                marginTop: "10px",
                                fontStyle: "italic",
                              }}
                            >
                              {copy.summaryDisclaimer}
                            </Text>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}

              {/* Change map */}
              {data.image && (
                <tr>
                  <td style={{ padding: "16px 24px 0 24px" }}>
                    <Img
                      src={data.image.src}
                      width={data.image.width}
                      height={data.image.height}
                      alt={data.image.alt}
                      style={{
                        display: "block",
                        width: "100%",
                        maxWidth: `${data.image.width}px`,
                        height: "auto",
                        border: `1px solid ${C.border}`,
                        borderRadius: "6px",
                      }}
                    />
                    <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                      {copy.imageCaption}
                    </Text>
                  </td>
                </tr>
              )}

              {/* CTA */}
              <tr>
                <td
                  style={{
                    padding: "20px 24px 0 24px",
                    textAlign: "center",
                  }}
                >
                  <div
                    dangerouslySetInnerHTML={{
                      __html: ctaHtml(data.deepLink, copy.cta),
                    }}
                  />
                  <Text style={{ ...mutedStyle(11), marginTop: "10px" }}>
                    {copy.ctaNote}
                  </Text>
                  <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                    {copy.orCopyLink}
                  </Text>
                  <Text
                    style={{
                      ...mutedStyle(11),
                      fontFamily: MONO,
                      wordBreak: "break-all",
                      color: C.accent,
                    }}
                  >
                    {data.deepLink}
                  </Text>
                </td>
              </tr>

              {/* How to read this */}
              <tr>
                <td style={{ padding: "16px 24px 0 24px" }}>
                  <table
                    role="presentation"
                    cellPadding={0}
                    cellSpacing={0}
                    border={0}
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      border: `1px solid ${C.border}`,
                      borderLeft: `3px solid ${C.accent}`,
                      borderRadius: "6px",
                      backgroundColor: C.subtle,
                    }}
                  >
                    <tbody>
                      <tr>
                        <td style={{ padding: "12px 14px" }}>
                          <Text
                            style={{
                              ...bodyStyle(13),
                              fontWeight: "bold",
                              marginBottom: "4px",
                            }}
                          >
                            {copy.howToReadHeading}
                          </Text>
                          <Text style={mutedStyle(12)}>{copy.howToRead}</Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>

              {/* Footer */}
              <tr>
                <td
                  style={{
                    padding: "18px 24px 24px 24px",
                    borderTop: `1px solid ${C.border}`,
                    marginTop: "18px",
                  }}
                >
                  <Text style={mutedStyle(11)}>{copy.attribution}</Text>
                  <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                    {copy.consentFooter}
                  </Text>
                  <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                    {copy.generatedOn(generated)} · {copy.autoGenerated}
                  </Text>
                  <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                    {copy.doNotReply}
                  </Text>
                </td>
              </tr>
            </tbody>
          </table>
        </Container>
      </Body>
    </Html>
  );
}

export default ReportEmail;
