// src/js/export.js
import { initDb } from "./db.js";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";


/* -----------------------------
   Small boring utilities
----------------------------- */

// Convert epoch millis (INTEGER) to ISO string for metadata only.
// We do NOT convert DB fields during export; we export raw values.
function isoNow() {
  return new Date().toISOString();
}

// Safe CSV encoding: quotes doubled, fields quoted only when needed.
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  const mustQuote = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return mustQuote ? `"${escaped}"` : escaped;
}

function rowsToCsv(headers, rows) {
  const lines = [];
  lines.push(headers.join(","));
  for (const row of rows) {
    const line = headers.map(h => csvEscape(row[h])).join(",");
    lines.push(line);
  }
  return lines.join("\n");
}

function downloadTextFile(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportStamp() {
  // Filename-safe timestamp: 2026-01-01_162145
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function writeTextFileAndroid({ path, text }) {
  await Filesystem.writeFile({
    path,
    data: text,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  const uriRes = await Filesystem.getUri({
    directory: Directory.Documents,
    path,
  });

  return uriRes.uri;
}

/* -----------------------------
   Queries (faithful + deterministic)
----------------------------- */

async function queryAll(conn, sql, params = []) {
  const res = await conn.query(sql, params);
  return res.values ?? [];
}

export async function exportAllWeb({ log } = {}) {
  const conn = await initDb(typeof log === "function" ? log : undefined);

  // 1) sessions
  const sessionsHeaders = ["id", "date", "focus", "notes", "status", "created_at", "finished_at"];
  const sessions = await queryAll(
    conn,
    `SELECT id, date, focus, notes, status, created_at, finished_at
     FROM sessions
     ORDER BY created_at ASC, id ASC;`
  );

  // 2) exercises
  const exercisesHeaders = ["id", "name", "created_at"];
  const exercises = await queryAll(
    conn,
    `SELECT id, name, created_at
     FROM exercises
     ORDER BY name ASC, id ASC;`
  );

  // 3) session_exercises
  const sessionExercisesHeaders = ["id", "session_id", "exercise_name", "notes", "created_at", "position"];
  const sessionExercises = await queryAll(
    conn,
    `SELECT id, session_id, exercise_name, notes, created_at, position
     FROM session_exercises
     ORDER BY session_id ASC, position ASC, created_at ASC, id ASC;`
  );

// 4) sets
const setsHeaders = [
  "id",
  "session_exercise_id",
  "position",
  "weight",
  "weight_unit",
  "reps",
  "duration_sec",
  "distance_m",
  "assisted",
  "notes",
  "created_at"
];

const sets = await queryAll(
  conn,
  `SELECT
      id,
      session_exercise_id,
      position,
      weight,
      weight_unit,
      reps,
      duration_sec,
      distance_m,
      assisted,
      notes,
      created_at
   FROM sets
   ORDER BY session_exercise_id ASC, position ASC, created_at ASC, id ASC;`
);

  const stamp = exportStamp();

  // CSV downloads (separate files, no zip yet)
  downloadTextFile(`gym_log_${stamp}_sessions.csv`, rowsToCsv(sessionsHeaders, sessions), "text/csv;charset=utf-8");
  downloadTextFile(`gym_log_${stamp}_exercises.csv`, rowsToCsv(exercisesHeaders, exercises), "text/csv;charset=utf-8");
  downloadTextFile(`gym_log_${stamp}_session_exercises.csv`, rowsToCsv(sessionExercisesHeaders, sessionExercises), "text/csv;charset=utf-8");
  downloadTextFile(`gym_log_${stamp}_sets.csv`, rowsToCsv(setsHeaders, sets), "text/csv;charset=utf-8");

  // JSON download (faithful table dumps + metadata)
  const json = {
    export_format_version: 1,
    exported_at: isoNow(),
    db_name: "gym_log",
    db_version: 1,
    tables: {
      sessions,
      exercises,
      session_exercises: sessionExercises,
      sets
    }
  };

  downloadTextFile(
    `gym_log_${stamp}_export.json`,
    JSON.stringify(json, null, 2),
    "application/json;charset=utf-8"
  );

  if (typeof log === "function") {
    log(`✅ Export complete: ${sessions.length} sessions, ${exercises.length} exercises, ${sessionExercises.length} session_exercises, ${sets.length} sets`);
  }
}
export async function exportAllAndroid({ log } = {}) {
  const conn = await initDb(typeof log === "function" ? log : undefined);

  // Queries identical to Web export
  const sessionsHeaders = ["id", "date", "focus", "notes", "status", "created_at", "finished_at"];
  const sessions = await queryAll(conn, `
    SELECT id, date, focus, notes, status, created_at, finished_at
    FROM sessions
    ORDER BY created_at ASC, id ASC;
  `);

  const exercisesHeaders = ["id", "name", "created_at"];
  const exercises = await queryAll(conn, `
    SELECT id, name, created_at
    FROM exercises
    ORDER BY name ASC, id ASC;
  `);

  const sessionExercisesHeaders = ["id", "session_id", "exercise_name", "notes", "created_at", "position"];
  const sessionExercises = await queryAll(conn, `
    SELECT id, session_id, exercise_name, notes, created_at, position
    FROM session_exercises
    ORDER BY session_id ASC, position ASC, created_at ASC, id ASC;
  `);

const setsHeaders = [
  "id",
  "session_exercise_id",
  "position",
  "weight",
  "weight_unit",
  "reps",
  "duration_sec",
  "distance_m",
  "assisted",
  "notes",
  "created_at"
];

const sets = await queryAll(conn, `
  SELECT
    id,
    session_exercise_id,
    position,
    weight,
    weight_unit,
    reps,
    duration_sec,
    distance_m,
    assisted,
    notes,
    created_at
  FROM sets
  ORDER BY session_exercise_id ASC, position ASC, created_at ASC, id ASC;
`);

  const stamp = exportStamp();
  const folder = `GymLogExports/${stamp}`;

  const sessionsCsv = rowsToCsv(sessionsHeaders, sessions);
  const exercisesCsv = rowsToCsv(exercisesHeaders, exercises);
  const sessionExercisesCsv = rowsToCsv(sessionExercisesHeaders, sessionExercises);
  const setsCsv = rowsToCsv(setsHeaders, sets);

  const json = {
    export_format_version: 1,
    exported_at: isoNow(),
    db_name: "gym_log",
    db_version: 1,
    tables: {
      sessions,
      exercises,
      session_exercises: sessionExercises,
      sets,
    },
  };

  const jsonText = JSON.stringify(json, null, 2);

  await writeTextFileAndroid({ path: `${folder}/sessions.csv`, text: sessionsCsv });
  await writeTextFileAndroid({ path: `${folder}/exercises.csv`, text: exercisesCsv });
  await writeTextFileAndroid({ path: `${folder}/session_exercises.csv`, text: sessionExercisesCsv });
  await writeTextFileAndroid({ path: `${folder}/sets.csv`, text: setsCsv });

  const jsonUri = await writeTextFileAndroid({
    path: `${folder}/export.json`,
    text: jsonText,
  });

  if (typeof log === "function") {
    log(`✅ Export saved to Documents/${folder}`);
  }

  try {
    await Share.share({
      title: "Gym Log Export",
      text: `Gym Log export saved to Documents/${folder}`,
      url: jsonUri,
    });
  } catch (_) {
    // User cancelled share — safe to ignore
  }
}

export async function exportAll({ log } = {}) {
  if (Capacitor.isNativePlatform()) {
    return exportAllAndroid({ log });
  }
  return exportAllWeb({ log });
}
