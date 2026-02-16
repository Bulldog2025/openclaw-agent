// lib/state_history.mjs
import fs from "node:fs";
import path from "node:path";

/**
 * Purpose:
 * Maintain a persistent, append-only history of "sent" leads
 * and provide deterministic dedup filtering.
 *
 * We store history in:
 *   state/sent_history.jsonl
 *
 * Each line is a JSON object, e.g.
 * {
 *   "ts": "2026-02-12T15:01:02.123Z",
 *   "fingerprint": "...",
 *   "host": "example.com",
 *   "title": "Company Name",
 *   "url": "https://example.com/contact",
 *   "metro": "Chicago, IL",
 *   "runId": "abcd1234..."
 * }
 */

const DEFAULT_HISTORY_PATH = path.join("state", "sent_history.jsonl");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function historyPath(customPath) {
  return customPath ?? DEFAULT_HISTORY_PATH;
}

export function loadSentFingerprints({ history_file } = {}) {
  const filePath = historyPath(history_file);

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n").filter(Boolean);

    const set = new Set();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.fingerprint) set.add(obj.fingerprint);
      } catch {
        // ignore malformed lines (append-only log may contain partial lines if crash)
      }
    }
    return set;
  } catch {
    // No file yet is fine
    return new Set();
  }
}

export function filterNewCandidates(candidates, sentSet) {
  // candidates are scored results with `fingerprint`
  const fresh = [];
  const skipped = [];

  for (const c of candidates ?? []) {
    if (!c?.fingerprint) {
      skipped.push({ candidate: c, reason: "missing_fingerprint" });
      continue;
    }
    if (sentSet.has(c.fingerprint)) {
      skipped.push({ candidate: c, reason: "already_sent" });
      continue;
    }
    fresh.push(c);
  }

  return { fresh, skipped };
}

export function appendSentHistory(
  {
    fingerprint,
    host,
    title,
    url,
    metro,
    runId,
    extra = {},
  },
  { history_file } = {}
) {
  ensureDir("state");
  const filePath = historyPath(history_file);

  const record = {
    ts: new Date().toISOString(),
    fingerprint,
    host,
    title,
    url,
    metro,
    runId,
    ...extra,
  };

  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
  return record;
}
