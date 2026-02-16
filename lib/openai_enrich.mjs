// lib/openai_enrich.mjs
import fs from "node:fs";

function readSecretIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function getOpenAIKey() {
  try {
    return fs.readFileSync(
      "/opt/openclaw-poc/secrets/openai_api_key.txt",
      "utf8"
    ).trim();
  } catch {
    throw new Error(
      "Missing OpenAI API key file at /opt/openclaw-poc/secrets/openai_api_key.txt"
    );
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * OpenAI enrichment (extraction/formatting only)
 */
export async function enrichLeadsOpenAI({
  selected,
  metro,
  runId,
  model = "gpt-4.1-mini",
}) {
  if (!Array.isArray(selected) || selected.length === 0) return [];

  const apiKey = getOpenAIKey();

  const payload = {
    model,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "You extract and normalize lead info from search snippets.",
          "You MUST NOT browse or invent facts beyond the provided inputs.",
          "Do NOT re-rank or filter; return one output object per input item.",
          "If a field is unknown, set it to null.",
          "website should be a URL if present; otherwise null.",
          "main_phone should be a single phone string if present; otherwise null.",
          "address should be a single string if present; otherwise null.",
          "reason_for_inclusion should be a short sentence grounded in the snippet and scoring reasons.",
          "Return JSON: { \"leads\": [ ... ] }",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            meta: { metro, runId, ts: nowIso() },
            schema: {
              fingerprint: "string",
              name: "string|null",
              main_phone: "string|null",
              address: "string|null",
              website: "string|null",
              description: "string|null",
              reason_for_inclusion: "string|null",
            },
            input: selected.map((c) => ({
              fingerprint: c.fingerprint,
              title: c.title,
              url: c.url,
              host: c.host,
              snippet: c.description,
              score: c.score,
              reasons: c.reasons,
            })),
          },
          null,
          2
        ),
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${body.slice(0, 400)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  console.log("[OpenAI] Raw response text:");
  console.log(text);
  if (!text) throw new Error("OpenAI returned empty content");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }

  const leads = parsed?.leads;
  if (!Array.isArray(leads)) {
    throw new Error("OpenAI JSON did not contain { leads: [] }");
  }

  // enforce fingerprint mapping
  const allow = new Set(selected.map((c) => c.fingerprint));
  return leads
    .map((l) => ({
      fingerprint: l?.fingerprint ?? null,
      name: l?.name ?? null,
      main_phone: l?.main_phone ?? null,
      address: l?.address ?? null,
      website: l?.website ?? null,
      description: l?.description ?? null,
      reason_for_inclusion: l?.reason_for_inclusion ?? null,
    }))
    .filter((l) => l.fingerprint && allow.has(l.fingerprint));
}
