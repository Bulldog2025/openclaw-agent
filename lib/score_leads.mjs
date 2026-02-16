// lib/score_leads.mjs
import crypto from "node:crypto";

/**
 * Deterministic scoring module
 * No network calls.
 * No LLM.
 * Pure transformation of Brave results.
 */

const DIRECTORY_HOST_PENALTY = new Map([
  ["thomasnet.com", -35],
  ["www.thomasnet.com", -35],
  ["yelp.com", -40],
  ["www.yelp.com", -40],
  ["yellowpages.com", -40],
  ["www.yellowpages.com", -40],
  ["linkedin.com", -25],
  ["www.linkedin.com", -25],
  ["facebook.com", -25],
  ["www.facebook.com", -25],
]);

const POSITIVE_KEYWORDS = [
  ["manufacturer", 10],
  ["manufacturing", 8],
  ["packaging", 6],
  ["flexible packaging", 8],
  ["corrugated", 6],
  ["contract packaging", 10],
  ["co-packer", 10],
  ["copacker", 10],
  ["co packing", 10],
  ["fulfillment", 6],
  ["3pl", 6],
];

const NEGATIVE_KEYWORDS = [
  ["freight broker", -60],
  ["broker", -40],
  ["load board", -60],
  ["dispatch", -25],
  ["factoring", -25],
  ["carrier setup", -25],
  ["contact supplier", -20],
];

const PHONE_RE = /(\+?1[\s.-]?)?(\(?\d{3}\)?)[\s.-]?\d{3}[\s.-]?\d{4}/;

const ADDRESS_HINT_RE =
  /\b(Address:|\d{2,6}\s+[A-Za-z0-9'.-]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court)\b)/i;

/* ---------------------------
   Helper functions
--------------------------- */

function normalizeHost(urlStr) {
  try {
    return new URL(urlStr).host.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeText(result) {
  return `${result.title ?? ""}\n${result.url ?? ""}\n${result.description ?? ""}`.toLowerCase();
}

function fingerprintFromResult(result) {
  const host = normalizeHost(result.url ?? "");
  const title = (result.title ?? "").trim().toLowerCase();
  const basis = `${host}||${title}`;
  return crypto.createHash("sha256").update(basis).digest("hex");
}

/* ---------------------------
   Main scoring function
--------------------------- */

export function scoreResults(results, { metro } = {}) {
  const metroLower = (metro ?? "").toLowerCase().trim();

  const ranked = (results ?? []).map((r) => {
    const host = normalizeHost(r.url ?? "");
    const t = normalizeText(r);

    let score = 0;
    const reasons = [];

    const hostPenalty = DIRECTORY_HOST_PENALTY.get(host);
    if (hostPenalty) {
      score += hostPenalty;
      reasons.push(`directory_host:${host}(${hostPenalty})`);
    }

    for (const [kw, pts] of POSITIVE_KEYWORDS) {
      if (t.includes(kw)) {
        score += pts;
        reasons.push(`kw+:${kw}(+${pts})`);
      }
    }

    for (const [kw, pts] of NEGATIVE_KEYWORDS) {
      if (t.includes(kw)) {
        score += pts;
        reasons.push(`kw-:${kw}(${pts})`);
      }
    }

    if (PHONE_RE.test(t)) {
      score += 20;
      reasons.push("has_phone(+20)");
    }

    if (ADDRESS_HINT_RE.test(r.description ?? "")) {
      score += 10;
      reasons.push("has_address_hint(+10)");
    }

    if (metroLower && t.includes(metroLower)) {
      score += 6;
      reasons.push(`mentions_metro:${metro}(+6)`);
    }

    return {
      fingerprint: fingerprintFromResult(r),
      score,
      reasons,
      title: r.title ?? "",
      url: r.url ?? "",
      description: r.description ?? "",
      host,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  return ranked;
}
