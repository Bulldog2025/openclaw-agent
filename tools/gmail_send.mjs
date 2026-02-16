#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { google } from "googleapis";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("to", { type: "string", demandOption: true, describe: "Comma-separated recipients" })
  .option("from", { type: "string", demandOption: true, describe: "Sender email (bot gmail)" })
  .option("subject", { type: "string", demandOption: true })
  .option("body", { type: "string", demandOption: true })
  .option("client", { type: "string", default: "/opt/openclaw-poc/secrets/google_oauth_client.json" })
  .option("tokens", { type: "string", default: "/opt/openclaw-poc/secrets/google_tokens.json" })
  .option("dry-run", { type: "boolean", default: false })
  .strict()
  .parseSync();

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function base64url(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildMime({ from, to, subject, body }) {
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    body,
    ``,
  ].join("\r\n");
}

async function main() {
  const to = argv.to.split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error("No recipients");

  const mime = buildMime({ from: argv.from, to, subject: argv.subject, body: argv.body });

  if (argv["dry-run"]) {
    const out = path.resolve("logs/last_email_preview.eml");
    fs.writeFileSync(out, mime, "utf8");
    console.log(`DRY RUN: wrote ${out}`);
    return;
  }

  if (!fs.existsSync(argv.client)) throw new Error(`Missing OAuth client JSON: ${argv.client}`);
  if (!fs.existsSync(argv.tokens)) throw new Error(`Missing tokens JSON: ${argv.tokens}`);

  const clientRaw = loadJson(argv.client);
  const cfg = clientRaw.installed ?? clientRaw.web ?? clientRaw;
  const { client_id, client_secret } = cfg;
  if (!client_id || !client_secret) throw new Error("client_id/client_secret missing in client JSON");

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, "http://localhost");
  oauth2.setCredentials(loadJson(argv.tokens));

  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64url(mime) },
  });

  console.log(JSON.stringify({ ok: true, id: res.data.id, threadId: res.data.threadId }, null, 2));
}

main().catch((e) => {
  console.error("gmail_send failed:", e?.message || e);
  process.exit(1);
});
