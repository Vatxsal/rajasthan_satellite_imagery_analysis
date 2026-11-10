/**
 * EMAIL_PROVIDER=console (default): never contacts a network. Every send is
 * written to .email-preview/ (gitignored) as .html + .txt + .eml, with the
 * inline images and attachments as loose files next to them — the whole
 * pipeline (route → template → provider) stays exercisable without any
 * credentials, locally and in CI.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildEml } from "../eml";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

export const PREVIEW_DIR_NAME = ".email-preview";

export interface ConsoleProviderOptions {
  /** Output directory (defaults to <cwd>/.email-preview). */
  dir?: string;
  from: string;
}

/** `user@example.com` → `user-example-com` (filesystem-safe file stem). */
function slugify(email: string): string {
  const slug = email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "recipient").slice(0, 40);
}

export function createConsoleProvider(options: ConsoleProviderOptions): EmailProvider {
  return {
    id: "console",
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const dir = options.dir ?? path.join(process.cwd(), PREVIEW_DIR_NAME);
      await mkdir(dir, { recursive: true });

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const stem = `sent-${stamp}-${slugify(message.to)}`;
      const base = path.join(dir, stem);

      await writeFile(`${base}.html`, message.html, "utf8");
      await writeFile(`${base}.txt`, message.text, "utf8");
      await writeFile(
        `${base}.eml`,
        buildEml({
          from: options.from,
          to: message.to,
          replyTo: message.replyTo,
          subject: message.subject,
          html: message.html,
          text: message.text,
          attachments: [
            ...(message.inlineImages ?? []).map((image) => ({
              filename: image.filename,
              content: image.content,
              contentType: image.contentType,
              cid: image.cid,
            })),
            ...(message.attachments ?? []).map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              contentType: attachment.contentType,
            })),
          ],
        }),
        "utf8",
      );

      // Loose copies of every binary part make size checks a glance-away.
      const binaryParts = [...(message.inlineImages ?? []), ...(message.attachments ?? [])];
      for (let index = 0; index < binaryParts.length; index++) {
        const part = binaryParts[index]!;
        await writeFile(`${base}-${index}-${path.basename(part.filename)}`, part.content);
      }

      return {
        provider: "console",
        messageId: path.join(PREVIEW_DIR_NAME, `${stem}.html`),
      };
    },
  };
}
