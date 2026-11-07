# Email report — QA log

Feature: `POST /api/compare/email` + the **Email report** dialog (PR: see branch `feat/email-report`), plus **fixed-recipient mode** (branch `feat/email-fixed-recipient`).
Last run: **2026-11-07**, local dev (`next dev`, `EMAIL_PROVIDER=smtp`, Cloudflare always-pass test keys, temp `EMAIL_FIXED_RECIPIENT=qa.fixed@example.org` removed after the run).

## What is automated (`npm test` — 202 tests, all green)

| File | Covers |
| --- | --- |
| `scripts/email-route.test.ts` (24) | Guard flow of `POST /api/compare/email` via the real handler: cross-origin 403, same-origin pass-through, `INVALID_JSON`, schema refine (`dateA === dateB`), honeypot fake 202 (no quota consumed), `EMAIL_INVALID` before quota, `PAYLOAD_TOO_LARGE` (8 KB body cap), Turnstile fail-closed without token / rejected siteverify / accepted siteverify (mocked `challenges.cloudflare.com`), full chain reaching the analysis stage (`CDSE_CONFIG` sentinel), daily quota 429 + `Retry-After` + IST message (`Daily limit reached; try again after 05:30 IST.`), console-in-production `EMAIL_DISABLED` 503. **Fixed mode:** a client-supplied `email` field → `400 EMAIL_INVALID` before quota; no-field request reaches the analysis stage (recipient from env); config endpoint returns `mode=fixed` + masked hint and never leaks the address; a pre-seeded send key answers `202 alreadySent` with zero quota consumed (also proves the route hashed the env recipient). **Production policy:** typed mode → `503 EMAIL_DISABLED` unless `EMAIL_ALLOW_ANY_RECIPIENT=true`; with the flag (smtp configured) typed passes through; fixed mode passes without the flag. Plus `GET /api/compare/email/config`: payload shape, cache header, half-configured Turnstile hides the button, site key only when both keys set, production hides the button, no secrets in the payload. |
| `scripts/email-dedupe.test.ts` (6) | Idempotency key: stable hex digest with no raw inputs; every folded field (language, flags, recipient, area, dates, sensitivity, min-patch, level) changes it; date order normalised A-first; engine v1 folds input mode away while v2 keeps it; 10-minute window (in-window suppresses, at-window expires and prunes); suppression is scoped per key. |
| `scripts/email-rate.test.ts` (8) | `emailDailyGuard`: per-address, per-IP and deployment caps; global-cap-first ordering; UTC-day rollover; blocked attempts do not consume budget; fixed-recipient mode raises the per-address limit to `EMAIL_DAILY_CAP`; `dailyLimitMessage` states the fixed `05:30 IST` reset. |
| `scripts/email-providers.test.ts` (11) | SMTP adapter (nodemailer mocked): success with cid + CSV attachments; `EAUTH` → `EMAIL_SEND_FAILED`; connection refused → retryable; 4xx deferral → `EMAIL_RATE_LIMITED` 429 with `retryAfterSeconds=300`; 5xx → rejected. Resend adapter (`fetch` mocked): request shape (Bearer token, `to[]`, base64 `content_id` attachments); 429 → `EMAIL_RATE_LIMITED` with header / 60 s fallback; 401 → credentials error without echoing the key; network failure → retryable. |
| `scripts/email-template.test.ts` (11) | Hostile area/event/summary names never become live markup (escaped entities present, raw `<script>`/`onerror` absent); subject single-line ≤90 chars even with CRLF injection; all fixtures render ≤100 KB with non-empty text; plain-text parity (facts present, no HTML tags); Hindi `lang="hi"` + Devanagari; no-summary fallback copy; **fixed vs open footers** (alert-recipient wording + `Requested: … IST` line only in fixed mode, typed-address consent only in open mode, Hindi fixed fixture too — phrases matched on whitespace-flattened parts because the text part is hard-wrapped); `events.csv` RFC-4180 quoting/CRLF/1 MB cap/per-event deep link; `assertHtmlBudget` throws over the cap. |
| `scripts/email.test.ts` (14) | Address handling (injection attempts, masking, hashing), `.eml` writer (multipart, CID, RFC 2047), console provider files, provider factory, `assertEmailReady` matrix, `siteUrl`, `getServerEnv` email validation incl. `EMAIL_FIXED_RECIPIENT` (blank → open mode, trimmed valid address kept, anything that is not one mailbox fails closed). |
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

## Manual smoke — fixed dialog (browser, `scripts/verify-fixed-email.browser.cjs`)

Ran **2026-11-07**, local dev with `EMAIL_FIXED_RECIPIENT=qa.fixed@example.org` (temp, removed after the run), `EMAIL_PROVIDER=smtp`, always-pass Turnstile. **PASSED**, 0 console errors (only the pre-existing `forwardRef` warning). Flow:

1. Share URL → analysis via real CDSE → drawer; `GET /api/compare/email/config` → `{"enabled":true,"mode":"fixed","recipientHint":"q***@example.org",…}` — full address never in the payload.
2. Header button "Send report to mail" (envelope icon + label) at 1440 px; label hidden (icon-only, `title` tooltip) at 360 px — `hidden @sm:block` container query (needed `@tailwindcss/container-queries`, which was missing on Tailwind v3).
3. Fixed dialog: heading, "This comparison will be emailed to q***@example.org.", language default English, both toggles, **no** `#email-report-recipient` input, **no** open-mode consent line.
4. Screenshots (all verified visually, `artifacts/email-fixed/`): `fixed-dialog-light-wide`, `fixed-dialog-light-narrow` (360×740, box `328×349` fully on-screen), `fixed-success-light`, `fixed-already-sent`, `fixed-dialog-dark-wide` (shows the persisted cooldown line), `fixed-dialog-dark-narrow`.
5. Turnstile → **Send report** → HTTP **202** → `Report sent to q***@example.org. It can take a minute; check spam.`
6. **Send another** → `You can send another report in 30s.` + disabled Send; **Cancel** → reopen → cooldown still active (lives in the `EmailReport` parent, survives dialog close).
7. Cooldown expires + fresh token → **Send report** → HTTP **202** → `This report was already sent a few minutes ago.` (10-minute dedupe window; Turnstile tokens are single-use, so each attempt needs a reopened dialog).
8. Dark theme → wide + narrow shots; **Esc** closes.

Note: the drawer unmounts when the viewport crosses the 1024 px desktop/mobile threshold, so the smoke only resizes while the dialog is closed.

## Production checklist (before enabling real sends)

- [ ] `NEXT_PUBLIC_SITE_URL` set to the canonical https origin (deep links + `assertEmailReady`).
- [ ] `EMAIL_PROVIDER` = `smtp` or `resend`; `EMAIL_FROM` matches a verified sender; credentials set (Sensitive on Vercel).
- [ ] Real Turnstile key pair (not the always-pass test keys) — or leave both unset to disable CAPTCHA.
- [ ] `EMAIL_DAILY_CAP` / per-address / per-IP quotas reviewed for the deployment (in fixed mode the per-address limit equals `EMAIL_DAILY_CAP`).
- [ ] **Recipient policy decided:** set `EMAIL_FIXED_RECIPIENT` (🔒 Sensitive, recommended — see [Fixed recipient mode](../README.md#fixed-recipient-mode)) and leave `EMAIL_ALLOW_ANY_RECIPIENT` unset; or consciously enable typed mode with `EMAIL_ALLOW_ANY_RECIPIENT=true`.
- [ ] Send one real report and confirm arrival + deep link opens the same analysis with the Events tab; in fixed mode, a second identical send inside 10 minutes reports `alreadySent`.
- [ ] Confirm `.email-preview/` is not deployed (gitignored) and production logs only show hashed recipients.
