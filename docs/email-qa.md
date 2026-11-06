# Email report — QA log

Feature: `POST /api/compare/email` + the **Email report** dialog (PR: see branch `feat/email-report`).
Last run: **2026-11-06**, local dev (`next dev`, `EMAIL_PROVIDER=console`, Cloudflare always-pass test keys).

## What is automated (`npm test` — 184 tests, all green)

| File | Covers |
| --- | --- |
| `scripts/email-route.test.ts` (17) | Guard flow of `POST /api/compare/email` via the real handler: cross-origin 403, same-origin pass-through, `INVALID_JSON`, schema refine (`dateA === dateB`), honeypot fake 202 (no quota consumed), `EMAIL_INVALID` before quota, `PAYLOAD_TOO_LARGE` (8 KB body cap), Turnstile fail-closed without token / rejected siteverify / accepted siteverify (mocked `challenges.cloudflare.com`), full chain reaching the analysis stage (`CDSE_CONFIG` sentinel), daily quota 429 + `Retry-After`, console-in-production `EMAIL_DISABLED` 503. Plus `GET /api/compare/email/config`: payload shape, cache header, half-configured Turnstile hides the button, site key only when both keys set, production hides the button, no secrets in the payload. |
| `scripts/email-rate.test.ts` (6) | `emailDailyGuard`: per-address, per-IP and deployment caps; global-cap-first ordering; UTC-day rollover; blocked attempts do not consume budget. |
| `scripts/email-providers.test.ts` (11) | SMTP adapter (nodemailer mocked): success with cid + CSV attachments; `EAUTH` → `EMAIL_SEND_FAILED`; connection refused → retryable; 4xx deferral → `EMAIL_RATE_LIMITED` 429 with `retryAfterSeconds=300`; 5xx → rejected. Resend adapter (`fetch` mocked): request shape (Bearer token, `to[]`, base64 `content_id` attachments); 429 → `EMAIL_RATE_LIMITED` with header / 60 s fallback; 401 → credentials error without echoing the key; network failure → retryable. |
| `scripts/email-template.test.ts` (8) | Hostile area/event/summary names never become live markup (escaped entities present, raw `<script>`/`onerror` absent); subject single-line ≤90 chars even with CRLF injection; all 6 fixtures render ≤100 KB with non-empty text; plain-text parity (facts present, no HTML tags); Hindi `lang="hi"` + Devanagari; no-summary fallback copy; `events.csv` RFC-4180 quoting/CRLF/1 MB cap/per-event deep link; `assertHtmlBudget` throws over the cap. |
| `scripts/email.test.ts` (13) | Address handling (injection attempts, masking, hashing), `.eml` writer (multipart, CID, RFC 2047), console provider files, provider factory, `assertEmailReady` matrix, `siteUrl`, `getServerEnv` email validation. |
| `scripts/share-link.test.ts` (8) | Deep-link round trip used by the email's "Open this analysis" link. |

Test-harness notes: `scripts/alias-hook.ts` teaches the commonjs test build to resolve `@/…` imports and `.geojson` assets, and stubs `geotiff` (its CJS build pulls the ESM-only `quick-lru`); guard tests stop at the mock-source guard (`400 CDSE_CONFIG`) so no network analysis runs.

## Manual smoke — live send (console provider)

Environment: `NEXT_PUBLIC_SITE_URL=http://localhost:3000`, `EMAIL_PROVIDER=console`, `EMAIL_TEST_RECIPIENT=qa.test@example.org`, `GEMINI_API_KEY` set, mock data source off (cdse configured).

1. `npm run email:test` → `test report console → q***@example.org fixture=all-events htmlBytes=55969 …` ✅
2. `POST /api/compare/email` with a real analysis payload → **HTTP 202 `{"ok":true}`** (126 s cold start, first run) ✅
   Server log: `[compare:email] status=sent provider=console to=d891f096685b htmlBytes=56796 summary=yes image=yes csv=yes durationMs=104108`
3. Artifacts written to `.email-preview/sent-*`:

   | File | Size | Checked |
   | --- | --- | --- |
   | `.html` | 56.8 KB (< 100 KB) | CID change-map image, AI summary section, deep link with `&amp;e=ev_` per event, recipient absent |
   | `.txt` | — | Facts parity with HTML |
   | `.eml` | 507 KB | multipart/related, `Content-ID: <changemap>`, CSV attachment |
   | `.jpg` | 18.4 KB | inline change map |
   | `.csv` | 287 KB | all events, ≤ 1 MB |

## Manual smoke — dialog (browser, `scripts/verify-email-dialog.browser.cjs`)

Ran twice (light + dark theme), both **PASSED**, 0 console errors. Steps and results:

1. Config endpoint `GET /api/compare/email/config` → 200 ×2 (button visible, `provider=console`).
2. Open dialog from the panel header: heading, preview-mode note, consent line, English language default ✅
3. Light screenshot → `artifacts/email-dialog/dialog-light.png`
4. Turnstile widget loads and reports **Success!** (always-pass test key) ✅
5. Client-side invalid email → `EMAIL_INVALID` error state, **no API request** made ✅
6. Valid send → HTTP **202** → success panel `Report sent to q***@example.org — it may take a minute to arrive.` ✅ → `artifacts/email-dialog/dialog-success-light.png`
7. **Done** closes; toggle dark theme; reopen → wait for token → `artifacts/email-dialog/dialog-dark.png` (+ cropped widget `dialog-dark-crop.png`); Esc closes ✅
8. Sent artifact `.email-preview/sent-*qa-dialog-example-org.html` (57 552 B) re-checked: CID image, AI summary, deep link, no recipient ✅

Screenshot note: the white box behind the Turnstile badge is Cloudflare's own iframe — expected in both themes.

## Production checklist (before enabling real sends)

- [ ] `NEXT_PUBLIC_SITE_URL` set to the canonical https origin (deep links + `assertEmailReady`).
- [ ] `EMAIL_PROVIDER` = `smtp` or `resend`; `EMAIL_FROM` matches a verified sender; credentials set (Sensitive on Vercel).
- [ ] Real Turnstile key pair (not the always-pass test keys) — or leave both unset to disable CAPTCHA.
- [ ] `EMAIL_DAILY_CAP` / per-address / per-IP quotas reviewed for the deployment.
- [ ] Send one real report and confirm arrival + deep link opens the same analysis with the Events tab.
- [ ] Confirm `.email-preview/` is not deployed (gitignored) and production logs only show hashed recipients.
