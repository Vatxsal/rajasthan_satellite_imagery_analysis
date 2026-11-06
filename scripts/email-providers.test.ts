import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { EmailSendError, type EmailMessage } from "../lib/email/types";
import { createResendProvider } from "../lib/email/providers/resend";
import { createSmtpProvider } from "../lib/email/providers/smtp";

/** SMTP (nodemailer) and Resend adapters: success mapping plus every
 *  failure class the API contract distinguishes (auth, unreachable,
 *  deferred 4xx → rate-limited, rejected, service errors). */

const smtpConfig = {
  host: "smtp.example.org",
  port: 587,
  secure: false,
  user: "smtp-user",
  pass: "smtp-pass",
  from: "Rajasthan Imagery Explorer <reports@example.org>",
};

const message: EmailMessage = {
  to: "citizen@example.com",
  subject: "Change report · Bassi · 10 Oct 2026 to 25 Oct 2026 (auto-generated)",
  html: '<html><body><h1>Report</h1><img src="cid:changemap" alt="change map" /></body></html>',
  text: "Report\nOpen the change map in the app.",
  inlineImages: [
    {
      cid: "changemap",
      filename: "changemap.jpg",
      content: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      contentType: "image/jpeg",
    },
  ],
  attachments: [
    {
      filename: "events.csv",
      content: Buffer.from("id,class,area_ha\nev_a,Vegetation loss,36.1\n", "utf8"),
      contentType: "text/csv",
    },
  ],
};

interface TransportPatch {
  createTransport: (options?: unknown) => unknown;
}

function patchTransport(factory: () => unknown): () => void {
  const smtp = nodemailer as unknown as TransportPatch;
  const original = smtp.createTransport;
  smtp.createTransport = factory;
  return () => {
    smtp.createTransport = original;
  };
}

test("smtp provider sends through nodemailer with cid + csv attachments", async () => {
  const seen: { options: Record<string, unknown>; mail: Record<string, unknown> }[] = [];
  const restore = patchTransport(() => ({
    async sendMail(mail: Record<string, unknown>) {
      seen.push({ options: {}, mail });
      return { messageId: "<smtp-accepted@mail.example>" };
    },
    close() {},
  }));
  try {
    const provider = createSmtpProvider(smtpConfig);
    const result = await provider.send(message);
    assert.equal(result.provider, "smtp");
    assert.equal(result.messageId, "<smtp-accepted@mail.example>");

    const mail = seen[0]!.mail;
    assert.equal(mail.to, "citizen@example.com");
    assert.equal(mail.from, smtpConfig.from);
    assert.equal(mail.subject, message.subject);
    assert.equal(mail.html, message.html);
    const attachments = mail.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0]!.cid, "changemap");
    assert.equal(attachments[0]!.contentDisposition, "inline");
    assert.equal(attachments[1]!.filename, "events.csv");
  } finally {
    restore();
  }
});

test("smtp maps authentication failures to EMAIL_SEND_FAILED", async () => {
  const restore = patchTransport(() => ({
    async sendMail() {
      throw Object.assign(new Error("auth failed"), { code: "EAUTH" });
    },
    close() {},
  }));
  try {
    await assert.rejects(
      () => createSmtpProvider(smtpConfig).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_SEND_FAILED");
        assert.match(error.message, /SMTP authentication failed/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("smtp maps connection failures to a retryable send error", async () => {
  const restore = patchTransport(() => ({
    async sendMail() {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    },
    close() {},
  }));
  try {
    await assert.rejects(
      () => createSmtpProvider(smtpConfig).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_SEND_FAILED");
        assert.match(error.message, /Could not reach the mail server/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("smtp maps a 4xx deferral to EMAIL_RATE_LIMITED with Retry-After", async () => {
  const restore = patchTransport(() => ({
    async sendMail() {
      throw Object.assign(new Error("deferred"), { responseCode: 451 });
    },
    close() {},
  }));
  try {
    await assert.rejects(
      () => createSmtpProvider(smtpConfig).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_RATE_LIMITED");
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 300);
        assert.match(error.message, /451/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("smtp maps a permanent 5xx rejection to EMAIL_SEND_FAILED", async () => {
  const restore = patchTransport(() => ({
    async sendMail() {
      throw Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
    },
    close() {},
  }));
  try {
    await assert.rejects(
      () => createSmtpProvider(smtpConfig).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_SEND_FAILED");
        assert.match(error.message, /rejected the message/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

interface FetchCapture {
  url: string;
  authorization: string | undefined;
  payload: Record<string, unknown>;
}

function patchFetch(
  handler: (input: unknown, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCapture[]; restore: () => void } {
  const realFetch = globalThis.fetch;
  const calls: FetchCapture[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      payload,
    });
    return handler(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

test("resend provider posts to the API with base64 cid attachments", async () => {
  const mock = patchFetch(
    () =>
      new Response(JSON.stringify({ id: "re_abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const provider = createResendProvider({
      apiKey: "re_secret_key",
      from: "Rajasthan Imagery Explorer <reports@example.org>",
    });
    const result = await provider.send(message);
    assert.equal(result.provider, "resend");
    assert.equal(result.messageId, "re_abc123");

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.authorization, "Bearer re_secret_key");
    assert.deepEqual(call.payload.to, ["citizen@example.com"]);
    assert.equal(call.payload.subject, message.subject);
    const attachments = call.payload.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0]!.content_id, "changemap");
    assert.equal(
      attachments[0]!.content,
      message.inlineImages![0]!.content.toString("base64"),
    );
    assert.equal(attachments[1]!.filename, "events.csv");
  } finally {
    mock.restore();
  }
});

test("resend maps HTTP 429 to EMAIL_RATE_LIMITED with the Retry-After header", async () => {
  const mock = patchFetch(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "90" },
      }),
  );
  try {
    await assert.rejects(
      () =>
        createResendProvider({ apiKey: "k", from: "reports@example.org" }).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_RATE_LIMITED");
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 90);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("resend falls back to 60s when 429 carries no Retry-After", async () => {
  const mock = patchFetch(() => new Response("nope", { status: 429 }));
  try {
    await assert.rejects(
      () =>
        createResendProvider({ apiKey: "k", from: "reports@example.org" }).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_RATE_LIMITED");
        assert.equal(error.retryAfterSeconds, 60);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("resend maps 401 to a credentials error without echoing the key", async () => {
  const mock = patchFetch(() => new Response("bad key", { status: 401 }));
  try {
    await assert.rejects(
      () =>
        createResendProvider({ apiKey: "re_secret_key", from: "reports@example.org" }).send(
          message,
        ),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_SEND_FAILED");
        assert.match(error.message, /RESEND_API_KEY/);
        assert.ok(!error.message.includes("re_secret_key"), "key never in the message");
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("resend maps a network failure to a retryable send error", async () => {
  const mock = patchFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(
      () =>
        createResendProvider({ apiKey: "k", from: "reports@example.org" }).send(message),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_SEND_FAILED");
        assert.match(error.message, /Could not reach the email service/);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});
