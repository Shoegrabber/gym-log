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
addExerciseToSession,
listSessionExercises,
listSets,
insertSet,
deleteSet
} from "./db.js";

let selectedSessionId = null;

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
  // Only mark active if the session is actually active
  if (s.status === "active") {
    await setActiveSessionId(s.id);
  }

  selectedSessionId = s.id;
  const detail = await getSessionDetail(s.id);
  setSelectedSessionUI(detail);

  await renderSelectedSessionExercises(s.id);

  logLine(`✅ Opened session id=${s.id}`);
});

    div.querySelector(`[data-delete="${s.id}"]`).addEventListener("click", async () => {
      await deleteSession(s.id, logLine);
      logLine(`🗑️ Deleted session id=${s.id}`);
      const activeId = await getActiveSessionId();
      if (String(activeId) === String(s.id)) {
        await clearActiveSessionId();
selectedSessionId = null; 
        setSelectedSessionUI(null);
      }
      await refreshSessionsList();
    });
  }

  logLine(`✅ Refreshed sessions (${sessions.length})`);
}

async function renderSelectedSessionExercises(sessionId) {
  const container = document.getElementById("exercises");
  if (!container) return;

  if (!sessionId) {
    container.innerHTML = "";
    return;
  }

  const rows = await listSessionExercises(sessionId);

  if (!rows.length) {
    container.innerHTML = `<div style="color:#777;">No exercises added yet.</div>`;
    return;
  }

  // Load sets for each session_exercise (MVP: N+1 queries, fine)
  const rowsWithSets = [];
  for (const r of rows) {
    const sets = await listSets(r.id);
    rowsWithSets.push({ ...r, sets });
  }

  container.innerHTML = rowsWithSets
    .map(r => {
      const note = r.notes ? ` <span style="color:#777;">— ${r.notes}</span>` : "";

      const setsHtml = (r.sets || []).length
        ? `<div style="margin-top:6px; display:flex; flex-direction:column; gap:6px;">
            ${(r.sets || [])
              .map(s => {
                const w = (s.weight === null || s.weight === undefined) ? "" : String(s.weight);
                const reps = (s.reps === null || s.reps === undefined) ? "" : String(s.reps);

                let label = `#${s.position}`;
                if (w !== "" && reps !== "") label += ` — ${w}kg × ${reps}`;
                else if (w !== "") label += ` — ${w}kg`;
                else if (reps !== "") label += ` — ${reps} reps`;

                return `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                  <div style="color:#333;">${label}</div>
                  <button data-action="delete-set" data-setid="${s.id}" style="border:1px solid #ddd; background:#fff; padding:4px 8px; border-radius:8px;">🗑</button>
                </div>`;
              })
              .join("")}
          </div>`
        : `<div style="margin-top:6px; color:#777;">No sets yet.</div>`;

      const addRow = `
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
          <input data-weight-for="${r.id}" inputmode="decimal" placeholder="kg" style="width:70px; padding:8px; border:1px solid #ddd; border-radius:10px;" />
          <input data-reps-for="${r.id}" inputmode="numeric" placeholder="reps" style="width:70px; padding:8px; border:1px solid #ddd; border-radius:10px;" />
          <button data-action="add-set" data-seid="${r.id}" style="padding:8px 12px; border-radius:10px; border:1px solid #ddd; background:#fff;">+ Set</button>
        </div>
      `;

      return `<div style="padding:10px 0; border-bottom:1px solid #eee;">
        <div><strong>${r.exercise_name}</strong>${note}</div>
        ${setsHtml}
        ${addRow}
      </div>`;
    })
    .join("");

  // Event delegation (overwrite per render; simple + reliable)
  container.onclick = async (ev) => {
    const btn = ev.target?.closest?.("button[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    if (action === "add-set") {
      const sessionExerciseId = Number(btn.getAttribute("data-seid"));
      const wEl = container.querySelector(`input[data-weight-for="${sessionExerciseId}"]`);
      const rEl = container.querySelector(`input[data-reps-for="${sessionExerciseId}"]`);

      const weightRaw = (wEl?.value ?? "").trim();
      const repsRaw = (rEl?.value ?? "").trim();

      await insertSet({
        sessionExerciseId,
        weight: weightRaw === "" ? null : weightRaw,
        reps: repsRaw === "" ? null : repsRaw,
        notes: null
      });

      if (wEl) wEl.value = "";
      if (rEl) rEl.value = "";

      await renderSelectedSessionExercises(sessionId);
      return;
    }

    if (action === "delete-set") {
      const setId = Number(btn.getAttribute("data-setid"));
      await deleteSet(setId);
      await renderSelectedSessionExercises(sessionId);
      return;
    }
  };
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
selectedSessionId = id;
    const detail = await getSessionDetail(id);

    setSelectedSessionUI(detail);
await renderSelectedSessionExercises(selectedSessionId);
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
selectedSessionId = null;
await renderSelectedSessionExercises(null);       
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
selectedSessionId = activeId;
      const detail = await getSessionDetail(activeId);
      setSelectedSessionUI(detail);
await renderSelectedSessionExercises(selectedSessionId);
      logLine(`✅ Loaded active session id=${activeId}`);
    } else {
selectedSessionId = null;
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
// -----------------------------
// Exercise picker (tap-to-fill)
// -----------------------------
try {
  const exerciseInput = document.getElementById("exercise-name");
const searchInput = document.getElementById("exercise-picker-search");
const listDiv = document.getElementById("exercise-picker-list");

  if (!exerciseInput || !searchInput || !listDiv) {
    logLine("⚠️ Exercise picker elements not found; skipping picker UI");
  } else {
    const allExercises = await listExercises(1000);

    const render = (qRaw = "") => {
      const q = String(qRaw).trim().toLowerCase();
      const filtered = q
        ? allExercises.filter(e => e.name.toLowerCase().includes(q))
        : allExercises;

      // keep rendering lightweight
      const show = filtered.slice(0, 120);

      listDiv.innerHTML = show
        .map(e => `
          <button type="button"
            data-name="${e.name.replace(/"/g, "&quot;")}"
            style="display:block;width:100%;text-align:left;padding:10px;border:0;border-bottom:1px solid #eee;background:white;cursor:pointer;">
            ${e.name}
          </button>
        `)
        .join("");

      // click-to-fill
      listDiv.querySelectorAll("button[data-name]").forEach(btn => {
        btn.addEventListener("click", () => {
          const name = btn.getAttribute("data-name");
          exerciseInput.value = name;
          logLine("🟦 picked exercise:", name);
        });
      });
    };

    searchInput.addEventListener("input", () => render(searchInput.value));
    render("");
    logLine(`✅ Exercise picker ready (${allExercises.length} exercises)`);
  }
} catch (e) {
  logLine("⚠️ Exercise picker failed (non-fatal):", String(e));
}

// ---------------------------
// Add exercise to session (Phase B-5)
// ---------------------------
const addBtn = document.getElementById("btn-add-exercise");
const exerciseNameInput = document.getElementById("exercise-name");
const exerciseNotesInput = document.getElementById("exercise-notes");

addBtn?.addEventListener("click", async () => {
  if (!selectedSessionId) {
    logLine("⚠️ No active session");
    return;
  }

const name = exerciseNameInput.value.trim();
  if (!name) return;

  await addExerciseToSession(
    selectedSessionId,
    name,
    exerciseNotesInput?.value || null
  );

await renderSelectedSessionExercises(selectedSessionId);

exerciseNameInput.value = "";
if (exerciseNotesInput) exerciseNotesInput.value = "";

  await window.renderSessionExercises?.();
  logLine("🟦 Exercise added:", name);
});
  } catch (e) {
    logLine("❌ safeStart crashed:", String(e));
    if (e?.stack) logLine(e.stack);
  }
}

safeStart();
