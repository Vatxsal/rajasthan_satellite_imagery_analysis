import { render } from "@react-email/render";
import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { assertHtmlBudget, formatIstDateTime, sanitizeSubject } from "./data";

/**
 * High-resolution (Bhoonidhi) imagery request notification to the fixed
 * admin mailbox (EMAIL_FIXED_RECIPIENT). Same format rules as the access
 * request: 600 px, table layout, fully inline-styled, no JS/external CSS,
 * web-safe fonts, light palette (dark-mode-safe), plain-text alternative
 * rendered from the same component. The AOI GeoJSON itself rides as an
 * `aoi.geojson` attachment on the message (see the route) — the body keeps
 * a compact bbox/geometry summary so the email is readable without it.
 */

const FONT = 'Arial, Helvetica, "Noto Sans Devanagari", "Nirmala UI", sans-serif';
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
};

export interface VhrRequestEmailData {
  /** Selection name or "Rajasthan (state)". */
  areaName: string;
  /** Requested date window from the Filters panel (null when untouched). */
  startDate: string | null;
  endDate: string | null;
  /** Scene footprint bbox of the requested AOI, EPSG:4326. */
  bbox: [number, number, number, number];
  /** Geometry type + vertex count (the file itself is attached). */
  geometrySummary: string;
  /** ISO instant → formatted to IST by the renderer. */
  requestedAt: string;
  /** Opaque request id (no personal data). */
  requestId: string;
  /** Session subject or role — helps the admin spot repeat requests. */
  requester: string;
  /** Site origin for the admin to open the app. */
  siteUrl: string;
}

/** "High-resolution imagery request · {Area}" — single line, ≤90 chars. */
export function buildVhrSubject(areaName: string): string {
  return sanitizeSubject(`High-resolution imagery request · ${areaName}`);
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

function mutedStyle(size = 12): React.CSSProperties {
  return {
    margin: "0",
    fontSize: `${size}px`,
    lineHeight: "18px",
    color: C.muted,
    fontFamily: FONT,
  };
}

function row(label: string, value: string, extra?: React.CSSProperties): ReactNode {
  return (
    <tr>
      <td
        style={{
          width: "170px",
          padding: "8px 14px",
          borderBottom: `1px solid ${C.border}`,
          verticalAlign: "top",
        }}
      >
        <Text style={mutedStyle(11)}>{label}</Text>
      </td>
      <td style={{ padding: "8px 14px", borderBottom: `1px solid ${C.border}`, ...extra }}>
        <Text style={bodyStyle(13)}>{value}</Text>
      </td>
    </tr>
  );
}

function formatBBox(bbox: [number, number, number, number]): string {
  return bbox.map((value) => value.toFixed(4)).join(", ");
}

export function VhrRequestEmail(data: VhrRequestEmailData): ReactNode {
  const requestedAt = formatIstDateTime(data.requestedAt);
  const window =
    data.startDate && data.endDate ? `${data.startDate} → ${data.endDate}` : "Not specified";
  return (
    <Html lang="en">
      <Head />
      <Preview>{`High-resolution imagery request for ${data.areaName} — ${data.requestId}`}</Preview>
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
                <td bgcolor={C.band} style={{ backgroundColor: C.band, padding: "18px 24px" }}>
                  <Text
                    style={{
                      margin: "0",
                      fontSize: "18px",
                      fontWeight: "bold",
                      color: C.bandText,
                      fontFamily: FONT,
                    }}
                  >
                    High-resolution imagery request
                  </Text>
                  <Text
                    style={{
                      margin: "4px 0 0 0",
                      fontSize: "13px",
                      color: "#cbd5e1",
                      fontFamily: FONT,
                    }}
                  >
                    Rajasthan Imagery Explorer · NRSC Bhoonidhi
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
                <td style={{ padding: "16px 24px 0 24px" }}>
                  <Text style={bodyStyle(14)}>
                    A session requested high-resolution imagery for{" "}
                    <strong>{data.areaName}</strong>.
                  </Text>
                </td>
              </tr>

              {/* Details */}
              <tr>
                <td style={{ padding: "12px 24px 0 24px" }}>
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
                      {row("Area", data.areaName)}
                      {row("Requested window", window)}
                      {row("AOI bbox (w, s, e, n)", formatBBox(data.bbox), {
                        fontFamily: MONO,
                        fontSize: "12px",
                      })}
                      {row("Geometry", data.geometrySummary)}
                      {row("Requested", requestedAt)}
                      {row("Requester", data.requester, { fontFamily: MONO, fontSize: "12px" })}
                      {row("Request id", data.requestId, { fontFamily: MONO, fontSize: "12px" })}
                      {row("Site", data.siteUrl, {
                        fontFamily: MONO,
                        fontSize: "11px",
                        wordBreak: "break-all",
                      })}
                    </tbody>
                  </table>
                </td>
              </tr>

              {/* Admin hint */}
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
                          <Text style={{ ...bodyStyle(13), fontWeight: "bold", marginBottom: "4px" }}>
                            How to ingest this AOI
                          </Text>
                          <Text style={mutedStyle(12)}>
                            1. Download the attached <strong>aoi.geojson</strong>.
                            <br />
                            2. Run the <strong>vhr-ingest</strong> GitHub Actions workflow (mode{" "}
                            <strong>search</strong> or <strong>ingest</strong>) with the AOI file and
                            the wanted date window.
                            <br />
                            3. Re-run with mode <strong>local-file</strong> if the download must come
                            from the Bhoonidhi portal order.
                          </Text>
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
                  <Text style={mutedStyle(11)}>
                    This email was automatically generated by the Rajasthan Imagery Explorer
                    website.
                  </Text>
                  <Text style={{ ...mutedStyle(11), marginTop: "6px" }}>
                    Reply to this message to contact the requester directly.
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

export interface RenderedVhrRequestEmail {
  subject: string;
  html: string;
  text: string;
}

/** Renders HTML + plain-text parity and enforces the 100 KB budget. */
export async function renderVhrRequestEmail(
  data: VhrRequestEmailData,
): Promise<RenderedVhrRequestEmail> {
  const subject = buildVhrSubject(data.areaName);
  const html = await render(VhrRequestEmail(data));
  const text = await render(VhrRequestEmail(data), {
    plainText: true,
    htmlToTextOptions: {
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "[data-skip-in-text=true]", format: "skip" },
        { selector: "a", options: { linkBrackets: false, hideLinkHrefIfSameAsText: true } },
        { selector: "table", format: "dataTable" },
      ],
    },
  });
  assertHtmlBudget(html);
  if (text.trim().length === 0) {
    throw new Error("EMAIL_TEXT_EMPTY: plain-text alternative rendered empty");
  }
  return { subject, html, text };
}
