#!/usr/bin/env node
import fs from "node:fs";
import { request } from "undici";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

const argv = yargs(hideBin(process.argv))
  .option("q", { type: "string", demandOption: true })
  .option("count", { type: "number", default: 10 })
  .option("offset", { type: "number", default: 0 })
  .option("keyFile", { type: "string", default: "/opt/openclaw-poc/secrets/brave_api_key.txt" })
  .strict()
  .parseSync();

const WebResultSchema = z.object({
  title: z.string().optional(),
  url: z.string(),
  description: z.string().optional(),
});

const BraveSchema = z.object({
  web: z.object({ results: z.array(WebResultSchema).default([]) }).optional(),
});

function readKey(p) {
  return fs.readFileSync(p, "utf8").trim();
}

async function main() {
  const token = readKey(argv.keyFile);

  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", argv.q);
  u.searchParams.set("count", String(argv.count));
  u.searchParams.set("offset", String(argv.offset));

  const res = await request(u.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": token,
    },
  });

  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`Brave API HTTP ${res.statusCode}: ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text);
  const parsed = BraveSchema.parse(json);
  const results = parsed.web?.results ?? [];

  process.stdout.write(JSON.stringify({ q: argv.q, results }, null, 2));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
