// src/js/session-io.js
// Item 8 — file-based export/import of *session templates* (not full DB
// backups; see export.js for that). A template is just a name + an ordered
// list of exercise names, so it's a tiny, human-readable JSON file Ben can
// share with his partner via any app (WhatsApp, Drive, email…). Importing
// one saves it as a custom template (item 7).

import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  getCustomTemplate,
  getCustomTemplateExercises,
  createCustomTemplate,
  getSessionDetail,
  listSessionExercises,
} from "./db.js";

const TEMPLATE_FORMAT = "gymlog_session_template";

function buildTemplateJson(name, exerciseNames) {
  return {
    type: TEMPLATE_FORMAT,
    version: 1,
    name,
    exercises: exerciseNames,
    exported_at: new Date().toISOString(),
  };
}

function safeSlug(name) {
  return (
    String(name || "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "session"
  );
}

// Write a template file + share it (native), or trigger a browser download
// (web). Shared by both the custom-template and session-derived exporters.
async function writeAndShare(name, text, { log } = {}) {
  const filename = `gymlog_template_${safeSlug(name)}.json`;

  if (Capacitor.isNativePlatform()) {
    const path = `GymLogTemplates/${filename}`;
    await Filesystem.writeFile({
      path,
      data: text,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    const uriRes = await Filesystem.getUri({ directory: Directory.Documents, path });
    if (typeof log === "function") log(`✅ Saved template to Documents/${path}`);
    try {
      await Share.share({
        title: `Gym session: ${name}`,
        text: `Gym Log session template: ${name}`,
        url: uriRes.uri,
      });
    } catch (_) {
      // user cancelled share — file is still saved
    }
  } else {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof log === "function") log(`✅ Downloaded ${filename}`);
  }
}

// Export a saved custom template (item 7) as a shareable file.
export async function exportCustomTemplate(templateId, { log } = {}) {
  const tpl = await getCustomTemplate(templateId);
  if (!tpl) throw new Error("Template not found");
  const ex = await getCustomTemplateExercises(templateId);
  const names = ex.map((e) => e.exercise_name);
  const text = JSON.stringify(buildTemplateJson(tpl.name, names), null, 2);
  await writeAndShare(tpl.name, text, { log });
}

// Export any logged session (e.g. from History) as a template file, so Ben
// can share "the workout I actually did" as a starting point for someone.
export async function exportSessionAsTemplate(sessionId, { log } = {}) {
  const detail = await getSessionDetail(sessionId);
  const rows = await listSessionExercises(sessionId);
  const names = rows.map((r) => r.exercise_name);
  const name = detail ? `${detail.focus} ${detail.date}` : `Session ${sessionId}`;
  const text = JSON.stringify(buildTemplateJson(name, names), null, 2);
  await writeAndShare(name, text, { log });
}

// Parse imported JSON text and save it as a new custom template.
// Returns { id, name, count }.
export async function importTemplateFromText(text, { log } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("That file isn't valid JSON.");
  }
  if (!data || data.type !== TEMPLATE_FORMAT || !Array.isArray(data.exercises)) {
    throw new Error("That file isn't a Gym Log session template.");
  }
  const name = String(data.name || "Imported session").trim();
  const names = data.exercises.map((x) => String(x || "").trim()).filter(Boolean);
  const id = await createCustomTemplate(name, names, log);
  if (typeof log === "function") log(`✅ Imported "${name}" (${names.length} exercises)`);
  return { id, name, count: names.length };
}
