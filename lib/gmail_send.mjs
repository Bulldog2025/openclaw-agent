// lib/gmail_send.mjs
import fs from "node:fs";
import path from "node:path";

const RUN_STATUS = {
  STARTED: "STARTED",
  GENERATED: "GENERATED",
  SENT: "SENT",
  COMMITTED: "COMMITTED",
};

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
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

// ------------------------
// Run state + commit helpers
// ------------------------

function writeRunState(runDir, patch) {
  const p = path.join(runDir, "state.json");
  const prev = readJsonIfExists(p, {});
  const next = {
    ...prev,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeJson(p, next);
  return next;
}

function readRunState(runDir) {
  return readJsonIfExists(path.join(runDir, "state.json"), {});
}

function appendSentHistoryEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  ensureDir("state");
  const p = path.join("state", "sent_history.jsonl");
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(p, lines, "utf8");
  return entries.length;
}

function sentHistoryHasRunDir(runDir) {
  const p = path.join("state", "sent_history.jsonl");
  try {
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.runDir === runDir) return true;
      } catch {
        // ignore malformed lines
      }
    }
    return false;
  } catch {
    return false;
  }
}

function loadPendingHistory(runDir) {
  const pendingPath = path.join(runDir, "pending_sent_history.json");
  const pending = readJsonIfExists(pendingPath, null);
  if (!pending?.entries || !Array.isArray(pending.entries)) {
    throw new Error(`Missing or invalid pending_sent_history.json in ${runDir}`);
  }
  return pending;
}

function commitRunHistoryIfNeeded(runDir) {
  const state = readRunState(runDir);

  if (state?.status === RUN_STATUS.COMMITTED || state?.committed_at) {
    return { committed: false, reason: "already_committed_by_state" };
  }

  if (sentHistoryHasRunDir(runDir)) {
    writeRunState(runDir, {
      status: RUN_STATUS.COMMITTED,
      committed_at: new Date().toISOString(),
      committed: { sent_history_appended: 0, dedupe_guard: "runDir_present" },
    });
    return { committed: false, reason: "already_committed_by_runDir" };
  }

  const pending = loadPendingHistory(runDir);
  const appended = appendSentHistoryEntries(pending.entries);

  writeRunState(runDir, {
    status: RUN_STATUS.COMMITTED,
    committed_at: new Date().toISOString(),
    committed: { sent_history_appended: appended },
  });

  return { committed: true, appended };
}

/**
 * Send a run (atomic-ish):
 * - idempotent by send_result.json (won't resend)
 * - writes send_result.json
 * - updates state.json -> SENT
 * - commits pending_sent_history.json -> state/sent_history.jsonl
 * - updates state.json -> COMMITTED
 */
export async function sendRun({ runDir, recipients }) {
  if (!runDir) throw new Error("sendRun: runDir is required");
  if (!Array.isArray(recipients) || recipients.length < 1) {
    throw new Error('sendRun: recipients required (e.g. ["a@x.com"])');
  }

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

  // Idempotency: don't resend if receipt exists (or legacy artifact exists)
  const sendResultPath = path.join(runDir, "send_result.json");
  const legacySendResultPath = path.join(runDir, "gmail_send_result.json");

  const stateBefore = readRunState(runDir);
  if (stateBefore?.status === RUN_STATUS.COMMITTED || stateBefore?.committed_at) {
    return {
      ok: true,
      alreadyCommitted: true,
      runDir,
      to: recipients,
      subject,
      status: stateBefore?.status ?? null,
    };
  }

  if (exists(sendResultPath) || exists(legacySendResultPath)) {
    const receipt = exists(sendResultPath)
      ? readJsonIfExists(sendResultPath, {})
      : readJsonIfExists(legacySendResultPath, {});

    if (stateBefore?.status !== RUN_STATUS.SENT && stateBefore?.status !== RUN_STATUS.COMMITTED) {
      writeRunState(runDir, { status: RUN_STATUS.SENT, send: receipt });
    }

    const commitInfo = commitRunHistoryIfNeeded(runDir);
    return {
      ok: true,
      alreadySent: true,
      runDir,
      to: recipients,
      subject,
      messageId: receipt?.messageId ?? receipt?.result?.id ?? null,
      commit: commitInfo,
    };
  }

  const oauthClientPath = "/opt/openclaw-poc/secrets/google_oauth_client.json";
  const tokensPath = "/opt/openclaw-poc/secrets/google_tokens.json";

  if (!exists(oauthClientPath)) throw new Error(`Missing ${oauthClientPath}`);
  if (!exists(tokensPath)) throw new Error(`Missing ${tokensPath}`);

  const oauthClient = readJson(oauthClientPath);
  const tokens = readJson(tokensPath);

  const client = oauthClient.installed ?? oauthClient.web ?? oauthClient;
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

  const toHeader = recipients.join(", ");
  const raw = buildRawEmail({ to: toHeader, subject, bodyText });

  let result;
  let used_token_refresh = false;

  try {
    result = await gmailSendRaw({ accessToken, rawRfc822: raw });
  } catch (err) {
    const msg = err?.message ?? String(err);
    const looksAuth =
      msg.includes("401") ||
      msg.toLowerCase().includes("invalid") ||
      msg.toLowerCase().includes("unauthorized");

    if (!looksAuth) throw err;
    if (!refresh_token) {
      throw new Error(
        "Access token failed and no refresh_token present. Re-run OAuth flow to obtain refresh_token."
      );
    }

    const refreshed = await refreshAccessToken({ client_id, client_secret, refresh_token });
    accessToken = refreshed.access_token;
    used_token_refresh = true;

    const newTokens = {
      ...tokens,
      access_token: accessToken,
      token_type: refreshed.token_type ?? tokens.token_type ?? "Bearer",
      scope: refreshed.scope ?? tokens.scope,
      expires_in: refreshed.expires_in,
      refreshed_at: new Date().toISOString(),
    };
    writeJson(tokensPath, newTokens);

    result = await gmailSendRaw({ accessToken, rawRfc822: raw });
  }

  const receipt = {
    ok: true,
    runDir,
    to: recipients,
    subject,
    messageId: result?.id ?? null,
    threadId: result?.threadId ?? null,
    result,
    used_token_refresh,
    ts: new Date().toISOString(),
  };

  writeJson(sendResultPath, receipt);
  writeJson(path.join(runDir, "gmail_send_result.json"), receipt); // compat

  writeRunState(runDir, { status: RUN_STATUS.SENT, send: receipt });

  const commitInfo = commitRunHistoryIfNeeded(runDir);

  return {
    ok: true,
    runDir,
    to: recipients,
    subject,
    messageId: receipt.messageId,
    refreshed: used_token_refresh,
    commit: commitInfo,
  };
}
