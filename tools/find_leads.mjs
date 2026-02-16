#!/usr/bin/env node
// tools/find_leads.mjs
import fs from "node:fs";
import path from "node:path";
import { braveSearch } from "../lib/brave.mjs";
import { scoreResults } from "../lib/score_leads.mjs";

/**
 * Purpose:
 * CLI wrapper that:
 *  - runs Brave search
 *  - deterministically scores/ranks results
 *  - writes run artifacts into reports/YYYY-MM-DD/
 *  - prints a small top-N summary to stdout
 *
 * No LLM. No Gmail. Just discovery + deterministic ranking.
 */

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function utcDateStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const q = getArg("--q");
  const metro = getArg("--metro") ?? "";
  const count = Number(getArg("--count") ?? "20");
  const outDir = getArg("--out") ?? path.join("reports", utcDateStamp());

  if (!q) {
    console.error(
      "Usage: tools/find_leads.mjs --q '<query>' [--metro 'Chicago, IL'] [--count 20] [--out reports/YYYY-MM-DD]"
    );
    process.exit(2);
  }

  ensureDir(outDir);

  // 1) Brave search (network)
  const results = await braveSearch({ q, count });

  // 2) Deterministic ranking (offline)
  const ranked = scoreResults(results, { metro });

  // 3) Artifacts for audit/debug
  writeJson(path.join(outDir, "brave_results.json"), { q, metro, count, results });
  writeJson(path.join(outDir, "ranked_candidates.json"), { q, metro, count, ranked });

  // 4) Print top 10 summary to stdout (useful for quick inspection)
  const top = ranked.slice(0, 10).map((r) => ({
    score: r.score,
    title: r.title,
    url: r.url,
    reasons: r.reasons.slice(0, 6),
  }));

  console.log(JSON.stringify({ q, metro, count, top }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
