import { render } from "@react-email/render";
import { ReportEmail } from "./ReportEmail";
import {
  assertHtmlBudget,
  buildPreheader,
  buildSubject,
  type ReportEmailData,
} from "./data";

export { ReportEmail };
export * from "./copy";
export * from "./data";

export interface RenderedReportEmail {
  subject: string;
  html: string;
  text: string;
  preheader: string;
}

/**
 * Renders the report twice from the same component — HTML for the client
 * and plain text for the text/plain alternative — then enforces the 100 KB
 * budget before anything is handed to a provider.
 */
export async function renderReportEmail(
  data: ReportEmailData,
): Promise<RenderedReportEmail> {
  const subject = buildSubject(data.areaName, data.dateA, data.dateB);
  const preheader = buildPreheader(data);
  const html = await render(ReportEmail(data));
  // Same component, converted with html-to-text: tables become aligned
  // data tables so rows stay distinguishable without the layout.
  const text = await render(ReportEmail(data), {
    plainText: true,
    htmlToTextOptions: {
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "[data-skip-in-text=true]", format: "skip" },
        {
          selector: "a",
          options: { linkBrackets: false, hideLinkHrefIfSameAsText: true },
        },
        { selector: "table", format: "dataTable" },
      ],
    },
  });
  assertHtmlBudget(html);
  if (text.trim().length === 0) {
    throw new Error("EMAIL_TEXT_EMPTY: plain-text alternative rendered empty");
  }
  return { subject, html, text, preheader };
}
