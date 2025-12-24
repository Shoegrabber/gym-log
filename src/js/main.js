import { SplashScreen } from "@capacitor/splash-screen";
import {
  initDb,
  createSession,
  listSessions,
  getSessionDetail,
  getActiveSessionId,
  setActiveSessionId,
  clearActiveSessionId,
  finishSession,
  deleteSession,
  seedExercisesFromCsv,
  listExercises,
} from "./db.js";

const logEl = document.getElementById("log");

function logLine(...args) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(msg);
  if (logEl) logEl.textContent += `\n${msg}`;
}

window.onerror = (message, source, lineno, colno, error) => {
  logLine("❌ window.onerror:", String(message));
  if (error?.stack) logLine(error.stack);
};

window.onunhandledrejection = (event) => {
  logLine("❌ unhandledrejection:", String(event.reason));
  if (event.reason?.stack) logLine(event.reason.stack);
};

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function setSelectedSessionUI(session) {
  const selectedEl = document.getElementById("selected-session");
  const finishBtn = document.getElementById("btn-finish-session");
  const exerciseControls = document.getElementById("exercise-controls");
  const exercisesEl = document.getElementById("exercises");

  if (!selectedEl) return;

  if (!session) {
    selectedEl.textContent = "No session selected.";
    if (finishBtn) finishBtn.style.display = "none";
    if (exerciseControls) exerciseControls.style.display = "none";
    if (exercisesEl) exercisesEl.innerHTML = "";
    return;
  }

  selectedEl.innerHTML = `
    <div><strong>${session.focus.toUpperCase()}</strong> — ${session.date}</div>
    <div class="muted">Status: ${session.status}</div>
    ${session.notes ? `<div class="muted">Notes: ${session.notes}</div>` : ""}
  `;

  if (finishBtn) finishBtn.style.display = session.status === "active" ? "inline-block" : "none";
  if (exerciseControls) exerciseControls.style.display = "block";

  // Phase A only: no exercises UI yet
  if (exercisesEl) {
    exercisesEl.innerHTML = `<div class="muted">Phase A only: exercises UI will come back after session lifecycle is stable.</div>`;
  }
}

async function refreshSessionsList() {
  const sessionsEl = document.getElementById("sessions");
  if (!sessionsEl) return;

  const sessions = await listSessions(20);
  sessionsEl.innerHTML = "";

  for (const s of sessions) {
    const div = document.createElement("div");
    div.className = "card";

    const badge = s.status === "active" ? "active" : "finished";
    div.innerHTML = `
      <div>
        <strong>${s.focus.toUpperCase()}</strong> — ${s.date}
        <span class="badge ${badge}">${s.status}</span>
      </div>
      ${s.notes ? `<div class="muted">${s.notes}</div>` : ""}
      <div style="margin-top:10px;" class="row">
        <button class="linkbtn tiny" data-open="${s.id}">Open</button>
        <button class="danger tiny" data-delete="${s.id}">Delete</button>
      </div>
    `;

    sessionsEl.appendChild(div);

    div.querySelector(`[data-open="${s.id}"]`).addEventListener("click", async () => {
      await setActiveSessionId(s.id);
      const detail = await getSessionDetail(s.id);
      setSelectedSessionUI(detail);
      logLine(`✅ Opened session id=${s.id}`);
    });

    div.querySelector(`[data-delete="${s.id}"]`).addEventListener("click", async () => {
      await deleteSession(s.id, logLine);
      logLine(`🗑️ Deleted session id=${s.id}`);
      const activeId = await getActiveSessionId();
      if (String(activeId) === String(s.id)) {
        await clearActiveSessionId();
        setSelectedSessionUI(null);
      }
      await refreshSessionsList();
    });
  }

  logLine(`✅ Refreshed sessions (${sessions.length})`);
}

async function safeStart() {
  try {
    logLine("✅ JS loaded (Phase A: session lifecycle)");
    await initDb(logLine);

try {
  await seedExercisesFromCsv(logLine);
  const ex = await listExercises(5);
  logLine("✅ Sample exercises:", ex.map(x => x.name));
} catch (e) {
  logLine("⚠️ Exercise seed/list failed (non-fatal):", String(e));
}

    // Default date
    const dateInput = document.getElementById("session-date");
    if (dateInput && !dateInput.value) dateInput.value = todayISO();

    // Wire buttons (MATCHES YOUR index.html IDs)
    const createBtn = document.getElementById("btn-create-session");
    const finishBtn = document.getElementById("btn-finish-session");
    const refreshBtn = document.getElementById("btn-refresh-sessions");

    if (!createBtn) logLine("❌ Missing #btn-create-session in DOM");
    if (!finishBtn) logLine("❌ Missing #btn-finish-session in DOM");
    if (!refreshBtn) logLine("❌ Missing #btn-refresh-sessions in DOM");

createBtn?.addEventListener("click", async () => {
  try {
    const date = document.getElementById("session-date")?.value || todayISO();
    const focus = document.getElementById("session-focus")?.value || "other";
    const notes = document.getElementById("session-notes")?.value || "";

    logLine("🟦 Create clicked:", { date, focus, notes });

    const id = await createSession({ date, focus, notes });
    const detail = await getSessionDetail(id);

    setSelectedSessionUI(detail);
    await refreshSessionsList();
  } catch (e) {
    logLine("❌ Create session failed:", String(e));
    if (e?.stack) logLine(e.stack);
  }
});

    finishBtn?.addEventListener("click", async () => {
      try {
        const activeId = await getActiveSessionId();
        if (!activeId) {
          logLine("⚠️ No active session to finish.");
          return;
        }
        await finishSession(activeId, logLine);
        const detail = await getSessionDetail(activeId);
        setSelectedSessionUI(detail);
        await refreshSessionsList();
      } catch (e) {
        logLine("❌ Finish session failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    });

    refreshBtn?.addEventListener("click", async () => {
      try {
        await refreshSessionsList();
      } catch (e) {
        logLine("❌ Refresh list failed:", String(e));
      }
    });

    // Load active session (if any)
    const activeId = await getActiveSessionId();
    if (activeId) {
      const detail = await getSessionDetail(activeId);
      setSelectedSessionUI(detail);
      logLine(`✅ Loaded active session id=${activeId}`);
    } else {
      setSelectedSessionUI(null);
      logLine("ℹ️ No active session set.");
    }

    await refreshSessionsList();

    try {
      await SplashScreen.hide();
      logLine("✅ SplashScreen.hide()");
    } catch (e) {
      logLine("⚠️ SplashScreen.hide failed:", String(e));
    }

    logLine("✅ Ready.");
  } catch (e) {
    logLine("❌ safeStart crashed:", String(e));
    if (e?.stack) logLine(e.stack);
  }
}

safeStart();
