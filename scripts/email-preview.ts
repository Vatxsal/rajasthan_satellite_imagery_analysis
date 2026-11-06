/**
 * Phase 3 template previews — renders every fixture through the real
 * React Email pipeline into .email-preview/ (HTML + plain text). Never
 * sends anything; safe to run any time.
 *
 * Usage: npm run email:preview
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildReportEmailData,
  renderReportEmail,
} from "../lib/email/template";
import { buildFixtures } from "../lib/email/template/fixtures";

const OUT_DIR = path.join(process.cwd(), ".email-preview");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  for (const fixture of buildFixtures()) {
    const data = buildReportEmailData(fixture.input);
    const rendered = await renderReportEmail(data);
    const htmlFile = path.join(OUT_DIR, `${fixture.name}.html`);
    const txtFile = path.join(OUT_DIR, `${fixture.name}.txt`);
    fs.writeFileSync(htmlFile, rendered.html, "utf8");
    fs.writeFileSync(txtFile, rendered.text, "utf8");
    const htmlBytes = Buffer.byteLength(rendered.html, "utf8");
    const textBytes = Buffer.byteLength(rendered.text, "utf8");
    const missingText = !rendered.text.includes(data.areaName.slice(0, 12));
    if (missingText) failed = true;
    console.log(
      `${fixture.name.padEnd(12)} html=${String(htmlBytes).padStart(6)} B  ` +
        `text=${String(textBytes).padStart(5)} B  subject="${rendered.subject}"` +
        (missingText ? "  [WARN: area missing from plain text]" : ""),
    );
  }
  console.log(`\npreviews written to ${OUT_DIR}`);
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("EMAIL PREVIEW FAILED:", error);
  process.exit(1);
});
