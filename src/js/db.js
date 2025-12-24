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
        created_at INTEGER NOT NULL
      );
    `);
// -----------------------------
// Session exercises (Phase B-1)
// -----------------------------
await db.execute(`
  CREATE TABLE IF NOT EXISTS session_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    exercise_name TEXT NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
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
    `SELECT * FROM session_exercises
     WHERE session_id = ?
     ORDER BY created_at DESC`,
    [sessionId]
  );
  return res.values ?? [];
}

export async function deleteSession(sessionId, log) {
  await initDb(log);
  await db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);

  const activeId = await getActiveSessionId();
  if (String(activeId) === String(sessionId)) {
    await clearActiveSessionId();
  }
  if (typeof log === "function") log(`✅ deleteSession OK (id=${sessionId})`);
}
