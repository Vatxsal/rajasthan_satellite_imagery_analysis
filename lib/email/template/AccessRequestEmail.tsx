import { render } from "@react-email/render";
import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { assertHtmlBudget, formatIstDateTime, sanitizeSubject } from "./data";

/**
 * Access-request notification to the fixed admin mailbox
 * (EMAIL_FIXED_RECIPIENT). Same format rules as the report email: 600 px,
 * table layout, fully inline-styled, no JS/external CSS, web-safe fonts,
 * light palette (dark-mode-safe), plain-text alternative rendered from the
 * same component. Every field is JSX-escaped; the subject is CR/LF-stripped
 * and capped at 90 chars.
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
  accentText: "#ffffff",
};

export interface AccessRequestEmailData {
  name: string;
  company: string;
  /** Requester's address — used as Reply-To only, never as a recipient. */
  email: string;
  reason: string;
  /** ISO instant → formatted to IST by the renderer. */
  requestedAt: string;
  /** Opaque request id (no personal data). */
  requestId: string;
  /** Site origin for the admin to open the app. */
  siteUrl: string;
}

/** "Access request · {Company} · {Name}" — single line, ≤90 chars. */
export function buildAccessSubject(company: string, name: string): string {
  return sanitizeSubject(`Access request · ${company} · ${name}`);
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

export function AccessRequestEmail(data: AccessRequestEmailData): ReactNode {
  const requestedAt = formatIstDateTime(data.requestedAt);
  return (
    <Html lang="en">
      <Head />
      <Preview>
        {`${data.name} (${data.company}) requested access — ${data.requestId}`}
      </Preview>
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
                    Access request
                  </Text>
                  <Text
                    style={{
                      margin: "4px 0 0 0",
                      fontSize: "13px",
                      color: "#cbd5e1",
                      fontFamily: FONT,
                    }}
                  >
                    Rajasthan Imagery Explorer · SSO access
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
                    <strong>{data.name}</strong> ({data.company}) requested SSO access to the
                    Rajasthan Imagery Explorer.
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
                      {row("Full name", data.name)}
                      {row("Company / organisation", data.company)}
                      {row("Reply-to email", data.email, { fontFamily: MONO, fontSize: "12px" })}
                      {row("Reason for access", data.reason, { whiteSpace: "pre-wrap" })}
                      {row("Requested", requestedAt)}
                      {row("Request id", data.requestId, { fontFamily: MONO, fontSize: "12px" })}
                      {row("Site", data.siteUrl, { fontFamily: MONO, fontSize: "11px", wordBreak: "break-all" })}
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
                            How to create this user
                          </Text>
                          <Text style={mutedStyle(12)}>
                            1. Run <strong>npm run auth:new-user -- --username &lt;name&gt;</strong>{" "}
                            (add <strong>--display &quot;Name&quot;</strong> for the display name).
                            <br />
                            2. Add the printed JSON entry to the <strong>SSO_USERS</strong> env var
                            in Vercel (Sensitive).
                            <br />
                            3. Redeploy, then reply to this email with the generated password.
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
                    Reply to this message to contact the requester directly. Do not forward the
                    credentials over unencrypted channels.
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

export interface RenderedAccessRequestEmail {
  subject: string;
  html: string;
  text: string;
}

/** Renders HTML + plain-text parity and enforces the 100 KB budget. */
export async function renderAccessRequestEmail(
  data: AccessRequestEmailData,
): Promise<RenderedAccessRequestEmail> {
  const subject = buildAccessSubject(data.company, data.name);
  const html = await render(AccessRequestEmail(data));
  const text = await render(AccessRequestEmail(data), {
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
