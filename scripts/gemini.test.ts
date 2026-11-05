import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGeminiKey,
  codedError,
  generateStructuredJson,
  generateWithFallback,
  sanitizeResponseSchema,
  type GenerateJsonOptions,
} from "../lib/server/gemini";

/** 200 envelope with a JSON (or raw) candidate text. */
function geminiOk(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function httpError(status: number, message = "upstream failure"): Response {
  return new Response(JSON.stringify({ error: { code: status, message, status: "ERR" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type RecordedCall = { url: string; body: Record<string, any> };

function makeFetch(
  handler: (index: number, url: string, body: Record<string, any>) => Response,
): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const call = { url: String(input), body };
    const index = calls.length;
    calls.push(call);
    return handler(index, call.url, body);
  };
  return { fetchFn, calls };
}

function baseOptions(fetchFn: typeof fetch, over: Partial<GenerateJsonOptions> = {}): GenerateJsonOptions {
  return {
    apiKey: "test-key",
    model: "gemini-test",
    systemInstruction: "sys",
    prompt: "prompt",
    responseSchema: { type: "OBJECT", properties: { ok: { type: "STRING" } }, required: ["ok"] },
    retries: 0,
    retryDelayMs: 0,
    fetchFn,
    ...over,
  };
}

function validPayload(): string {
  return JSON.stringify({
    overview: "Overview text.",
    keyChanges: ["a"],
    whereChangesOccurred: ["b"],
    visualObservations: ["c"],
    reliabilityAndCaveats: ["d"],
    suggestedNextChecks: ["e"],
  });
}

test("200 valid: returns the parsed candidate JSON", async () => {
  const { fetchFn, calls } = makeFetch(() => geminiOk(validPayload()));
  const data = (await generateStructuredJson(baseOptions(fetchFn))) as { overview: string };
  assert.equal(data.overview, "Overview text.");
  assert.equal(calls.length, 1);
});

test("200 invalid envelope JSON → AI_BAD_OUTPUT", async () => {
  const { fetchFn } = makeFetch(() => new Response("not-json{", { status: 200 }));
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string }) => {
    assert.equal(err.code, "AI_BAD_OUTPUT");
    return true;
  });
});

test("200 with non-JSON candidate text → AI_BAD_OUTPUT", async () => {
  const { fetchFn } = makeFetch(() => geminiOk("Sure — here it is: ```json ```"));
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string }) => {
    assert.equal(err.code, "AI_BAD_OUTPUT");
    return true;
  });
});

test("200 candidate wrapped in a markdown fence still parses", async () => {
  const { fetchFn } = makeFetch(() => geminiOk("```json\n" + validPayload() + "\n```"));
  const data = (await generateStructuredJson(baseOptions(fetchFn))) as { overview: string };
  assert.equal(data.overview, "Overview text.");
});

test("200 candidate behind a prose preamble still parses", async () => {
  const { fetchFn } = makeFetch(() => geminiOk("Here is the JSON you asked for:\n" + validPayload()));
  const data = (await generateStructuredJson(baseOptions(fetchFn))) as { overview: string };
  assert.equal(data.overview, "Overview text.");
});

test("400 with images → one retry WITHOUT images, flag set", async () => {
  const { fetchFn, calls } = makeFetch((index) => (index === 0 ? httpError(400, "invalid image") : geminiOk(validPayload())));
  const images = [{ mimeType: "image/jpeg", data: "AAAA" }];
  const result = await generateWithFallback(
    baseOptions(fetchFn, { images, imageLabels: ["Image 1:"] }),
  );
  assert.equal(result.imagesFallback, true);
  assert.equal(calls.length, 2);
  const firstParts = calls[0].body.contents[0].parts as Array<Record<string, unknown>>;
  assert.ok(firstParts.some((p) => p.inlineData), "first call carried inline images");
  const secondParts = calls[1].body.contents[0].parts as Array<Record<string, unknown>>;
  assert.ok(
    secondParts.every((p) => !p.inlineData),
    "retry call must not carry inline images",
  );
  assert.equal(calls[1].body.generationConfig.responseSchema !== undefined, true, "schema kept on image retry");
});

test("400 without images → schema-less JSON-in-prompt fallback", async () => {
  const { fetchFn, calls } = makeFetch((index) => (index === 0 ? httpError(400, "bad schema") : geminiOk(validPayload())));
  const result = await generateWithFallback(baseOptions(fetchFn));
  assert.equal(result.imagesFallback, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.generationConfig.responseSchema, undefined, "schema dropped in fallback");
  assert.match(String(calls[1].body.contents[0].parts[0].text), /JSON shape/);
});

test("400 is not retried by generateStructuredJson (deterministic)", async () => {
  const { fetchFn, calls } = makeFetch(() => httpError(400, "nope"));
  await assert.rejects(
    generateStructuredJson(baseOptions(fetchFn, { retries: 1 })),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "AI_BAD_REQUEST");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("non-400 failure with images does not enter the fallback chain", async () => {
  const { fetchFn, calls } = makeFetch(() => httpError(503, "unavailable"));
  await assert.rejects(
    generateWithFallback(baseOptions(fetchFn, { images: [{ mimeType: "image/jpeg", data: "AAAA" }] })),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "AI_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(calls.length, 1, "5xx exhausts inside generateStructuredJson, no image-less retry");
});

test("401 → AI_AUTH (key invalid or lacks access)", async () => {
  const { fetchFn } = makeFetch(() => httpError(401, "API key not valid"));
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string; message: string }) => {
    assert.equal(err.code, "AI_AUTH");
    assert.match(err.message, /API key is invalid or lacks access/);
    return true;
  });
});

test("403 → AI_AUTH", async () => {
  const { fetchFn } = makeFetch(() => httpError(403, "forbidden"));
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string }) => {
    assert.equal(err.code, "AI_AUTH");
    return true;
  });
});

test("404 → AI_MODEL_NOT_FOUND mentioning GEMINI_MODEL", async () => {
  const { fetchFn } = makeFetch(() => httpError(404, "models/gemini-test is not found"));
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string; message: string }) => {
    assert.equal(err.code, "AI_MODEL_NOT_FOUND");
    assert.match(err.message, /check GEMINI_MODEL/);
    return true;
  });
});

test("429 with Retry-After → AI_RATE_LIMITED with N seconds", async () => {
  const { fetchFn } = makeFetch(
    () =>
      new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "7" },
      }),
  );
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string; status?: number; message: string }) => {
    assert.equal(err.code, "AI_RATE_LIMITED");
    assert.equal(err.status, 429);
    assert.match(err.message, /try again in 7 seconds/);
    return true;
  });
});

test("5xx → AI_UNAVAILABLE, one retry with backoff (2 calls)", async () => {
  const { fetchFn, calls } = makeFetch(() => httpError(503, "high demand"));
  await assert.rejects(
    generateStructuredJson(baseOptions(fetchFn, { retries: 1 })),
    (err: Error & { code?: string; status?: number }) => {
      assert.equal(err.code, "AI_UNAVAILABLE");
      assert.equal(err.status, 502);
      return true;
    },
  );
  assert.equal(calls.length, 2, "one retry on 5xx");
});

test("timeout → AI_UNAVAILABLE (504)", async () => {
  const fetchFn: typeof fetch = async () => {
    throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  };
  await assert.rejects(generateStructuredJson(baseOptions(fetchFn)), (err: Error & { code?: string; status?: number }) => {
    assert.equal(err.code, "AI_UNAVAILABLE");
    assert.equal(err.status, 504);
    return true;
  });
});

test("missing key → AI_DISABLED (503)", () => {
  assert.throws(() => assertGeminiKey(undefined), (err: Error & { code?: string; status?: number }) => {
    assert.equal(err.code, "AI_DISABLED");
    assert.equal(err.status, 503);
    return true;
  });
  assert.throws(() => assertGeminiKey(""), (err: Error & { code?: string }) => err.code === "AI_DISABLED");
});

test("sanitizeResponseSchema strips unsupported keywords, keeps the OpenAPI subset", () => {
  const dirty: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "summary",
    type: "OBJECT",
    title: "Summary",
    description: "root",
    additionalProperties: false,
    default: {},
    examples: [{ a: 1 }],
    definitions: { s: { type: "STRING" } },
    allOf: [{ type: "OBJECT" }],
    anyOf: [{ type: "OBJECT" }],
    properties: {
      overview: { type: "STRING", description: "o", default: "hi", examples: ["a"] },
      items: { type: "ARRAY", items: { $ref: "#/definitions/s", type: "STRING" }, minItems: 1 },
      nested: {
        type: "OBJECT",
        properties: { deep: { type: "STRING", $schema: "x", additionalProperties: true } },
        required: ["deep"],
        additionalProperties: true,
      },
    },
    required: ["overview"],
    propertyOrdering: ["overview"],
  };
  const clean = sanitizeResponseSchema(dirty);
  const wire = JSON.stringify(clean);
  for (const bad of ["$schema", "$id", "$ref", "additionalProperties", "default", "examples", "definitions", "allOf", "anyOf", "title"]) {
    assert.ok(!wire.includes(`"${bad}"`), `${bad} must be stripped`);
  }
  assert.equal(clean.type, "OBJECT");
  assert.equal(clean.description, "root");
  assert.deepEqual(clean.required, ["overview"]);
  assert.deepEqual(clean.propertyOrdering, ["overview"]);
  const props = clean.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.overview!.description, "o");
  assert.equal(props.items!.minItems, 1);
  assert.deepEqual((props.items!.items as Record<string, unknown>).type, "STRING");
  const nested = props.nested!.properties as Record<string, Record<string, unknown>>;
  assert.equal(nested.deep!.type, "STRING");
  assert.ok(!JSON.stringify(nested).includes("$schema"));
});

test("the request on the wire carries the sanitized schema", async () => {
  const { fetchFn, calls } = makeFetch(() => geminiOk(validPayload()));
  await generateStructuredJson(
    baseOptions(fetchFn, {
      responseSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "OBJECT",
        additionalProperties: false,
        properties: { ok: { type: "STRING", default: "y" } },
        required: ["ok"],
      },
    }),
  );
  const sent = calls[0].body.generationConfig.responseSchema as Record<string, unknown>;
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes("$schema"));
  assert.ok(!wire.includes("additionalProperties"));
  assert.ok(!wire.includes('"default"'));
  assert.equal(sent.type, "OBJECT");
});

test("codedError carries status + code", () => {
  const err = codedError(502, "AI_BAD_OUTPUT", "boom") as unknown as { status: number; code: string; message: string };
  assert.equal(err.status, 502);
  assert.equal(err.code, "AI_BAD_OUTPUT");
  assert.equal(err.message, "boom");
});
