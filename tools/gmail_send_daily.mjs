#!/usr/bin/env node
// tools/gmail_send_daily.mjs
import fs from "node:fs";
import path from "node:path";

/**
 * Sends the latest run's email_payload.json via Gmail API.
 *
 * Secrets expected:
 *  - /opt/openclaw-poc/secrets/google_oauth_client.json
 *  - /opt/openclaw-poc/secrets/google_tokens.json
 *
 * Usage:
 *   node tools/gmail_send_daily.mjs --to "a@x.com,b@y.com"
 *   node tools/gmail_send_daily.mjs --to "a@x.com" --to2 "b@y.com"
 *   node tools/gmail_send_daily.mjs --runDir "reports/2026-02-12/...." --to "a@x.com,b@y.com"
 */

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function utcDateStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findLatestRunDirForToday() {
  const dayDir = path.join("reports", utcDateStamp());
  if (!isDir(dayDir)) {
    throw new Error(`No reports folder for today: ${dayDir}`);
  }

  const children = fs
    .readdirSync(dayDir)
    .map((name) => path.join(dayDir, name))
    .filter((p) => isDir(p))
    .sort(); // folders start with UTC timestamp, so lexicographic sort works

  if (children.length === 0) {
    throw new Error(`No run folders found in: ${dayDir}`);
  }

  return children[children.length - 1];
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawEmail({ to, subject, bodyText }) {
  // Gmail expects RFC 2822 message, CRLF line endings
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
  ];

  return headers.join("\r\n") + "\r\n\r\n" + bodyText + "\r\n";
}

async function refreshAccessToken({ client_id, client_secret, refresh_token }) {
  // This hits oauth2.googleapis.com (may require allowlisting)
  const url = "https://oauth2.googleapis.com/token";

  const form = new URLSearchParams();
  form.set("client_id", client_id);
  form.set("client_secret", client_secret);
  form.set("refresh_token", refresh_token);
  form.set("grant_type", "refresh_token");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${res.status}). If egress is locked down, allow oauth2.googleapis.com. Body: ${body.slice(
        0,
        300
      )}`
    );
  }

  return await res.json(); // { access_token, expires_in, token_type, scope? }
}

async function gmailSendRaw({ accessToken, rawRfc822 }) {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  const payload = { raw: base64UrlEncode(rawRfc822) };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gmail send failed (${res.status}): ${body.slice(0, 400)}`);
  }

  return await res.json();
}

async function main() {
  const toArg = getArg("--to");
  const to2Arg = getArg("--to2");
  const runDirArg = getArg("--runDir");

  let recipients = [];
  if (toArg) {
    recipients = toArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (to2Arg) recipients.push(to2Arg.trim());
  recipients = Array.from(new Set(recipients));

  if (recipients.length < 1) {
    throw new Error('Provide recipients: --to "a@x.com,b@y.com" (and optional --to2)');
  }

  const runDir = runDirArg ?? findLatestRunDirForToday();

  const payloadPath = path.join(runDir, "email_payload.json");
  if (!exists(payloadPath)) {
    throw new Error(`Missing ${payloadPath}. Run run_daily.mjs first.`);
  }

  const emailPayload = readJson(payloadPath);
  const subject = emailPayload?.subject ?? "(no subject)";
  const bodyText = emailPayload?.bodyText ?? "";

  if (!bodyText.trim()) {
    throw new Error(`email_payload.json had empty bodyText: ${payloadPath}`);
  }

  const oauthClientPath = "/opt/openclaw-poc/secrets/google_oauth_client.json";
  const tokensPath = "/opt/openclaw-poc/secrets/google_tokens.json";

  if (!exists(oauthClientPath)) throw new Error(`Missing ${oauthClientPath}`);
  if (!exists(tokensPath)) throw new Error(`Missing ${tokensPath}`);

  const oauthClient = readJson(oauthClientPath);
  const tokens = readJson(tokensPath);

  // Support either "installed" or "web" client shapes
  const client =
    oauthClient.installed ?? oauthClient.web ?? oauthClient;
  const client_id = client.client_id;
  const client_secret = client.client_secret;

  if (!client_id || !client_secret) {
    throw new Error("google_oauth_client.json missing client_id/client_secret");
  }

  let accessToken = tokens.access_token;
  const refresh_token = tokens.refresh_token;

  if (!accessToken) {
    throw new Error("google_tokens.json missing access_token");
  }

  // Send one email to both recipients in the To header (simple)
  const toHeader = recipients.join(", ");
  const raw = buildRawEmail({ to: toHeader, subject, bodyText });

  // First attempt with current access token
  try {
    const result = await gmailSendRaw({
      accessToken,
      rawRfc822: raw,
    });

    // Record send artifact
    writeJson(path.join(runDir, "gmail_send_result.json"), {
      ok: true,
      runDir,
      to: recipients,
      subject,
      result,
      used_token_refresh: false,
      ts: new Date().toISOString(),
    });

    console.log(
      JSON.stringify(
        { ok: true, runDir, to: recipients, subject, messageId: result?.id ?? null },
        null,
        2
      )
    );
    return;
  } catch (err) {
    const msg = err?.message ?? String(err);

    // If unauthorized, try refresh (requires oauth2.googleapis.com)
    const looksAuth =
      msg.includes("401") || msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("unauthorized");

    if (!looksAuth) throw err;
    if (!refresh_token) {
      throw new Error(
        "Access token failed and no refresh_token present. Re-run OAuth flow to obtain refresh_token."
      );
    }

    const refreshed = await refreshAccessToken({ client_id, client_secret, refresh_token });
    accessToken = refreshed.access_token;

    // Persist refreshed access_token back to google_tokens.json (keep refresh_token)
    const newTokens = {
      ...tokens,
      access_token: accessToken,
      token_type: refreshed.token_type ?? tokens.token_type ?? "Bearer",
      scope: refreshed.scope ?? tokens.scope,
      expires_in: refreshed.expires_in,
      refreshed_at: new Date().toISOString(),
    };
    writeJson(tokensPath, newTokens);

    // Retry send
    const result = await gmailSendRaw({
      accessToken,
      rawRfc822: raw,
    });

    writeJson(path.join(runDir, "gmail_send_result.json"), {
      ok: true,
      runDir,
      to: recipients,
      subject,
      result,
      used_token_refresh: true,
      ts: new Date().toISOString(),
    });

    console.log(
      JSON.stringify(
        { ok: true, runDir, to: recipients, subject, messageId: result?.id ?? null, refreshed: true },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
