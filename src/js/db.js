import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { TEMPLATES, UNILATERAL_EXERCISES, MEASUREMENT_TYPES } from "./templates.js";

const DB_NAME = "gym_log";
const DB_VERSION = 1;

// Correct manager wrapper
const sqlite = new SQLiteConnection(CapacitorSQLite);

// Keep a single connection reference
let db = null;

/* --------------------------------------------------
   Core DB bootstrap
-------------------------------------------------- */
export async function initDb(log) {
  try {
    if (db) return db;

    // Optional: helps avoid weird “dangling” state on Android
    try {
      await sqlite.checkConnectionsConsistency();
    } catch (_) { }

    const conn = await sqlite.createConnection(
      DB_NAME,
      false,            // encrypted
      "no-encryption",  // mode
      DB_VERSION
    );

    if (!conn) throw new Error("createConnection returned null/undefined");

    await conn.open();
    db = conn;

    // Enforce foreign keys so ON DELETE CASCADE actually fires. SQLite
    // defaults this OFF per-connection; without it, deleting a session
    // left its session_exercises + sets behind as orphans (the root of
    // the ghost-PB bug). PRAGMA cannot run inside a transaction, so pass
    // transaction=false.
    try {
      await db.execute(`PRAGMA foreign_keys = ON;`, false);
    } catch (e) {
      if (typeof log === "function") log("⚠️ Could not enable foreign_keys:", String(e));
    }

    // -----------------------------
    // Core tables (Phase A)
    // -----------------------------
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        focus TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // -----------------------------
    // Exercises library (Phase B-0)
    // -----------------------------

    await db.execute(`
  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    measurement_type TEXT NOT NULL DEFAULT 'weight_reps',
    created_at INTEGER NOT NULL
  );
`);

    // Phase G — Migration: add measurement_type to exercises
    try {
      await db.execute(`
    ALTER TABLE exercises
    ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'weight_reps'
  `);
      if (typeof log === "function") {
        log("✅ Migration OK: added exercises.measurement_type");
      }
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (
        !msg.includes("duplicate") &&
        !msg.includes("already exists")
      ) {
        if (typeof log === "function") {
          log("⚠️ Migration warning (measurement_type):", msg);
        }
      }
    }

    // Phase H — Migration: add is_unilateral to exercises
    try {
      await db.execute(`
    ALTER TABLE exercises
    ADD COLUMN is_unilateral INTEGER NOT NULL DEFAULT 0
  `);
      if (typeof log === "function") {
        log("✅ Migration OK: added exercises.is_unilateral");
      }
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") {
          log("⚠️ Migration warning (is_unilateral):", msg);
        }
      }
    }

    // (Measurement-type assignment now lives in applyMeasurementTypes(),
    // driven by the declarative MEASUREMENT_TYPES map — see end of initDb.)

    // -----------------------------
    // Session exercises (Phase B-1)
    // -----------------------------
    await db.execute(`
      CREATE TABLE IF NOT EXISTS session_exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        exercise_name TEXT NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    // Phase E — Migration: add ordering column to session_exercises (position)
    // Must run AFTER table exists, safe to run multiple times
    try {
      await db.execute(`
    ALTER TABLE session_exercises
    ADD COLUMN position INTEGER NOT NULL DEFAULT 0
  `);
      if (typeof log === "function") {
        log("✅ Migration OK: added session_exercises.position");
      }
    } catch (e) {
      // Ignore duplicate-column errors (already migrated)
      const msg = String(e || "").toLowerCase();
      if (
        !msg.includes("duplicate") &&
        !msg.includes("already exists")
      ) {
        if (typeof log === "function") {
          log("⚠️ Migration warning (position):", msg);
        }
      }
    }

    // -----------------------------
    // Sets (Phase C)
    // -----------------------------

    await db.execute(`
  CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_exercise_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    weight REAL NULL,
    weight_unit TEXT NULL,
    reps INTEGER NULL,
    duration_sec INTEGER NULL,
    distance_m REAL NULL,
    assisted INTEGER NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_exercise_id) REFERENCES session_exercises(id) ON DELETE CASCADE
  );
`);

    // Phase G — Migration: extend sets for semantics

    // 1) weight_unit
    try {
      await db.execute(`ALTER TABLE sets ADD COLUMN weight_unit TEXT NULL`);
      if (typeof log === "function") log("✅ Migration OK: added sets.weight_unit");
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") log("⚠️ Migration warning (sets.weight_unit):", msg);
      }
    }

    // 2) duration_sec
    try {
      await db.execute(`ALTER TABLE sets ADD COLUMN duration_sec INTEGER NULL`);
      if (typeof log === "function") log("✅ Migration OK: added sets.duration_sec");
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") log("⚠️ Migration warning (sets.duration_sec):", msg);
      }
    }

    // 3) distance_m
    try {
      await db.execute(`ALTER TABLE sets ADD COLUMN distance_m REAL NULL`);
      if (typeof log === "function") log("✅ Migration OK: added sets.distance_m");
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") log("⚠️ Migration warning (sets.distance_m):", msg);
      }
    }

    // 4) assisted
    try {
      await db.execute(`ALTER TABLE sets ADD COLUMN assisted INTEGER NOT NULL DEFAULT 0`);
      if (typeof log === "function") log("✅ Migration OK: added sets.assisted");
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") log("⚠️ Migration warning (sets.assisted):", msg);
      }
    }

    // Phase H — Migration: add side to sets (NULL/L/R for unilateral exercises)
    try {
      await db.execute(`ALTER TABLE sets ADD COLUMN side TEXT NULL`);
      if (typeof log === "function") log("✅ Migration OK: added sets.side");
    } catch (e) {
      const msg = String(e || "").toLowerCase();
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        if (typeof log === "function") log("⚠️ Migration warning (sets.side):", msg);
      }
    }

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_sets_session_exercise_id
      ON sets(session_exercise_id);
    `);

    // -----------------------------
    // Custom session templates (Build 2 — item 7)
    // A saved, reusable list of exercises Ben builds himself. Selectable
    // in the Create-session dropdown as focus="custom:<id>", and the unit
    // that item 8 export/import ships around as a shareable file.
    // -----------------------------
    await db.execute(`
      CREATE TABLE IF NOT EXISTS custom_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS custom_template_exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        exercise_name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (template_id) REFERENCES custom_templates(id) ON DELETE CASCADE
      );
    `);

    // Build 1 — idempotent migrations & one-time cleanup. Order matters:
    // rename before measurement types (so the renamed row gets its type),
    // and orphan purge last (it backs up the post-rename state).
    await renameSeatedInclineOnce(log);
    await applyMeasurementTypes(log);
    await cleanupOrphansOnce(log);

    if (typeof log === "function") log("✅ initDb OK");
    return db;
  } catch (e) {
    if (typeof log === "function") log("❌ initDb failed:", String(e));
    throw e;
  }
}

/* --------------------------------------------------
   Active session helpers
-------------------------------------------------- */
export async function getActiveSessionId() {
  await initDb();
  const res = await db.query(`SELECT value FROM app_state WHERE key='active_session_id'`);
  return res.values?.[0]?.value ?? null;
}

export async function setActiveSessionId(sessionId) {
  await initDb();
  await db.run(
    `INSERT OR REPLACE INTO app_state (key, value) VALUES ('active_session_id', ?)`,
    [String(sessionId)]
  );
}

export async function clearActiveSessionId() {
  await initDb();
  await db.run(`DELETE FROM app_state WHERE key='active_session_id'`);
}
/* --------------------------------------------------
   Exercise seed helpers (Phase B-0)
-------------------------------------------------- */

// Bumped to v3 when Rith's 4-day split added new canonical exercises
// (Barbell RDL, Close-grip pull-up, etc.). Re-running the seed is safe —
// every insert is INSERT OR IGNORE, so existing rows are untouched and
// only the new names get added on upgrade.
const SEED_KEY = "seed_exercises_v3";

async function hasSeededExercises() {
  const res = await db.query(
    `SELECT value FROM app_state WHERE key=?`,
    [SEED_KEY]
  );
  return res.values?.[0]?.value === "1";
}

async function setSeededExercises() {
  await db.run(
    `INSERT OR REPLACE INTO app_state (key, value)
     VALUES (?, '1')`,
    [SEED_KEY]
  );
}

export async function seedExercisesFromCsv(log) {
  await initDb(log);

  if (await hasSeededExercises()) {
    if (typeof log === "function") log("ℹ️ exercises seed already applied");
    await markUnilateralExercises(log);
    return;
  }

  try {
    const resp = await fetch("/exercises_seed.csv");
    if (!resp.ok) {
      throw new Error(`Failed to fetch exercises_seed.csv (${resp.status})`);
    }

    const text = await resp.text();
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    // Expect header: exercise_name
    const rows = lines.slice(1);
    const now = Date.now();

    for (const row of rows) {
      const name = row.replace(/^"|"$/g, "").trim();
      if (!name) continue;

      await db.run(
        `INSERT OR IGNORE INTO exercises (name, created_at)
         VALUES (?, ?)`,
        [name, now]
      );
    }

    await setSeededExercises();
    await markUnilateralExercises(log);

    if (typeof log === "function") {
      log(`✅ Seeded exercises from CSV (${rows.length} rows)`);
    }
  } catch (e) {
    if (typeof log === "function") {
      log("❌ seedExercisesFromCsv failed:", String(e));
    }
    throw e;
  }
}

async function markUnilateralExercises(log) {
  for (const name of UNILATERAL_EXERCISES) {
    await db.run(
      `UPDATE exercises SET is_unilateral = 1 WHERE name = ?`,
      [name]
    );
  }
  if (typeof log === "function") {
    log(`✅ Marked ${UNILATERAL_EXERCISES.length} unilateral exercises`);
  }
}

export async function listExercises(limit = 500) {
  await initDb();
  const res = await db.query(
    `SELECT * FROM exercises ORDER BY name ASC LIMIT ?`,
    [limit]
  );
  return res.values ?? [];
}

// Phase G — Exercise semantics
export async function setExerciseMeasurementType(name, measurementType) {
  await initDb();
  await db.run(
    `UPDATE exercises SET measurement_type = ? WHERE name = ?`,
    [measurementType, name]
  );
}


export async function deleteSessionExercise(sessionExerciseId) {
  const conn = await initDb(() => { });
  await conn.run(`DELETE FROM session_exercises WHERE id = ?;`, [sessionExerciseId]);
}

/* --------------------------------------------------
   Session lifecycle
-------------------------------------------------- */

export async function createSession({ date, focus, notes }) {
  await initDb();

  const now = Date.now();
  const safeDate =
    date && String(date).trim()
      ? date
      : new Date().toISOString().slice(0, 10);

  const safeFocus = (focus && String(focus).trim()) ? focus : "other";

  const res = await db.run(
    `
    INSERT INTO sessions (date, focus, notes, status, created_at)
    VALUES (?, ?, ?, 'active', ?)
    `,
    [safeDate, safeFocus, notes ?? null, now]
  );

  let sessionId = res?.changes?.lastId;

  if (!sessionId) {
    const q = await db.query(`SELECT last_insert_rowid() AS id`);
    sessionId = q?.values?.[0]?.id;
  }

  if (!sessionId) {
    throw new Error("createSession: could not determine inserted session id");
  }

  await setActiveSessionId(sessionId);
  return sessionId;
}


export async function listSessions(limit = 20) {
  await initDb();
  const res = await db.query(
    `SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
  return res.values ?? [];
}

export async function listSets(sessionExerciseId) {
  await initDb();
  const res = await db.query(
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
      side,
      notes,
      created_at
     FROM sets
     WHERE session_exercise_id = ?
     ORDER BY position ASC, id ASC;`,
    [sessionExerciseId]
  );
  return res.values ?? [];
}

/**
 * Returns the most recent set for a given exercise name,
 * looking across all previous sessions.
 */
export async function getLatestSetForExercise(exerciseName) {
  await initDb();
  const res = await db.query(
    `SELECT s.*
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     WHERE se.exercise_name = ?
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [exerciseName]
  );
  return res.values?.[0] ?? null;
}

/**
 * Returns the personal best for a given exercise name, normalised to kg.
 * Rows logged as lbs are converted on the fly so a 200-lb entry doesn't
 * eclipse a real 91-kg PB. Returned value is rounded to 1 decimal kg.
 */
export async function getPersonalBest(exerciseName) {
  await initDb();
  const res = await db.query(
    `SELECT MAX(
        CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END
     ) as pb
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN sessions sess ON se.session_id = sess.id
     WHERE se.exercise_name = ?
       AND s.weight IS NOT NULL`,
    [exerciseName]
  );
  const raw = res.values?.[0]?.pb;
  if (raw == null) return null;
  return Math.round(Number(raw) * 10) / 10;
}

/**
 * Returns the top-N heaviest sets ever logged for this exercise across
 * all prior sessions, normalised to kg. Used by the PB inspector so the
 * user can spot a single outlier (e.g. an lbs entry mis-logged as kg
 * many months ago) and fix it surgically without scrolling a year of
 * sessions. Current session is excluded — it has its own edit UI inline.
 */
export async function getTopSetsForExercise(exerciseName, currentSessionId, limit = 5) {
  await initDb();
  const res = await db.query(
    `SELECT s.id, s.session_exercise_id, s.weight, s.weight_unit, s.reps, s.side,
            s.duration_sec, s.notes,
            (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) AS norm_kg,
            se.session_id, sess.date AS session_date, sess.focus AS session_focus
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN sessions sess ON se.session_id = sess.id
     WHERE se.exercise_name = ?
       AND s.weight IS NOT NULL
       AND se.session_id != ?
     ORDER BY norm_kg DESC, s.created_at DESC
     LIMIT ?`,
    [exerciseName, currentSessionId ?? -1, limit]
  );
  return res.values ?? [];
}

/**
 * Returns the sets from the most recent PRIOR session_exercise for the
 * given exercise name (excluding the current session). Used by the PB
 * drill-down so the user can see how the last session actually went —
 * a one-off heavy single vs. a real working weight.
 */
export async function getLastSessionSetsForExercise(exerciseName, currentSessionId) {
  await initDb();
  const seRes = await db.query(
    `SELECT id FROM session_exercises
     WHERE exercise_name = ? AND session_id != ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [exerciseName, currentSessionId ?? -1]
  );
  const seId = seRes.values?.[0]?.id;
  if (!seId) return [];
  const setRes = await db.query(
    `SELECT position, weight, weight_unit, reps, duration_sec, side
     FROM sets
     WHERE session_exercise_id = ?
     ORDER BY position ASC, id ASC`,
    [seId]
  );
  return setRes.values ?? [];
}

/**
 * Lists exercise names that appear in old session_exercises but have no
 * matching row in the canonical exercises table — orphans from older
 * templates whose names changed in Phase H. Used by the merge tool to
 * resurface old PBs under their new canonical names.
 */
export async function listOrphanExerciseNames() {
  await initDb();
  const res = await db.query(
    `SELECT DISTINCT se.exercise_name AS name,
            COUNT(s.id) AS set_count
     FROM session_exercises se
     LEFT JOIN exercises e ON e.name = se.exercise_name
     LEFT JOIN sets s ON s.session_exercise_id = se.id
     WHERE e.id IS NULL
     GROUP BY se.exercise_name
     ORDER BY set_count DESC, name ASC`
  );
  return res.values ?? [];
}

/**
 * Renames every session_exercises row from oldName to newName, so old
 * PBs surface under the new canonical name. Idempotent — running twice
 * with the same args does nothing the second time.
 */
export async function mergeExerciseName(oldName, newName) {
  await initDb();
  if (!oldName || !newName || oldName === newName) return 0;
  const before = await db.query(
    `SELECT COUNT(*) AS c FROM session_exercises WHERE exercise_name = ?`,
    [oldName]
  );
  const count = Number(before.values?.[0]?.c ?? 0);
  if (!count) return 0;
  await db.run(
    `UPDATE session_exercises SET exercise_name = ? WHERE exercise_name = ?`,
    [newName, oldName]
  );
  return count;
}

async function getNextSetPosition(sessionExerciseId) {
  await initDb();
  const res = await db.query(
    `SELECT COALESCE(MAX(position), 0) + 1 AS nextPos
     FROM sets
     WHERE session_exercise_id = ?;`,
    [sessionExerciseId]
  );
  const row = res.values?.[0] ?? null;
  return row ? Number(row.nextPos) : 1;
}

export async function insertSet({
  sessionExerciseId,
  weight = null,
  weight_unit = null,
  reps = null,
  duration_sec = null,
  distance_m = null,
  assisted = 0,
  side = null,
  notes = null
}) {
  await initDb();
  const position = await getNextSetPosition(sessionExerciseId);

  const w = (weight === "" || weight === undefined || weight === null) ? null : Number(weight);
  const wu = (weight_unit === "" || weight_unit === undefined || weight_unit === null) ? null : String(weight_unit);

  const r = (reps === "" || reps === undefined || reps === null) ? null : Number(reps);
  const dsec = (duration_sec === "" || duration_sec === undefined || duration_sec === null) ? null : Number(duration_sec);
  const dm = (distance_m === "" || distance_m === undefined || distance_m === null) ? null : Number(distance_m);

  const a = assisted ? 1 : 0;
  const sd = (side === "" || side === undefined || side === null) ? null : String(side).toUpperCase();

  const n = (notes === "" || notes === undefined || notes === null) ? null : String(notes);

  const now = Date.now();

  const result = await db.run(
    `INSERT INTO sets (
        session_exercise_id,
        position,
        weight,
        weight_unit,
        reps,
        duration_sec,
        distance_m,
        assisted,
        side,
        notes,
        created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [sessionExerciseId, position, w, wu, r, dsec, dm, a, sd, n, now]
  );

  return {
    id: result.lastId,
    session_exercise_id: sessionExerciseId,
    position,
    weight: w,
    weight_unit: wu,
    reps: r,
    duration_sec: dsec,
    distance_m: dm,
    assisted: a,
    side: sd,
    notes: n,
    created_at: now
  };
}

export async function deleteSet(setId) {
  await initDb();
  await db.run(`DELETE FROM sets WHERE id = ?;`, [setId]);
}

export async function updateSet(setId, fields) {
  await initDb();
  const allowed = ["weight", "weight_unit", "reps", "duration_sec", "distance_m", "side", "notes"];
  const cols = [];
  const vals = [];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      cols.push(`${k} = ?`);
      const v = fields[k];
      vals.push(v === "" || v === undefined ? null : v);
    }
  }
  if (!cols.length) return;
  vals.push(setId);
  await db.run(`UPDATE sets SET ${cols.join(", ")} WHERE id = ?`, vals);
}

/**
 * Returns total volume (Σ weight × reps) for a session, in kg.
 * lbs sets are converted to kg before summing.
 */
export async function getSessionVolume(sessionId) {
  await initDb();
  const res = await db.query(
    `SELECT s.weight, s.reps, s.weight_unit
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     WHERE se.session_id = ?
       AND s.weight IS NOT NULL
       AND s.reps IS NOT NULL`,
    [sessionId]
  );
  let total = 0;
  for (const row of res.values ?? []) {
    const w = Number(row.weight);
    const r = Number(row.reps);
    if (!Number.isFinite(w) || !Number.isFinite(r)) continue;
    const kg = row.weight_unit === "lbs" ? w * 0.45359237 : w;
    total += kg * r;
  }
  return Math.round(total);
}

/* --------------------------------------------------
   Dashboard stats (home/idle mini-dashboard)
-------------------------------------------------- */

// Monday-anchored start of the week containing `d`, at 00:00 local.
function weekStartMonday(d) {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function getTotalSessionCount() {
  await initDb();
  const res = await db.query(`SELECT COUNT(*) AS c FROM sessions`);
  return Number(res.values?.[0]?.c ?? 0);
}

/**
 * Total volume (Σ normalised-kg × reps) for sessions whose date falls in
 * [startISO, endISO). Dates are 'YYYY-MM-DD' strings so lexicographic
 * comparison is correct. lbs sets are converted to kg in SQL.
 */
export async function getVolumeBetween(startISO, endISO) {
  await initDb();
  const res = await db.query(
    `SELECT COALESCE(SUM(
        (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps
     ), 0) AS vol
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN sessions sess ON se.session_id = sess.id
     WHERE s.weight IS NOT NULL AND s.reps IS NOT NULL
       AND sess.date >= ? AND sess.date < ?`,
    [startISO, endISO]
  );
  return Math.round(Number(res.values?.[0]?.vol ?? 0));
}

/**
 * Top-N exercises by personal-best weight (normalised to kg). Powers the
 * dashboard PB strip. Heavy machine lifts (leg press etc.) naturally sort
 * to the top — it's an at-a-glance "biggest numbers" view.
 */
export async function getTopPBs(limit = 5) {
  await initDb();
  const res = await db.query(
    `SELECT se.exercise_name AS name,
            MAX(CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) AS pb
     FROM sets s
     JOIN session_exercises se ON s.session_exercise_id = se.id
     JOIN sessions sess ON se.session_id = sess.id
     WHERE s.weight IS NOT NULL
     GROUP BY se.exercise_name
     ORDER BY pb DESC
     LIMIT ?`,
    [limit]
  );
  return (res.values ?? []).map((r) => ({
    name: r.name,
    pb: Math.round(Number(r.pb) * 10) / 10,
  }));
}

/**
 * Bundles the dashboard numbers: total sessions, this-week vs last-week
 * volume (Monday-anchored), and the top 5 PBs. Queries run sequentially
 * to avoid concurrent use of the single SQLite connection.
 */
export async function getDashboardStats() {
  await initDb();
  const now = new Date();
  const ws = weekStartMonday(now);
  const nextWs = new Date(ws); nextWs.setDate(nextWs.getDate() + 7);
  const lastWs = new Date(ws); lastWs.setDate(lastWs.getDate() - 7);

  const totalSessions = await getTotalSessionCount();
  const thisWeekVolume = await getVolumeBetween(toISODate(ws), toISODate(nextWs));
  const lastWeekVolume = await getVolumeBetween(toISODate(lastWs), toISODate(ws));
  const topPBs = await getTopPBs(5);

  return { totalSessions, thisWeekVolume, lastWeekVolume, topPBs };
}

/**
 * Returns true if the user's most recent prior session for this
 * exercise had at least 3 sets all with reps ≥ 12 — a heuristic
 * cue to bump the load next time.
 */
export async function shouldSuggestRaise(exerciseName, currentSessionId) {
  await initDb();
  const seRes = await db.query(
    `SELECT id FROM session_exercises
     WHERE exercise_name = ? AND session_id != ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [exerciseName, currentSessionId]
  );
  const seId = seRes.values?.[0]?.id;
  if (!seId) return false;

  const setRes = await db.query(
    `SELECT reps FROM sets WHERE session_exercise_id = ? ORDER BY position ASC`,
    [seId]
  );
  const reps = (setRes.values ?? []).map(r => Number(r.reps)).filter(n => Number.isFinite(n));
  if (reps.length < 3) return false;
  return reps.every(r => r >= 12);
}

export async function getSessionDetail(sessionId) {
  await initDb();
  const res = await db.query(`SELECT * FROM sessions WHERE id = ?`, [sessionId]);
  return res.values?.[0] ?? null;
}

export async function finishSession(sessionId, log) {
  await initDb(log);
  const now = Date.now();
  await db.run(
    `UPDATE sessions SET status='finished', finished_at=? WHERE id=?`,
    [now, sessionId]
  );

  const activeId = await getActiveSessionId();
  if (String(activeId) === String(sessionId)) {
    await clearActiveSessionId();
  }
  if (typeof log === "function") log(`✅ finishSession OK (id=${sessionId})`);
}

export async function addExerciseToSession(sessionId, exerciseName, notes = null) {
  await initDb();
  const now = Date.now();
  const trimmedName = String(exerciseName).trim();

  // Persist to catalog so freshly-typed exercises show up in future
  // searches (no-op if already present).
  await db.run(
    `INSERT OR IGNORE INTO exercises (name, created_at)
     VALUES (?, ?)`,
    [trimmedName, now]
  );

  // Apply the declarative measurement type (if this name is mapped) so a
  // just-added time/cardio/hold exercise prompts for the right inputs
  // immediately — not just after a full re-seed.
  const mt = MEASUREMENT_TYPES[trimmedName];
  if (mt) {
    await db.run(
      `UPDATE exercises SET measurement_type = ? WHERE name = ?`,
      [mt, trimmedName]
    );
  }

  // Append at the end of this session's list. Ordering is by position
  // (item 1 fix), so a newly-added exercise must take MAX(position)+1
  // rather than the default 0 — otherwise it would jump to the top.
  const posRes = await db.query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS nextPos
     FROM session_exercises WHERE session_id = ?`,
    [sessionId]
  );
  const position = Number(posRes.values?.[0]?.nextPos ?? 0);

  await db.run(
    `INSERT INTO session_exercises (session_id, exercise_name, notes, position, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, trimmedName, notes ? String(notes).trim() : null, position, now]
  );
}

export async function listSessionExercises(sessionId) {
  await initDb();
  const res = await db.query(
    `
    SELECT
      se.*,
      e.measurement_type,
      e.is_unilateral
    FROM session_exercises se
    LEFT JOIN exercises e
      ON e.name = se.exercise_name
    WHERE se.session_id = ?
    ORDER BY se.position ASC, se.created_at ASC, se.id ASC
    `,
    [sessionId]
  );
  return res.values ?? [];
}

// Phase E.1 — delete a single exercise from a session (template cleanup)

export async function deleteSession(sessionId, log) {
  await initDb(log);
  await db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);

  const activeId = await getActiveSessionId();
  if (String(activeId) === String(sessionId)) {
    await clearActiveSessionId();
  }
  if (typeof log === "function") log(`✅ deleteSession OK (id=${sessionId})`);
}
// --------------------------------------------------
// Phase E — Template preload
// --------------------------------------------------
export async function preloadTemplateExercises(sessionId, focus, log) {
  await initDb();

  // Custom saved templates (item 7) come through as focus="custom:<id>".
  let names;
  if (typeof focus === "string" && focus.startsWith("custom:")) {
    const templateId = Number(focus.slice("custom:".length));
    const ex = await getCustomTemplateExercises(templateId);
    names = ex.map(e => e.exercise_name);
  } else {
    const tpl = TEMPLATES[focus];
    if (!tpl) {
      if (typeof log === "function") {
        log(`ℹ️ No template for focus="${focus}"`);
      }
      return;
    }
    // New shape: tpl.exercises = [{ name, ... }, ...]
    // Legacy shape: tpl.anchors + tpl.suggested = [name, ...]
    if (Array.isArray(tpl.exercises)) {
      names = tpl.exercises.map(e => e.name);
    } else {
      names = [...(tpl.anchors || []), ...(tpl.suggested || [])];
    }
  }

  let position = 0;
  for (const name of names) {
    await db.run(
      `INSERT INTO session_exercises
       (session_id, exercise_name, position, created_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, name, position++, Date.now()]
    );
  }

  if (typeof log === "function") {
    log(`✅ Preloaded ${names.length} template exercises for ${focus}`);
  }
}

/* --------------------------------------------------
   Build 1 — declarative migrations & one-time cleanup
   (all idempotent; safe to run on every boot)
-------------------------------------------------- */

/**
 * Applies the declarative MEASUREMENT_TYPES map to the exercises table.
 * Ensures each mapped name exists (INSERT OR IGNORE) then sets its
 * measurement_type. Replaces the old ad-hoc, name-exact hardcoded
 * corrections (e.g. the single "Bike" UPDATE) that missed real logged
 * variants like "Bike warm-up". Runs every boot — cheap and idempotent.
 */
export async function applyMeasurementTypes(log) {
  await initDb(log);
  const now = Date.now();
  const names = Object.keys(MEASUREMENT_TYPES);
  for (const name of names) {
    await db.run(
      `INSERT OR IGNORE INTO exercises (name, created_at) VALUES (?, ?)`,
      [name, now]
    );
    await db.run(
      `UPDATE exercises SET measurement_type = ? WHERE name = ?`,
      [MEASUREMENT_TYPES[name], name]
    );
  }
  if (typeof log === "function") {
    log(`✅ Applied measurement types (${names.length} mapped)`);
  }
}

/**
 * One-time rename: "Seated incline press machine" →
 * "Seated high incline press machine" (item 5). Guarded by an app_state
 * flag so it only runs once. Handles both the canonical exercises row
 * (respecting the UNIQUE(name) constraint if the new name already exists)
 * and every historical session_exercises reference, so old PBs follow.
 */
export async function renameSeatedInclineOnce(log) {
  await initDb(log);
  const FLAG = "rename_seated_high_incline_v1";
  const done = await db.query(`SELECT value FROM app_state WHERE key = ?`, [FLAG]);
  if (done.values?.[0]?.value === "1") return;

  const OLD = "Seated incline press machine";
  const NEW = "Seated high incline press machine";

  // session_exercises references — surface old history under the new name.
  await db.run(
    `UPDATE session_exercises SET exercise_name = ? WHERE exercise_name = ?`,
    [NEW, OLD]
  );

  // Canonical exercises row. If the new name already exists (from the seed
  // CSV), just drop the old duplicate; otherwise rename in place.
  const newExists = await db.query(`SELECT id FROM exercises WHERE name = ?`, [NEW]);
  if (newExists.values?.[0]?.id) {
    await db.run(`DELETE FROM exercises WHERE name = ?`, [OLD]);
  } else {
    await db.run(`UPDATE exercises SET name = ? WHERE name = ?`, [NEW, OLD]);
  }

  await db.run(
    `INSERT OR REPLACE INTO app_state (key, value) VALUES (?, '1')`,
    [FLAG]
  );
  if (typeof log === "function") log(`✅ Renamed "${OLD}" → "${NEW}"`);
}

/**
 * Native-only JSON dump of the four core tables to
 * Documents/GymLogBackups/pre_purge_<stamp>.json. Called before the
 * irreversible orphan cleanup so the pre-migration state is recoverable.
 * On web (no Filesystem) it's a no-op.
 */
export async function backupTablesJson(log) {
  await initDb(log);
  if (!Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) {
    if (typeof log === "function") log("ℹ️ backupTablesJson skipped (web)");
    return null;
  }
  try {
    const dump = {};
    for (const t of ["sessions", "session_exercises", "sets", "exercises"]) {
      const r = await db.query(`SELECT * FROM ${t}`);
      dump[t] = r.values ?? [];
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `GymLogBackups/pre_purge_${stamp}.json`;
    await Filesystem.writeFile({
      path,
      data: JSON.stringify(dump, null, 2),
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    if (typeof log === "function") log(`✅ Backup written: Documents/${path}`);
    return path;
  } catch (e) {
    if (typeof log === "function") log("⚠️ backupTablesJson failed:", String(e));
    return null;
  }
}

/**
 * One-time purge of orphaned session_exercises and sets — rows left behind
 * by pre-FK-enforcement session deletes (root of the ghost-PB bug, item 2).
 * Takes a JSON backup first, then deletes children with no live parent.
 * Guarded by an app_state flag so it runs exactly once.
 */
export async function cleanupOrphansOnce(log) {
  await initDb(log);
  const FLAG = "cleanup_orphans_v1";
  const done = await db.query(`SELECT value FROM app_state WHERE key = ?`, [FLAG]);
  if (done.values?.[0]?.value === "1") return;

  // Count first so we can log/skip the backup when there's nothing to do.
  const seOrphans = await db.query(
    `SELECT COUNT(*) AS c FROM session_exercises
     WHERE session_id NOT IN (SELECT id FROM sessions)`
  );
  const setOrphans = await db.query(
    `SELECT COUNT(*) AS c FROM sets
     WHERE session_exercise_id NOT IN (SELECT id FROM session_exercises)`
  );
  const seCount = Number(seOrphans.values?.[0]?.c ?? 0);
  const setCount = Number(setOrphans.values?.[0]?.c ?? 0);

  if (seCount > 0 || setCount > 0) {
    await backupTablesJson(log);
    // Delete orphaned sets first (some point at the session_exercises we're
    // about to delete; deleting sets last would re-orphan them).
    await db.run(
      `DELETE FROM sets
       WHERE session_exercise_id NOT IN (SELECT id FROM session_exercises)`
    );
    await db.run(
      `DELETE FROM session_exercises
       WHERE session_id NOT IN (SELECT id FROM sessions)`
    );
    // The now-childless session_exercises we just removed may have left
    // their own sets orphaned — sweep once more.
    await db.run(
      `DELETE FROM sets
       WHERE session_exercise_id NOT IN (SELECT id FROM session_exercises)`
    );
    if (typeof log === "function") {
      log(`✅ Purged orphans: ${seCount} session_exercises, ${setCount}+ sets`);
    }
  } else if (typeof log === "function") {
    log("ℹ️ No orphaned rows to purge");
  }

  await db.run(
    `INSERT OR REPLACE INTO app_state (key, value) VALUES (?, '1')`,
    [FLAG]
  );
}

/* --------------------------------------------------
   Build 2 — custom session templates (item 7)
-------------------------------------------------- */

/**
 * Creates a named custom template from an ordered list of exercise names.
 * Each name is also ensured in the canonical exercises catalog so it picks
 * up measurement_type / is_unilateral like any other exercise. Returns the
 * new template id.
 */
export async function createCustomTemplate(name, exerciseNames = [], log) {
  await initDb(log);
  const now = Date.now();
  const cleanName = String(name || "").trim() || "Custom session";

  const res = await db.run(
    `INSERT INTO custom_templates (name, created_at) VALUES (?, ?)`,
    [cleanName, now]
  );
  let templateId = res?.changes?.lastId;
  if (!templateId) {
    const q = await db.query(`SELECT last_insert_rowid() AS id`);
    templateId = q?.values?.[0]?.id;
  }

  let position = 0;
  for (const raw of exerciseNames) {
    const exName = String(raw || "").trim();
    if (!exName) continue;
    await db.run(
      `INSERT OR IGNORE INTO exercises (name, created_at) VALUES (?, ?)`,
      [exName, now]
    );
    await db.run(
      `INSERT INTO custom_template_exercises (template_id, exercise_name, position)
       VALUES (?, ?, ?)`,
      [templateId, exName, position++]
    );
  }

  if (typeof log === "function") {
    log(`✅ Saved custom template "${cleanName}" (${position} exercises)`);
  }
  return templateId;
}

export async function listCustomTemplates() {
  await initDb();
  const res = await db.query(
    `SELECT ct.id, ct.name, ct.created_at,
            COUNT(cte.id) AS exercise_count
     FROM custom_templates ct
     LEFT JOIN custom_template_exercises cte ON cte.template_id = ct.id
     GROUP BY ct.id
     ORDER BY ct.created_at DESC`
  );
  return res.values ?? [];
}

export async function getCustomTemplate(templateId) {
  await initDb();
  const res = await db.query(
    `SELECT id, name, created_at FROM custom_templates WHERE id = ?`,
    [templateId]
  );
  return res.values?.[0] ?? null;
}

export async function getCustomTemplateExercises(templateId) {
  await initDb();
  const res = await db.query(
    `SELECT id, template_id, exercise_name, position
     FROM custom_template_exercises
     WHERE template_id = ?
     ORDER BY position ASC, id ASC`,
    [templateId]
  );
  return res.values ?? [];
}

export async function deleteCustomTemplate(templateId, log) {
  await initDb(log);
  await db.run(`DELETE FROM custom_templates WHERE id = ?`, [templateId]);
  if (typeof log === "function") log(`✅ Deleted custom template id=${templateId}`);
}
