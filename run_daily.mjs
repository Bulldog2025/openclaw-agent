#!/usr/bin/env node
// run_daily.mjs
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { braveSearch } from "./lib/brave.mjs";
import { scoreResults } from "./lib/score_leads.mjs";
import {
  loadSentFingerprints,
  filterNewCandidates,
  appendSentHistory,
} from "./lib/state_history.mjs";
import { enrichLeadsOpenAI } from "./lib/openai_enrich.mjs";
import { formatLeadsEmail } from "./lib/email_format.mjs";
import { buildQueriesForMetro } from "./lib/query_templates.mjs";

/**
 * Daily orchestrator.
 *
 * Pipeline:
 * 1) Rotate metro (state/metro.json)
 * 2) Run Brave search across deterministic query templates until enough *fresh* candidates
 * 3) Deterministic score (offline)
 * 4) Dedup via state/sent_history.jsonl (offline)
 * 5) Select top N fresh (offline)
 * 6) Optional OpenAI enrichment (network) — extraction/formatting only
 * 7) Produce email payload + preview (offline)
 * 8) Write artifacts + logs (offline)
 *
 * NOTE: We currently append to sent history at selection time.
 * Later, after Gmail send is integrated, move appendSentHistory to AFTER send succeeds.
 */

function utcDateStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function utcTimestampCompact() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function appendJsonl(p, obj) {
  fs.appendFileSync(p, JSON.stringify(obj) + "\n");
}

function writeText(p, text) {
  fs.writeFileSync(p, text, "utf8");
}

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function loadMetroState() {
  const statePath = path.join("state", "metro.json");
  const defaultState = {
    metros: ["Chicago, IL", "Dallas, TX", "Atlanta, GA"],
    index: 0,
    last_rotated_at: null,
    last_selected: null,
  };
  return { statePath, state: readJsonIfExists(statePath, defaultState) };
}

function selectAndRotateMetro(stateObj) {
  const metros =
    Array.isArray(stateObj.metros) && stateObj.metros.length > 0
      ? stateObj.metros
      : ["Chicago, IL"];
  const idx = Number.isInteger(stateObj.index) ? stateObj.index : 0;

  const metro = metros[idx % metros.length];
  const nextIndex = (idx + 1) % metros.length;

  const updated = {
    ...stateObj,
    metros,
    index: nextIndex,
    last_rotated_at: new Date().toISOString(),
    last_selected: metro,
  };

  return { metro, updated };
}

function computeRunId({ date, metro, querySeed }) {
  const basis = `${date}||${metro}||${querySeed}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function errToObj(err) {
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(err),
    stack: err?.stack ?? null,
  };
}

function uniqueByFingerprint(scored) {
  const seen = new Set();
  const out = [];
  for (const c of scored ?? []) {
    if (!c?.fingerprint) continue;
    if (seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    out.push(c);
  }
  return out;
}

async function main() {
  // ---------- config ----------
  const leadsPerRun = Number(getArg("--limit") ?? "10");
  const countPerQuery = Number(getArg("--count") ?? "20");
  const skipEnrich = process.argv.includes("--skip-enrich");

  ensureDir("state");
  ensureDir("reports");

  // ---------- metro rotation ----------
  const { statePath, state } = loadMetroState();
  const { metro, updated } = selectAndRotateMetro(state);
  writeJson(statePath, updated);

  // ---------- run folder + logger ----------
  const date = utcDateStamp();
  const querySeed = "query_templates_v1";
  const runId = computeRunId({ date, metro, querySeed });

  const runDir = path.join("reports", date, `${utcTimestampCompact()}_${runId}`);
  ensureDir(runDir);

  const logPath = path.join(runDir, "log.jsonl");
  const log = (event, data = {}) =>
    appendJsonl(logPath, { ts: new Date().toISOString(), event, ...data });

  log("run_start", { date, metro, runId, leadsPerRun, countPerQuery, skipEnrich });

  // ---------- query fallback: accumulate candidates until enough fresh ----------
  const queries = buildQueriesForMetro(metro);
  const sentSet = loadSentFingerprints();

  const perQueryArtifacts = [];
  let mergedRanked = [];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    log("query_start", { i, q });

    const results = await braveSearch({ q, count: countPerQuery });
    log("query_brave_ok", { i, q, results_count: results.length });

    const ranked = scoreResults(results, { metro });
    log("query_score_ok", { i, q, ranked_count: ranked.length });

    // merge and de-dupe by fingerprint
    mergedRanked = uniqueByFingerprint([...mergedRanked, ...ranked]);

    // compute fresh so far to decide whether to continue
    const { fresh } = filterNewCandidates(mergedRanked, sentSet);

    perQueryArtifacts.push({
      i,
      q,
      results_count: results.length,
      ranked_count: ranked.length,
      merged_ranked_count: mergedRanked.length,
      fresh_so_far_count: fresh.length,
    });

    log("query_merge_status", perQueryArtifacts[perQueryArtifacts.length - 1]);

    if (fresh.length >= leadsPerRun) break;
  }

  // Sort merged by score desc (scoreResults already sorted per query, but merge breaks order)
  mergedRanked.sort((a, b) => b.score - a.score);

  // Final dedup decision
  const { fresh, skipped } = filterNewCandidates(mergedRanked, sentSet);
  const selected = fresh.slice(0, leadsPerRun);

  log("merge_complete", {
    queries_tried: perQueryArtifacts.length,
    merged_ranked_count: mergedRanked.length,
    fresh_count: fresh.length,
    skipped_count: skipped.length,
    selected_count: selected.length,
  });

  // ---------- artifacts (pre-enrichment) ----------
  writeJson(path.join(runDir, "queries.json"), { metro, queries, perQueryArtifacts });
  writeJson(path.join(runDir, "ranked_candidates_merged.json"), { metro, ranked: mergedRanked });
  writeJson(path.join(runDir, "selected_candidates.json"), { metro, selected });

  writeJson(path.join(runDir, "dedup_skipped.json"), {
    metro,
    skipped: skipped.slice(0, 200).map((s) => ({
      reason: s.reason,
      fingerprint: s.candidate?.fingerprint ?? null,
      title: s.candidate?.title ?? null,
      url: s.candidate?.url ?? null,
      host: s.candidate?.host ?? null,
    })),
    skipped_total: skipped.length,
  });

  // Mark as sent at selection time (temporary)
  for (const c of selected) {
    appendSentHistory({
      fingerprint: c.fingerprint,
      host: c.host,
      title: c.title,
      url: c.url,
      metro,
      runId,
      extra: { stage: "selected" },
    });
  }

  // ---------- step: OpenAI enrichment (optional; never crash run) ----------
  let enriched = [];
  let enrichError = null;
  let model;

  
    try {
      model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
      enriched = await enrichLeadsOpenAI({ selected, metro, runId, model });
      log("enrich_ok", { enriched_count: enriched.length });
    } catch (err) {
      enrichError = errToObj(err);
      log("enrich_error", enrichError);
      enriched = [];
    }
  

  writeJson(path.join(runDir, "enriched_leads.json"), { metro, runId, enriched });
  if (enrichError) writeJson(path.join(runDir, "enrich_error.json"), enrichError);

  // ---------- Email formatting ----------
  const useNormalized = Array.isArray(enriched) && enriched.length > 0;
  const emailMode = useNormalized ? "normalized" : "scored";
  const emailLeads = useNormalized ? enriched : selected;

  const emailPayload = formatLeadsEmail({
    date,
    metro,
    leads: emailLeads,
    mode: emailMode,
  });

  writeJson(path.join(runDir, "email_payload.json"), {
    mode: emailMode,
    subject: emailPayload.subject,
    bodyText: emailPayload.bodyText,
  });
  writeText(path.join(runDir, "email_preview.txt"), emailPayload.bodyText);

  log("email_format_ok", { mode: emailMode, subject: emailPayload.subject });

  // ---------- run metadata ----------
  writeJson(path.join(runDir, "run.json"), {
    runId,
    date,
    metro,
    leadsPerRun,
    countPerQuery,
    skipEnrich,
    querySeed,
    counts: {
      merged_ranked: mergedRanked.length,
      fresh: fresh.length,
      skipped: skipped.length,
      selected: selected.length,
      enriched: enriched.length,
    },
    email: {
      mode: emailMode,
      subject: emailPayload.subject,
    },
    queries_tried: perQueryArtifacts,
  });

  log("run_complete", {
    selected_count: selected.length,
    enriched_count: enriched.length,
    email_mode: emailMode,
    runDir,
  });

  console.log(
    JSON.stringify(
      {
        runId,
        date,
        metro,
        selected_count: selected.length,
        enriched_count: enriched.length,
        email_mode: emailMode,
        email_subject: emailPayload.subject,
        runDir,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
