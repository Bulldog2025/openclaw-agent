// lib/brave.mjs
import fs from "node:fs";

/**
 * Read a secret from a file on disk.
 * We keep secrets out of the repo and read them at runtime.
 */
function readSecret(filePath) {
  return fs.readFileSync(filePath, "utf8").trim();
}

/**
 * braveSearch()
 * - Calls Brave Search API (web search endpoint)
 * - Returns a normalized array of results: { title, url, description }
 *
 * Network constraints are respected because this only hits api.search.brave.com.
 */
export async function braveSearch({
  q,
  count = 10,
  country = "us",
  search_lang = "en",
}) {
  if (!q) throw new Error("braveSearch: q is required");

  // Put your Brave key in this file:
  // /opt/openclaw-poc/secrets/brave_api_key.txt
  const apiKey = readSecret("/opt/openclaw-poc/secrets/brave_api_key.txt");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(count));
  url.searchParams.set("country", country);
  url.searchParams.set("search_lang", search_lang);

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brave API error ${res.status}: ${body.slice(0, 400)}`);
  }

  const data = await res.json();

  // Brave returns results under data.web.results
  const items = data?.web?.results ?? [];

  // Normalize to our internal shape
  return items.map((it) => ({
    title: it.title ?? "",
    url: it.url ?? "",
    description: it.description ?? "",
  }));
}
