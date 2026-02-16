// lib/query_templates.mjs

/**
 * Purpose:
 * Provide deterministic query templates to widen results when a metro returns 0 leads.
 * Still compliant: these are just Brave queries (no crawling).
 */

export function buildQueriesForMetro(metro) {
  const m = metro;

  // Order matters: run these sequentially until you have enough candidates.
  return [
    `packaging manufacturer "${m}" contact phone`,
    `contract packaging "${m}" phone`,
    `flexible packaging "${m}" address phone`,
    `corrugated packaging "${m}" manufacturer phone`,
    `co-packer "${m}" phone`,
    `fulfillment packaging "${m}" contact phone`,
  ];
}
