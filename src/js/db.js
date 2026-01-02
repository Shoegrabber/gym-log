import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";

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
    } catch (_) {}

    const conn = await sqlite.createConnection(
      DB_NAME,
      false,            // encrypted
      "no-encryption",  // mode
      DB_VERSION
    );

    if (!conn) throw new Error("createConnection returned null/undefined");

    await conn.open();
    db = conn;

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

// Phase G — semantic correction: Bike is time-based
try {
  await db.run(
    `UPDATE exercises
     SET measurement_type = 'time_only'
     WHERE name = 'Bike'
       AND (measurement_type IS NULL OR measurement_type = 'weight_reps');`
  );
  if (typeof log === "function") log("✅ Phase G: ensured Bike is time_only");
} catch (e) {
  const msg = String(e || "").toLowerCase();
  if (typeof log === "function") log("⚠️ Phase G warning (Bike semantics):", msg);
}

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

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_sets_session_exercise_id
      ON sets(session_exercise_id);
    `);

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

async function hasSeededExercises() {
  const res = await db.query(
    `SELECT value FROM app_state WHERE key='seed_exercises_v1'`
  );
  return res.values?.[0]?.value === "1";
}

async function setSeededExercises() {
  await db.run(
    `INSERT OR REPLACE INTO app_state (key, value)
     VALUES ('seed_exercises_v1', '1')`
  );
}

export async function seedExercisesFromCsv(log) {
  await initDb(log);

  if (await hasSeededExercises()) {
    if (typeof log === "function") log("ℹ️ exercises seed already applied");
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
  const conn = await initDb(() => {});
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
      notes,
      created_at
     FROM sets
     WHERE session_exercise_id = ?
     ORDER BY position ASC, id ASC;`,
    [sessionExerciseId]
  );
  return res.values ?? [];
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
        notes,
        created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [sessionExerciseId, position, w, wu, r, dsec, dm, a, n, now]
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
    notes: n,
    created_at: now
  };
}

export async function deleteSet(setId) {
  await initDb();
  await db.run(`DELETE FROM sets WHERE id = ?;`, [setId]);
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
  await db.run(
    `INSERT INTO session_exercises (session_id, exercise_name, notes, created_at)
     VALUES (?, ?, ?, ?)`,
    [sessionId, String(exerciseName).trim(), notes ? String(notes).trim() : null, now]
  );
}

export async function listSessionExercises(sessionId) {
  await initDb();
  const res = await db.query(
    `
    SELECT
      se.*,
      e.measurement_type
    FROM session_exercises se
    LEFT JOIN exercises e
      ON e.name = se.exercise_name
    WHERE se.session_id = ?
    ORDER BY se.created_at DESC
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
import { TEMPLATES } from "./templates.js";

export async function preloadTemplateExercises(sessionId, focus, log) {
  await initDb();

  const tpl = TEMPLATES[focus];
  if (!tpl) {
    if (typeof log === "function") {
      log(`ℹ️ No template for focus="${focus}"`);
    }
    return;
  }

  let position = 0;

  const all = [
    ...(tpl.anchors || []),
    ...(tpl.suggested || []),
  ];

  for (const name of all) {
    await db.run(
      `INSERT INTO session_exercises
       (session_id, exercise_name, position, created_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, name, position++, Date.now()]
    );
  }

  if (typeof log === "function") {
    log(`✅ Preloaded ${all.length} template exercises for ${focus}`);
  }
}
