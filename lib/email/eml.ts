/**
 * Minimal RFC 5322/2045 writer for the console provider's .eml previews.
 *
 * Good enough to open in a real mail client (multipart/related wrapping
 * multipart/alternative, UTF-8 bodies, base64 parts for anything non-ASCII
 * or binary) without pulling a MIME library — the preview path never talks
 * to an MTA, so strictness beyond "opens and renders" buys nothing.
 */
import { randomBytes } from "node:crypto";

/** CRLF is mandatory on the wire — every part is joined with \r\n. */
const CRLF = "\r\n";

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7e) return false;
    // Tab/LF/CR are normal in bodies; other control characters are not.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

/** RFC 2047 encoded-word for non-ASCII header values (subjects, names).
 *  CR/LF are stripped outright — headers must stay single-line. */
function encodeHeaderValue(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, " ").trim();
  if (isAscii(singleLine)) return singleLine;
  return `=?UTF-8?B?${Buffer.from(singleLine, "utf8").toString("base64")}?=`;
}

/** 76-char line folding for base64 bodies (RFC 2045 §6.8). */
function foldBase64(encoded: string): string {
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

interface TextPart {
  contentType: string;
  body: string;
}

function encodeTextPart(part: TextPart): string {
  const headers = [`Content-Type: ${part.contentType}`];
  let body: string;
  if (isAscii(part.body)) {
    headers.push("Content-Transfer-Encoding: 8bit");
    body = part.body;
  } else {
    headers.push("Content-Transfer-Encoding: base64");
    body = foldBase64(Buffer.from(part.body, "utf8").toString("base64"));
  }
  return [...headers, "", body].join(CRLF);
}

interface BinaryPart {
  contentType: string;
  filename: string;
  content: Buffer;
  /** Set for inline images (Content-ID + inline disposition). */
  cid?: string;
}

function encodeBinaryPart(part: BinaryPart): string {
  const headers = [
    `Content-Type: ${part.contentType}; name="${part.filename}"`,
    "Content-Transfer-Encoding: base64",
    part.cid
      ? `Content-ID: <${part.cid}>${CRLF}Content-Disposition: inline; filename="${part.filename}"`
      : `Content-Disposition: attachment; filename="${part.filename}"`,
  ];
  const body = foldBase64(part.content.toString("base64"));
  return [...headers, "", body].join(CRLF);
}

function boundary(): string {
  return `rse-${randomBytes(12).toString("hex")}`;
}

export interface EmlInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string; cid?: string }>;
}

/** Builds a complete .eml document for a report message. */
export function buildEml(input: EmlInput): string {
  const headers = [
    `From: ${encodeHeaderValue(input.from)}`,
    `To: ${encodeHeaderValue(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@rse.local>`,
    "MIME-Version: 1.0",
  ];

  const textPart = encodeTextPart({ contentType: "text/plain; charset=utf-8", body: input.text });
  const htmlPart = encodeTextPart({ contentType: "text/html; charset=utf-8", body: input.html });
  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    // Nothing inline: plain multipart/alternative at the top level.
    const altBoundary = boundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    const body = [
      `--${altBoundary}`,
      textPart,
      `--${altBoundary}`,
      htmlPart,
      `--${altBoundary}--`,
    ].join(CRLF);
    return [...headers, "", body, ""].join(CRLF);
  }

  // Inline images/CSVs: multipart/related wrapping the alternative pair.
  const relatedBoundary = boundary();
  const innerBoundary = boundary();
  const relatedParts = attachments.map((attachment) =>
    [
      `--${relatedBoundary}`,
      encodeBinaryPart({
        contentType: attachment.contentType,
        filename: attachment.filename,
        content: attachment.content,
        cid: attachment.cid,
      }),
    ].join(CRLF),
  );
  headers.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
  const body = [
    `--${relatedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
    "",
    `--${innerBoundary}`,
    textPart,
    `--${innerBoundary}`,
    htmlPart,
    `--${innerBoundary}--`,
    ...relatedParts,
    `--${relatedBoundary}--`,
  ].join(CRLF);
  return [...headers, "", body, ""].join(CRLF);
}
