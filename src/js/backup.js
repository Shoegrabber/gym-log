// Automatic backup.
//
// After every finished session the whole database is written to
//   Documents/GymLogBackups/gym_log_latest.json   (always the newest)
//   Documents/GymLogBackups/gym_log_<date>.json   (one per day)
// with no share dialog. If a GitHub repo + token have been entered in
// Settings, the same file is also pushed to that repo, so the laptop can
// pull it without any manual export.
//
// The JSON keeps the old export shape (export_format_version 1,
// tables.sessions / exercises / session_exercises / sets) so existing
// scripts keep working; it just carries more columns and tables.

import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { dumpAll, restoreAll, getSetting, setSetting } from "./db.js";

const DIR = "GymLogBackups";
const GH_PATH = "backups/gym_log_latest.json";

export async function buildBackupText() {
  const tables = await dumpAll();
  return JSON.stringify(
    {
      export_format_version: 1,
      backup_version: 2,
      exported_at: new Date().toISOString(),
      db_name: "gym_log",
      tables,
    },
    null,
    1
  );
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// UTF-8 safe base64 for the GitHub contents API.
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function pushToGitHub(text, repo, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${repo}/contents`;
  // The existing file's sha is needed to overwrite it. Read it from the
  // folder listing (the file itself can be too big for a direct GET).
  let sha;
  const dir = GH_PATH.split("/").slice(0, -1).join("/");
  const list = await fetch(`${base}/${dir}`, { headers });
  if (list.ok) {
    const items = await list.json();
    sha = (Array.isArray(items) ? items : []).find((i) => i.path === GH_PATH)?.sha;
  } else if (list.status !== 404) {
    throw new Error(`GitHub said ${list.status} when checking the repo`);
  }
  const put = await fetch(`${base}/${GH_PATH}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Gym log backup ${new Date().toISOString()}`,
      content: toBase64(text),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) throw new Error(`GitHub said ${put.status} when saving the backup`);
}

/**
 * Runs a backup now. Never throws — a failed backup must not get in the
 * way of finishing a session. Returns { ok, where: [...], error }.
 */
export async function runBackup({ log } = {}) {
  const result = { ok: false, where: [], error: null, at: Date.now() };
  try {
    const text = await buildBackupText();

    if (Capacitor.isNativePlatform()) {
      for (const name of ["gym_log_latest.json", `gym_log_${todayStamp()}.json`]) {
        await Filesystem.writeFile({
          path: `${DIR}/${name}`,
          data: text,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        });
      }
      result.where.push("phone");
    }

    const repo = await getSetting("gh_repo", "");
    const token = await getSetting("gh_token", "");
    if (repo && token) {
      try {
        await pushToGitHub(text, repo, token);
        result.where.push("GitHub");
      } catch (e) {
        result.error = String(e.message || e);
      }
    }
    result.ok = result.where.length > 0 && !result.error;
  } catch (e) {
    result.error = String(e.message || e);
  }
  try {
    await setSetting("last_backup", JSON.stringify(result));
  } catch (_) { /* ignore */ }
  if (typeof log === "function") {
    log(result.error ? `⚠️ Backup: ${result.error}` : `✅ Backup saved (${result.where.join(" + ") || "nowhere"})`);
  }
  return result;
}

export async function lastBackupText() {
  let r = null;
  try {
    r = JSON.parse(await getSetting("last_backup", "null"));
  } catch (_) { /* none */ }
  if (!r) return "No backup yet. One is saved automatically each time you finish a session.";
  const when = new Date(r.at).toLocaleString();
  if (r.error) return `Last backup ${when}: saved to ${r.where.join(" + ") || "nowhere"}, but: ${r.error}`;
  if (!r.where.length) return `Last backup ${when}: nothing saved (backups to the phone only work in the installed app).`;
  return `Last backup ${when} — saved to ${r.where.join(" + ")}.`;
}

/** Replace all data with a backup file's contents. */
export async function restoreFromText(text, { log } = {}) {
  const json = JSON.parse(text);
  const tables = json?.tables ?? json;
  await restoreAll(tables, log);
  return { sessions: tables.sessions.length, sets: tables.sets.length };
}
