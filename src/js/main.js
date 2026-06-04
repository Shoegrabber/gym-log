import { SplashScreen } from "@capacitor/splash-screen";
import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite } from "@capacitor-community/sqlite";
import { defineCustomElements as jeepSqliteDefineCustomElements } from "jeep-sqlite/loader";
import { exportAll } from "./export.js";
import {
  initDb,
  createSession,
  listSessions,
  getSessionDetail,
  preloadTemplateExercises,
  getActiveSessionId,
  setActiveSessionId,
  clearActiveSessionId,
  finishSession,
  deleteSession,
  seedExercisesFromCsv,
  listExercises,
  addExerciseToSession,
  listSessionExercises,
  deleteSessionExercise,
  listSets,
  insertSet,
  deleteSet,
  updateSet,
  setExerciseMeasurementType,
  getLatestSetForExercise,
  getPersonalBest,
  getSessionVolume,
  shouldSuggestRaise,
  getLastSessionSetsForExercise,
  getTopSetsForExercise,
  listOrphanExerciseNames,
  mergeExerciseName,
  getDashboardStats
} from "./db.js";
import { WEIGHT_INPUT_HINTS } from "./templates.js";

let selectedSessionId = null;
// Tracks the session_exercise the user most recently logged a set on,
// so we can float it to the top of the list (keeps the active exercise
// next to the rest timer). Reset when leaving a session.
let lastActiveSessionExerciseId = null;

const logEl = document.getElementById("log");

// Timer State (wall-clock based — survives app backgrounding)
const REST_TIMER_DEFAULT_SEC = 90;
let timerEndAt = null;        // Date.now() target ms; null = no timer
let timerTickInterval = null; // periodic render handle

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

/* --------------------------------------------------
   Rest Timer (wall-clock based)
   Tracks an absolute end timestamp so backgrounding
   the app does not pause the countdown — when the
   user returns, the elapsed real time is reflected.
-------------------------------------------------- */
function startRestTimer(seconds = REST_TIMER_DEFAULT_SEC) {
  const container = document.getElementById("rest-timer-container");
  if (!container) return;

  if (timerTickInterval) clearInterval(timerTickInterval);

  timerEndAt = Date.now() + seconds * 1000;
  container.style.display = "block";

  renderRestTimer();
  // 250ms tick: cheap, smooth, makes +15s feel snappy
  timerTickInterval = setInterval(renderRestTimer, 250);
}

function renderRestTimer() {
  const display = document.getElementById("rest-timer-display");
  if (!display || timerEndAt == null) return;

  const remainingMs = timerEndAt - Date.now();

  if (remainingMs <= 0) {
    display.textContent = "00:00";
    stopRestTimer();
    return;
  }

  const remainingSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(remainingSec / 60);
  const ss = String(remainingSec % 60).padStart(2, "0");
  display.textContent = `${String(mm).padStart(2, "0")}:${ss}`;
}

function stopRestTimer() {
  if (timerTickInterval) {
    clearInterval(timerTickInterval);
    timerTickInterval = null;
  }
  timerEndAt = null;
  const container = document.getElementById("rest-timer-container");
  if (container) container.style.display = "none";
}

function addRestTime(seconds) {
  if (timerEndAt == null) return;
  timerEndAt += seconds * 1000;
  renderRestTimer();
}

// Re-render immediately when the app returns to the foreground so the
// displayed time reflects real elapsed time, not the last paused frame.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderRestTimer();
});

/* --------------------------------------------------
   Standalone stopwatch (Timer tab)
   Wall-clock based: accumulates elapsed ms and tracks
   the current run's start timestamp, so backgrounding
   the app never loses time.
-------------------------------------------------- */
let swRunning = false;
let swStartAt = null;   // Date.now() when current run began
let swAccumMs = 0;      // elapsed ms banked from previous runs
let swTickInterval = null;

function swElapsedMs() {
  return swAccumMs + (swRunning && swStartAt != null ? Date.now() - swStartAt : 0);
}

function renderStopwatch() {
  const display = document.getElementById("stopwatch-display");
  if (!display) return;
  const ms = swElapsedMs();
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const tenths = Math.floor((ms % 1000) / 100);
  display.textContent = `${mm}:${ss}.${tenths}`;
}

function toggleStopwatch() {
  const btn = document.getElementById("btn-sw-start");
  if (swRunning) {
    // Pause
    swAccumMs += Date.now() - swStartAt;
    swStartAt = null;
    swRunning = false;
    if (swTickInterval) { clearInterval(swTickInterval); swTickInterval = null; }
    if (btn) btn.textContent = "Start";
  } else {
    // Start / resume
    swStartAt = Date.now();
    swRunning = true;
    if (swTickInterval) clearInterval(swTickInterval);
    swTickInterval = setInterval(renderStopwatch, 100);
    if (btn) btn.textContent = "Pause";
  }
  renderStopwatch();
}

function resetStopwatch() {
  swRunning = false;
  swStartAt = null;
  swAccumMs = 0;
  if (swTickInterval) { clearInterval(swTickInterval); swTickInterval = null; }
  const btn = document.getElementById("btn-sw-start");
  if (btn) btn.textContent = "Start";
  renderStopwatch();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && swRunning) renderStopwatch();
});

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* --------------------------------------------------
   View router + Session-tab inner state
   The app is a 4-tab single page (Session / History /
   Library / Timer). Switching tabs only show/hides
   divs — it never touches the DB, so navigating away
   from an active session simply *suspends* it.
-------------------------------------------------- */
const VIEWS = ["session", "history", "library", "timer"];

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === name ? "block" : "none";
  }
  document.querySelectorAll("#bottom-nav [data-nav]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-nav") === name);
  });
}

// Session tab has two inner states: idle (create + dashboard) and
// active (a session being worked). Suspend = flip to idle without
// ending the session.
function showSessionState(state) {
  const idle = document.getElementById("session-idle");
  const active = document.getElementById("session-active");
  if (idle) idle.style.display = state === "idle" ? "block" : "none";
  if (active) active.style.display = state === "active" ? "block" : "none";
}

// Live-session dot on the Session nav icon.
async function updateLiveDot() {
  const dot = document.querySelector('#bottom-nav [data-nav="session"] .live-dot');
  if (!dot) return;
  const activeId = await getActiveSessionId();
  dot.style.display = activeId ? "block" : "none";
}

// Render the idle view's resume banner: if a session is active in the
// DB, offer a one-tap way back into it.
async function renderSessionIdle() {
  const banner = document.getElementById("resume-banner");
  if (banner) {
    const activeId = await getActiveSessionId();
    if (!activeId) {
      banner.style.display = "none";
      banner.innerHTML = "";
    } else {
      const d = await getSessionDetail(activeId);
      banner.innerHTML = `<button id="btn-resume">▶ Resume ${d.focus.toUpperCase()} — ${d.date}</button>`;
      banner.style.display = "block";
      document.getElementById("btn-resume")?.addEventListener("click", async () => {
        selectedSessionId = activeId;
        setSelectedSessionUI(d);
        await renderSelectedSessionExercises(activeId);
        showView("session");
      });
    }
  }
  await renderMiniDashboard();
}

// Mini dashboard on the Session idle screen: total sessions, this-week
// vs last-week volume, and the top 5 PBs.
async function renderMiniDashboard() {
  const el = document.getElementById("mini-dashboard");
  if (!el) return;
  let stats;
  try {
    stats = await getDashboardStats();
  } catch (e) {
    logLine("⚠️ dashboard stats failed:", String(e));
    el.innerHTML = "";
    return;
  }

  const { totalSessions, thisWeekVolume, lastWeekVolume, topPBs } = stats;

  // Week-over-week delta arrow.
  let delta = `<span class="dash-delta flat">–</span>`;
  if (lastWeekVolume > 0) {
    const pct = Math.round(((thisWeekVolume - lastWeekVolume) / lastWeekVolume) * 100);
    if (pct > 0) delta = `<span class="dash-delta up">▲ ${pct}%</span>`;
    else if (pct < 0) delta = `<span class="dash-delta down">▼ ${Math.abs(pct)}%</span>`;
  } else if (thisWeekVolume > 0) {
    delta = `<span class="dash-delta up">▲ new</span>`;
  }

  const pbsHtml = (topPBs || []).length
    ? topPBs
        .map(
          (p) =>
            `<div class="pb-row"><span>${p.name}</span><span class="badge pb-badge">${p.pb}kg</span></div>`
        )
        .join("")
    : `<div class="muted">No PBs logged yet.</div>`;

  el.innerHTML = `
    <div class="section">
      <h2>Dashboard</h2>
      <div class="dash-grid">
        <div class="stat">
          <div class="stat-num">${totalSessions}</div>
          <div class="stat-label">sessions</div>
        </div>
        <div class="stat">
          <div class="stat-num">${thisWeekVolume.toLocaleString()}<span class="stat-unit">kg</span></div>
          <div class="stat-label">this week ${delta}</div>
        </div>
      </div>
      <div class="dash-pbs">
        <div class="muted" style="margin-bottom:4px;">Top PBs</div>
        ${pbsHtml}
      </div>
    </div>
  `;
}

function setSelectedSessionUI(session) {
  const selectedEl = document.getElementById("selected-session");
  const finishBtn = document.getElementById("btn-finish-session");
  const exerciseControls = document.getElementById("exercise-controls");
  const exercisesEl = document.getElementById("exercises");

  if (!selectedEl) return;

  if (!session) {
    showSessionState("idle");
    selectedEl.textContent = "No session selected.";
    if (finishBtn) finishBtn.style.display = "none";
    if (exerciseControls) exerciseControls.style.display = "none";
    if (exercisesEl) exercisesEl.innerHTML = "";
    return;
  }

  showSessionState("active");

  selectedEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div style="font-family: 'Montserrat', sans-serif; font-size: 20px; font-weight: 700;">${session.focus.toUpperCase()}</div>
      <div class="badge ${session.status === 'active' ? 'active' : 'finished'}">${session.status}</div>
    </div>
    <div class="muted" style="margin-top: 4px;">${session.date}</div>
    ${session.notes ? `<div class="muted">Notes: ${session.notes}</div>` : ""}
  `;

  if (finishBtn) finishBtn.style.display = session.status === "active" ? "inline-block" : "none";
  if (exerciseControls) exerciseControls.style.display = "block";
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
      <div class="row" style="margin-top: 8px;">
        <button class="linkbtn tiny" data-open="${s.id}">Open</button>
        <button class="danger tiny" data-delete="${s.id}">Delete</button>
      </div>
    `;

    sessionsEl.appendChild(div);

    div.querySelector(`[data-open="${s.id}"]`).addEventListener("click", () => openHistorySession(s));

    div.querySelector(`[data-delete="${s.id}"]`).addEventListener("click", async () => {
      await deleteSession(s.id, logLine);
      logLine(`🗑️ Deleted session id=${s.id}`);
      const activeId = await getActiveSessionId();
      if (String(activeId) === String(s.id)) {
        await clearActiveSessionId();
        selectedSessionId = null;
        setSelectedSessionUI(null);
      }
      await updateLiveDot();
      await refreshSessionsList();
    });
  }

  logLine(`✅ Refreshed sessions (${sessions.length})`);
}

// Open a session from the History list.
//  - Active session  → resume it on the Session tab (full editing UI)
//  - Finished session → read-only detail view inside the History tab
async function openHistorySession(s) {
  const detail = await getSessionDetail(s.id);

  if (s.status === "active") {
    await setActiveSessionId(s.id);
    selectedSessionId = s.id;
    lastActiveSessionExerciseId = null;
    setSelectedSessionUI(detail);
    await renderSelectedSessionExercises(s.id);
    await updateLiveDot();
    showView("session");
    logLine(`✅ Resumed active session id=${s.id}`);
    return;
  }

  // Finished — render into the History detail pane.
  const header = document.getElementById("history-session-header");
  if (header) {
    header.innerHTML = `
      <div style="font-family:'Montserrat',sans-serif; font-size:20px; font-weight:700;">${detail.focus.toUpperCase()}</div>
      <div class="muted" style="margin-top:4px;">${detail.date}</div>
      ${detail.notes ? `<div class="muted">Notes: ${detail.notes}</div>` : ""}
    `;
  }
  document.getElementById("history-list").style.display = "none";
  document.getElementById("history-detail").style.display = "block";
  await renderSelectedSessionExercises(s.id, document.getElementById("history-exercises"));
  logLine(`✅ Opened finished session id=${s.id} in history detail`);
}

async function renderSelectedSessionExercises(sessionId, container = document.getElementById("exercises")) {
  if (!container) return;

  if (!sessionId) {
    container.innerHTML = "";
    return;
  }

  const rows = await listSessionExercises(sessionId);

  if (!rows.length) {
    container.innerHTML = `<div class="muted">No exercises added yet.</div>`;
    return;
  }

  // Load sets, PB, last-ever set, raise-suggestion flag, and the previous
  // session's set list per exercise. lastSet pre-fills next-set inputs;
  // suggestRaise hints when last session hit ≥12 reps on every set;
  // lastSessionSets feeds the PB drill-down expand.
  const rowsDetailed = [];
  for (const r of rows) {
    const sets = await listSets(r.id);
    const pb = await getPersonalBest(r.exercise_name);
    const lastSet = await getLatestSetForExercise(r.exercise_name);
    const suggestRaise = await shouldSuggestRaise(r.exercise_name, sessionId);
    const lastSessionSets = await getLastSessionSetsForExercise(r.exercise_name, sessionId);
    const topSets = await getTopSetsForExercise(r.exercise_name, sessionId, 5);
    rowsDetailed.push({ ...r, sets, pb, lastSet, suggestRaise, lastSessionSets, topSets });
  }

  // Float the last-active exercise to the top so it stays visible next
  // to the rest timer while the user is mid-rest.
  if (lastActiveSessionExerciseId != null) {
    const idx = rowsDetailed.findIndex(r => r.id === lastActiveSessionExerciseId);
    if (idx > 0) {
      const [active] = rowsDetailed.splice(idx, 1);
      rowsDetailed.unshift(active);
    }
  }

  const volume = await getSessionVolume(sessionId);
  const volumeHtml = volume > 0
    ? `<div class="session-volume" style="margin-top:14px; padding:10px; text-align:center; opacity:0.75; font-size:13px;">Total volume: ${volume.toLocaleString()} kg</div>`
    : "";

  container.innerHTML = rowsDetailed
    .map(r => {
      const note = r.notes ? ` <span class="muted">— ${r.notes}</span>` : "";

      const setsHtml = (r.sets || []).length
        ? `<div class="sets-container" style="margin-top: 8px;">
            ${(r.sets || [])
          .map(s => {
            const w = (s.weight === null || s.weight === undefined) ? "" : String(s.weight);
            const reps = (s.reps === null || s.reps === undefined) ? "" : String(s.reps);
            const duration = (s.duration_sec === null || s.duration_sec === undefined)
              ? ""
              : Number(s.duration_sec);
            const unit = s.weight_unit === "lbs" ? "lbs" : "kg";

            let label = `#${s.position}`;
            if (s.side) label += ` ${s.side}`;

            if (r.measurement_type === "time_only") {
              if (duration !== "") {
                const mm = Math.floor(duration / 60);
                const ss = String(duration % 60).padStart(2, "0");
                label += ` — ${mm}:${ss}`;
              } else {
                label += " — time";
              }
            } else if (r.measurement_type === "cardio") {
              const dist = (s.distance_m === null || s.distance_m === undefined) ? "NA" : `${s.distance_m}m`;
              if (duration !== "") {
                const mm = Math.floor(duration / 60);
                const ss = String(duration % 60).padStart(2, "0");
                label += ` — ${mm}:${ss}, ${dist}`;
              } else {
                label += ` — time, ${dist}`;
              }
            } else {
              if (w !== "" && reps !== "") label += ` — ${w}${unit} × ${reps}`;
              else if (w !== "") label += ` — ${w}${unit}`;
              else if (reps !== "") label += ` — ${reps} reps`;
            }

            // Edit form is only offered for weight_reps sets; time/cardio
            // are simpler to delete-and-re-add.
            const editable = r.measurement_type !== "time_only" && r.measurement_type !== "cardio";
            const sideOpts = `
              <option value="" ${!s.side ? "selected" : ""}>—</option>
              <option value="L" ${s.side === "L" ? "selected" : ""}>L</option>
              <option value="R" ${s.side === "R" ? "selected" : ""}>R</option>
            `;
            const editForm = editable ? `
              <div class="set-edit" data-edit-form="${s.id}" style="display:none; gap:6px; flex-wrap:wrap;">
                <input data-edit-weight="${s.id}" inputmode="decimal" value="${w}" style="width:60px;" />
                <select data-edit-unit="${s.id}" style="width:56px;">
                  <option value="kg" ${unit === "kg" ? "selected" : ""}>kg</option>
                  <option value="lbs" ${unit === "lbs" ? "selected" : ""}>lbs</option>
                </select>
                <input data-edit-reps="${s.id}" inputmode="numeric" value="${reps}" style="width:60px;" />
                ${r.is_unilateral ? `<select data-edit-side="${s.id}" style="width:56px;">${sideOpts}</select>` : ""}
                <button class="tiny" data-action="save-edit" data-setid="${s.id}">✓</button>
                <button class="tiny" data-action="cancel-edit" data-setid="${s.id}">✗</button>
              </div>
            ` : "";

            return `<div class="set-row" data-set-row="${s.id}">
                  <div data-set-label="${s.id}">${label}</div>
                  ${editForm}
                  ${editable ? `<button class="linkbtn tiny" data-action="edit-set" data-setid="${s.id}">✎</button>` : ""}
                  <button class="danger tiny" data-action="delete-set" data-setid="${s.id}">🗑</button>
                </div>`;
          })
          .join("")}
          </div>`
        : `<div class="muted" style="margin-top: 6px;">No sets yet.</div>`;

      let addRow = "";

      if (r.measurement_type === "time_only") {
        addRow = `
    <div class="row" style="margin-top: 10px;">
      <input
        data-duration-for="${r.id}"
        inputmode="numeric"
        placeholder="seconds"
        style="width: 120px;"
      />
      <button
        data-action="add-time-set"
        data-seid="${r.id}"
        class="tiny">
        + Set
      </button>
    </div>
  `;
      } else if (r.measurement_type === "cardio") {
        addRow = `
    <div class="row" style="margin-top: 10px;">
      <input
        data-duration-for="${r.id}"
        inputmode="numeric"
        placeholder="sec"
        style="width: 80px;"
      />
      <input
        data-distance-for="${r.id}"
        inputmode="numeric"
        placeholder="m"
        style="width: 80px;"
      />
      <button
        data-action="add-cardio-set"
        data-seid="${r.id}"
        class="tiny">
        + Cardio
      </button>
    </div>
  `;
      } else if (r.measurement_type === "notes_only") {
        addRow = `
    <div class="muted" style="margin-top: 8px;">
      Notes only — no sets for this exercise.
    </div>
  `;
      } else {
        // DEFAULT: weight + reps. Pre-fill last-ever values as a
        // starting recommendation. The unit defaults to whatever was
        // used last for this exercise (so lbs machines stay lbs).
        // Unilateral exercises show + L and + R instead of + Set.
        const lastW = (r.lastSet?.weight !== null && r.lastSet?.weight !== undefined)
          ? String(r.lastSet.weight) : "";
        const lastR = (r.lastSet?.reps !== null && r.lastSet?.reps !== undefined)
          ? String(r.lastSet.reps) : "";
        const lastUnit = r.lastSet?.weight_unit === "lbs" ? "lbs" : "kg";

        // Warm-up suggestion (Option B): the FIRST set of an exercise in a
        // session shouldn't default to the working/PB weight. If a PB is
        // known, pre-fill ~60% of it (rounded to 2.5, in the unit normally
        // used for this lift) as a warm-up cue. Once any set is logged this
        // session, the normal last-set prefill resumes.
        let prefillW = lastW;
        let warmupHint = "";
        const isFirstSetThisSession = !(r.sets && r.sets.length);
        if (isFirstSetThisSession && r.pb) {
          const warmKg = r.pb * 0.6;
          const warmDisplay = lastUnit === "lbs"
            ? Math.round((warmKg / 0.45359237) / 2.5) * 2.5
            : Math.round(warmKg / 2.5) * 2.5;
          if (Number.isFinite(warmDisplay) && warmDisplay > 0) {
            prefillW = String(warmDisplay);
            warmupHint = `<div class="muted" style="margin-top:4px; font-size:12px;">🔥 Warm-up first — ~${warmDisplay}${lastUnit} (60% of PB), then build to working weight.</div>`;
          }
        }

        const setBtns = r.is_unilateral
          ? `<button data-action="add-set" data-seid="${r.id}" data-side="L" class="tiny">+ L</button>
             <button data-action="add-set" data-seid="${r.id}" data-side="R" class="tiny">+ R</button>`
          : `<button data-action="add-set" data-seid="${r.id}" class="tiny">+ Set</button>`;

        // Per-exercise convention hint (e.g. "per hand" on walking lunges
        // so you don't double-count next session).
        const weightHint = WEIGHT_INPUT_HINTS[r.exercise_name]
          ? `<div class="muted" style="margin-top:4px; font-size:11px;">weight: ${WEIGHT_INPUT_HINTS[r.exercise_name]}</div>`
          : "";

        addRow = `
    ${weightHint}
    ${warmupHint}
    <div class="row" style="margin-top: 10px;">
      <input
        data-weight-for="${r.id}"
        inputmode="decimal"
        placeholder="weight"
        value="${prefillW}"
        style="width: 60px;"
      />
      <select data-weight-unit-for="${r.id}" style="width: 56px;">
        <option value="kg" ${lastUnit === "kg" ? "selected" : ""}>kg</option>
        <option value="lbs" ${lastUnit === "lbs" ? "selected" : ""}>lbs</option>
      </select>
      <input
        data-reps-for="${r.id}"
        inputmode="numeric"
        placeholder="reps"
        value="${lastR}"
        style="width: 60px;"
      />

      ${setBtns}

      <button
        data-action="repeat-set"
        data-seid="${r.id}"
        class="linkbtn tiny">
        ↻
      </button>

      <button
        data-action="delete-exercise"
        data-seid="${r.id}"
        class="danger tiny">
        ✖
      </button>
    </div>
  `;
      }

      const raiseHint = r.suggestRaise
        ? `<div class="muted" style="margin-top:4px; font-size:12px;">💪 Last session was 12+ on every set — try a heavier load.</div>`
        : "";

      // PB drill-down: tap the badge to see the last session's set
      // breakdown. Lets you spot a one-off heavy single vs. a real
      // working weight before deciding what to start with today.
      const pbBadge = r.pb
        ? `<span class="badge pb-badge" data-action="toggle-pb-details" data-seid="${r.id}" style="cursor:pointer;">PB: ${r.pb}kg ▾</span>`
        : "";

      const lastSessionSetsHtml = (r.lastSessionSets && r.lastSessionSets.length)
        ? (() => {
            const parts = r.lastSessionSets.map(s => {
              const unit = s.weight_unit === "lbs" ? "lbs" : "kg";
              const sideTag = s.side ? `${s.side} ` : "";
              if (s.weight != null && s.reps != null) return `${sideTag}${s.weight}${unit}×${s.reps}`;
              if (s.weight != null) return `${sideTag}${s.weight}${unit}`;
              if (s.reps != null) return `${sideTag}${s.reps} reps`;
              if (s.duration_sec != null) {
                const mm = Math.floor(s.duration_sec / 60);
                const ss = String(s.duration_sec % 60).padStart(2, "0");
                return `${sideTag}${mm}:${ss}`;
              }
              return "—";
            });
            return parts.map((p, i) => `${i + 1}: ${p}`).join(", ");
          })()
        : "no previous session logged";

      // Top-5 heaviest sets ever (excluding current session). Each row is
      // surgically editable so a single bad outlier (e.g. an lbs entry
      // typed as kg years ago) can be fixed without scrolling history.
      const topSetsHtml = (r.topSets && r.topSets.length)
        ? r.topSets.map(s => {
            const unit = s.weight_unit === "lbs" ? "lbs" : "kg";
            const sideTag = s.side ? `${s.side} ` : "";
            const repsTxt = s.reps != null ? `×${s.reps}` : "";
            const dateTxt = s.session_date || "";
            const label = `${sideTag}${s.weight}${unit}${repsTxt} <span class="muted">— ${dateTxt}</span>`;

            const sideOpts = `
              <option value="" ${!s.side ? "selected" : ""}>—</option>
              <option value="L" ${s.side === "L" ? "selected" : ""}>L</option>
              <option value="R" ${s.side === "R" ? "selected" : ""}>R</option>
            `;
            const editForm = `
              <div class="set-edit" data-edit-form="${s.id}" style="display:none; gap:6px; flex-wrap:wrap; margin-top:4px;">
                <input data-edit-weight="${s.id}" inputmode="decimal" value="${s.weight ?? ""}" style="width:60px;" />
                <select data-edit-unit="${s.id}" style="width:56px;">
                  <option value="kg" ${unit === "kg" ? "selected" : ""}>kg</option>
                  <option value="lbs" ${unit === "lbs" ? "selected" : ""}>lbs</option>
                </select>
                <input data-edit-reps="${s.id}" inputmode="numeric" value="${s.reps ?? ""}" style="width:60px;" />
                ${r.is_unilateral ? `<select data-edit-side="${s.id}" style="width:56px;">${sideOpts}</select>` : ""}
                <button class="tiny" data-action="save-edit" data-setid="${s.id}">✓</button>
                <button class="tiny" data-action="cancel-edit" data-setid="${s.id}">✗</button>
              </div>
            `;
            return `
              <div class="set-row" data-set-row="${s.id}" style="padding:4px 0;">
                <div data-set-label="${s.id}">${label}</div>
                ${editForm}
                <button class="linkbtn tiny" data-action="edit-set" data-setid="${s.id}">✎</button>
                <button class="danger tiny" data-action="delete-set" data-setid="${s.id}">🗑</button>
              </div>`;
          }).join("")
        : `<div class="muted">no prior sets logged</div>`;

      const pbDetails = r.pb
        ? `<div data-pb-details="${r.id}" style="display:none; margin-top:6px; padding:8px; border-left:2px solid #888; font-size:12px;">
            <div class="muted" style="margin-bottom:4px;">Last session: ${lastSessionSetsHtml}</div>
            <div class="muted" style="margin-top:6px; font-weight:600;">Top 5 heaviest ever (tap ✎ to fix a bad entry, 🗑 to delete):</div>
            <div style="margin-top:4px;">${topSetsHtml}</div>
          </div>`
        : "";

      return `<div class="exercise-item">
        <div class="exercise-header">
          <div>
            <strong>${r.exercise_name}</strong>
            ${note}
          </div>
          ${pbBadge}
        </div>
        ${pbDetails}
        ${raiseHint}
        ${setsHtml}
        ${addRow}
      </div>`;
    })
    .join("") + volumeHtml;

  // Event delegation (overwrite per render; simple + reliable).
  // Selector intentionally accepts any element with [data-action] so
  // the PB badge (a <span>) can also trigger its drill-down.
  container.onclick = async (ev) => {
    const btn = ev.target?.closest?.("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    if (action === "toggle-pb-details") {
      const seid = btn.getAttribute("data-seid");
      const details = container.querySelector(`[data-pb-details="${seid}"]`);
      if (details) {
        details.style.display = details.style.display === "none" ? "block" : "none";
      }
      return;
    }

    if (action === "add-set") {
      const sessionExerciseId = Number(btn.getAttribute("data-seid"));
      const side = btn.getAttribute("data-side") || null;
      const wEl = container.querySelector(`input[data-weight-for="${sessionExerciseId}"]`);
      const rEl = container.querySelector(`input[data-reps-for="${sessionExerciseId}"]`);
      const uEl = container.querySelector(`select[data-weight-unit-for="${sessionExerciseId}"]`);

      const weightRaw = (wEl?.value ?? "").trim();
      const repsRaw = (rEl?.value ?? "").trim();
      const weight_unit = uEl?.value === "lbs" ? "lbs" : "kg";

      await insertSet({
        sessionExerciseId,
        weight: weightRaw === "" ? null : weightRaw,
        weight_unit,
        reps: repsRaw === "" ? null : repsRaw,
        side,
        notes: null
      });

      // Inputs intentionally NOT cleared: pre-fill of last-set values
      // re-asserts on next render anyway, so clearing would just flicker.

      lastActiveSessionExerciseId = sessionExerciseId;
      startRestTimer();

      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "add-time-set") {
      const sessionExerciseId = Number(btn.getAttribute("data-seid"));
      const dEl = container.querySelector(`input[data-duration-for="${sessionExerciseId}"]`);
      const durationRaw = (dEl?.value ?? "").trim();
      logLine("🧪 add-time-set", { sessionExerciseId, durationRaw });

      const durationSec = durationRaw === "" ? null : Number(durationRaw);
      if (durationRaw !== "" && (!Number.isFinite(durationSec) || durationSec < 0)) {
        logLine("⚠️ Invalid seconds value.");
        return;
      }

      await insertSet({
        sessionExerciseId,
        duration_sec: durationSec,
        weight: null,
        weight_unit: null,
        reps: null,
        distance_m: null,
        assisted: 0,
        notes: null
      });

      if (dEl) dEl.value = "";

      lastActiveSessionExerciseId = sessionExerciseId;
      startRestTimer();

      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "add-cardio-set") {
      const sessionExerciseId = Number(btn.getAttribute("data-seid"));
      const dEl = container.querySelector(`input[data-duration-for="${sessionExerciseId}"]`);
      const distEl = container.querySelector(`input[data-distance-for="${sessionExerciseId}"]`);

      const durationRaw = (dEl?.value ?? "").trim();
      const distanceRaw = (distEl?.value ?? "").trim();

      const durationSec = durationRaw === "" ? null : Number(durationRaw);
      const distanceM = distanceRaw === "" ? null : Number(distanceRaw);

      await insertSet({
        sessionExerciseId,
        duration_sec: durationSec,
        distance_m: distanceM,
        weight: null,
        reps: null,
        notes: null
      });

      if (dEl) dEl.value = "";
      if (distEl) distEl.value = "";

      lastActiveSessionExerciseId = sessionExerciseId;
      startRestTimer();
      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "delete-set") {
      const setId = Number(btn.getAttribute("data-setid"));
      await deleteSet(setId);
      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "edit-set") {
      const setId = btn.getAttribute("data-setid");
      const label = container.querySelector(`[data-set-label="${setId}"]`);
      const form = container.querySelector(`[data-edit-form="${setId}"]`);
      if (label) label.style.display = "none";
      if (form) form.style.display = "flex";
      btn.style.display = "none";
      return;
    }

    if (action === "cancel-edit") {
      // Re-render restores original values from the DB.
      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "save-edit") {
      const setId = Number(btn.getAttribute("data-setid"));
      const wEl = container.querySelector(`[data-edit-weight="${setId}"]`);
      const uEl = container.querySelector(`[data-edit-unit="${setId}"]`);
      const rEl = container.querySelector(`[data-edit-reps="${setId}"]`);
      const sideEl = container.querySelector(`[data-edit-side="${setId}"]`);

      const weightRaw = (wEl?.value ?? "").trim();
      const repsRaw = (rEl?.value ?? "").trim();
      const sideRaw = sideEl ? (sideEl.value || null) : undefined;

      const fields = {
        weight: weightRaw === "" ? null : Number(weightRaw),
        weight_unit: uEl?.value === "lbs" ? "lbs" : "kg",
        reps: repsRaw === "" ? null : Number(repsRaw),
      };
      if (sideRaw !== undefined) fields.side = sideRaw;

      await updateSet(setId, fields);
      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "repeat-set") {
      try {
        const sessionExerciseId = Number(btn.getAttribute("data-seid"));
        logLine("🟦 repeat-set clicked:", { sessionExerciseId });

        const sets = await listSets(sessionExerciseId);
        if (!sets.length) {
          logLine("⚠️ No sets to repeat for this exercise.");
          return;
        }

        const last = sets[sets.length - 1];
        await insertSet({
          sessionExerciseId,
          weight: last.weight,
          weight_unit: last.weight_unit,
          reps: last.reps,
          side: last.side,
          notes: last.notes || null,
        });

        logLine("✅ Repeated last set:", { weight: last.weight, reps: last.reps, side: last.side });

        lastActiveSessionExerciseId = sessionExerciseId;
        startRestTimer();

        await renderSelectedSessionExercises(sessionId, container);
      } catch (e) {
        logLine("❌ repeat-set failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    }

    if (action === "delete-exercise") {
      try {
        const sessionExerciseId = Number(btn.getAttribute("data-seid"));
        logLine("🟦 delete-exercise clicked:", { sessionExerciseId });

        await deleteSessionExercise(sessionExerciseId);

        logLine("✅ Removed exercise from session_exercises:", { sessionExerciseId });
        await renderSelectedSessionExercises(sessionId, container);
      } catch (e) {
        logLine("❌ delete-exercise failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    }

  };
}

async function initSqliteWeb(log) {
  // 1) Register the web component <jeep-sqlite>
  jeepSqliteDefineCustomElements(window);

  // 2) Wait until the element is defined
  await customElements.whenDefined("jeep-sqlite");

  // 3) Wait until the instance is ready
  const el = document.querySelector("jeep-sqlite");
  if (!el) throw new Error("No <jeep-sqlite> element found in DOM");
  if (el.componentOnReady) await el.componentOnReady();

  // 4) Init Capacitor SQLite web store
  await CapacitorSQLite.initWebStore();

  if (typeof log === "function") log("✅ SQLite web bootstrap OK");
}

async function safeStart() {
  try {
    logLine("✅ JS loaded (Phase A: session lifecycle)");

    const platform = Capacitor.getPlatform();
    logLine("Platform:", platform);

    if (platform === "web") {
      await initSqliteWeb(logLine);
    }

    await initDb(logLine);

    try {
      await seedExercisesFromCsv(logLine);
      const ex = await listExercises(5);
      logLine("✅ Sample exercises:", ex.map(x => x.name));
    } catch (e) {
      logLine("⚠️ Exercise seed/list failed (non-fatal):", String(e));
    }

    // Phase G — semantic correction (idempotent)
    await setExerciseMeasurementType("Bike", "time_only");

    // Default date
    const dateInput = document.getElementById("session-date");
    if (dateInput && !dateInput.value) dateInput.value = todayISO();

    // Wire buttons (MATCHES YOUR index.html IDs)
    const createBtn = document.getElementById("btn-create-session");
    const finishBtn = document.getElementById("btn-finish-session");
    const refreshBtn = document.getElementById("btn-refresh-sessions");
    const exportBtn = document.getElementById("btn-export-data");

    if (!createBtn) logLine("❌ Missing #btn-create-session in DOM");
    if (!finishBtn) logLine("❌ Missing #btn-finish-session in DOM");
    if (!refreshBtn) logLine("❌ Missing #btn-refresh-sessions in DOM");
    if (!exportBtn) logLine("❌ Missing #btn-export-data in DOM");

    createBtn?.addEventListener("click", async () => {
      try {
        const date = document.getElementById("session-date")?.value || todayISO();
        const focus = document.getElementById("session-focus")?.value || "other";
        const notes = document.getElementById("session-notes")?.value || "";

        logLine("🟦 Create clicked:", { date, focus, notes });

        const id = await createSession({ date, focus, notes });
        selectedSessionId = id;

        await preloadTemplateExercises(id, focus, logLine);

        const detail = await getSessionDetail(id);

        setSelectedSessionUI(detail);
        await renderSelectedSessionExercises(selectedSessionId);
        await updateLiveDot();
        showView("session");
        await refreshSessionsList();
      } catch (e) {
        logLine("❌ Create session failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    });

    exportBtn?.addEventListener("click", async () => {
      try {
        await exportAll({
          log: typeof logLine === "function" ? logLine : undefined
        });
      } catch (e) {
        logLine("❌ Export failed:", String(e));
      }
    });

    finishBtn?.addEventListener("click", async () => {
      try {
        const activeId = await getActiveSessionId();
        if (!activeId) {
          logLine("⚠️ No active session to finish.");
          return;
        }
        // Light cool-down nudge — easy to dismiss if you already stretched.
        if (!window.confirm("All done? Did you stretch?")) {
          return;
        }
        logLine("🟦 Finishing session...", activeId);
        await finishSession(activeId, logLine);
        stopRestTimer();

        logLine("🟦 Resetting UI to idle...");
        selectedSessionId = null;
        lastActiveSessionExerciseId = null;
        setSelectedSessionUI(null);

        await renderSelectedSessionExercises(null);
        await renderSessionIdle();
        await updateLiveDot();
        showView("session");
        await refreshSessionsList();
        logLine("✅ Session finished and returned to idle.");
      } catch (e) {
        logLine("❌ Finish session failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    });

    document.getElementById("btn-stop-timer")?.addEventListener("click", () => {
      stopRestTimer();
    });

    document.getElementById("btn-add-15s")?.addEventListener("click", () => {
      addRestTime(15);
    });

    // Standalone stopwatch (Timer tab)
    document.getElementById("btn-sw-start")?.addEventListener("click", toggleStopwatch);
    document.getElementById("btn-sw-reset")?.addEventListener("click", resetStopwatch);

    refreshBtn?.addEventListener("click", async () => {
      try {
        await refreshSessionsList();
      } catch (e) {
        logLine("❌ Refresh list failed:", String(e));
      }
    });

    // ---------------------------
    // Bottom nav + back buttons
    // ---------------------------
    document.querySelectorAll("#bottom-nav [data-nav]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.getAttribute("data-nav");
        // Refresh per-tab content on entry.
        if (name === "session") await renderSessionIdle();
        if (name === "history") await refreshSessionsList();
        showView(name);
      });
    });

    // Back from an active session → suspend (flip to idle, DB untouched,
    // timer keeps running).
    document.getElementById("btn-session-back")?.addEventListener("click", async () => {
      await renderSessionIdle();
      showSessionState("idle");
    });

    // Back from a finished-session detail → return to the history list.
    document.getElementById("btn-history-back")?.addEventListener("click", () => {
      document.getElementById("history-detail").style.display = "none";
      document.getElementById("history-list").style.display = "block";
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

    await renderSessionIdle();
    await updateLiveDot();
    showView("session");

    await refreshSessionsList();

    try {
      await SplashScreen.hide();
      logLine("✅ SplashScreen.hide()");
    } catch (e) {
      logLine("⚠️ SplashScreen.hide failed:", String(e));
    }

    logLine("✅ Ready.");
    // -----------------------------
    // Unified Exercise Search
    // -----------------------------
    try {
      const exerciseInput = document.getElementById("exercise-name");
      const listDiv = document.getElementById("exercise-picker-list");

      if (!exerciseInput || !listDiv) {
        logLine("⚠️ Unified exercise elements not found");
      } else {
        const renderResults = async (qRaw = "") => {
          const q = String(qRaw).trim().toLowerCase();
          if (!q) {
            listDiv.style.display = "none";
            return;
          }

          // Fresh query each time so newly-added exercises appear without reload.
          const allExercises = await listExercises(1000);
          const filtered = allExercises.filter(e => e.name.toLowerCase().includes(q));
          if (filtered.length === 0) {
            listDiv.style.display = "none";
            return;
          }

          listDiv.style.display = "block";
          listDiv.innerHTML = filtered.slice(0, 10)
            .map(e => `
              <button type="button"
                data-name="${e.name.replace(/"/g, "&quot;")}"
                class="search-item">
                ${e.name}
              </button>
            `)
            .join("");

          listDiv.querySelectorAll("button[data-name]").forEach(btn => {
            btn.addEventListener("click", async () => {
              const name = btn.getAttribute("data-name");
              exerciseInput.value = name;
              listDiv.style.display = "none";

              // Suggest previous weight/reps
              const lastSet = await getLatestSetForExercise(name);
              if (lastSet) {
                const pillsContainer = document.getElementById("recent-exercise-pills");
                if (pillsContainer) {
                  let label = "";
                  if (lastSet.weight) label += `${lastSet.weight}kg `;
                  if (lastSet.reps) label += `x ${lastSet.reps}`;
                  if (lastSet.duration_sec) label += `(${Math.floor(lastSet.duration_sec / 60)}:${String(lastSet.duration_sec % 60).padStart(2, '0')})`;

                  pillsContainer.innerHTML = `<button class="pill tiny" data-set='${JSON.stringify(lastSet)}'>Use last: ${label}</button>`;
                  pillsContainer.querySelector("button")?.addEventListener("click", () => {
                    // This pill logic will be handled below
                  });
                }
              }
            });
          });
        };

        exerciseInput.addEventListener("input", () => renderResults(exerciseInput.value));

        // Hide list when clicking outside
        document.addEventListener("click", (e) => {
          if (!exerciseInput.contains(e.target) && !listDiv.contains(e.target)) {
            listDiv.style.display = "none";
          }
        });

        // Handle suggested pill clicks
        document.getElementById("recent-exercise-pills")?.addEventListener("click", (e) => {
          const btn = e.target.closest("button[data-set]");
          if (btn) {
            const lastSet = JSON.parse(btn.getAttribute("data-set"));
            logLine("🟦 Applied suggestion:", lastSet);
            // We could auto-fill inputs here if we had specific ones, but session-exercise doesn't have them yet.
            // Actually, we usually want these when adding SETS.
          }
        });
      }
    } catch (e) {
      logLine("⚠️ Unified search failed:", String(e));
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

    // ---------------------------
    // Merge old exercise names (one-shot tool)
    // Old logs under deprecated template names are invisible to the new
    // PB queries because the name doesn't match. This UI surfaces those
    // orphans and lets the user remap each to a current canonical name.
    // ---------------------------
    const loadOrphansBtn = document.getElementById("btn-load-orphans");
    const orphanListEl = document.getElementById("orphan-list");

    loadOrphansBtn?.addEventListener("click", async () => {
      try {
        const orphans = await listOrphanExerciseNames();
        const canonical = await listExercises(1000);

        if (!orphans.length) {
          orphanListEl.innerHTML = `<div class="muted">No orphan exercise names found. Your history is clean.</div>`;
          return;
        }

        const options = ['<option value="">— pick canonical name —</option>']
          .concat(canonical.map(e => `<option value="${e.name.replace(/"/g, "&quot;")}">${e.name}</option>`))
          .join("");

        const rows = orphans.map((o, idx) => `
          <div class="card" style="margin-top:8px;">
            <div><strong>${o.name}</strong> <span class="muted">(${o.set_count} sets)</span></div>
            <div class="row" style="margin-top:6px;">
              <select data-orphan-map="${idx}" style="flex:1;">${options}</select>
            </div>
            <input type="hidden" data-orphan-name="${idx}" value="${o.name.replace(/"/g, "&quot;")}" />
          </div>
        `).join("");

        orphanListEl.innerHTML = `
          ${rows}
          <div class="row" style="margin-top:12px;">
            <button id="btn-apply-merge">Apply merges</button>
          </div>
        `;

        document.getElementById("btn-apply-merge")?.addEventListener("click", async () => {
          const selects = orphanListEl.querySelectorAll("select[data-orphan-map]");
          let merged = 0;
          let updatedRows = 0;
          for (const sel of selects) {
            const idx = sel.getAttribute("data-orphan-map");
            const oldName = orphanListEl.querySelector(`input[data-orphan-name="${idx}"]`)?.value;
            const newName = sel.value;
            if (!oldName || !newName) continue;
            const n = await mergeExerciseName(oldName, newName);
            if (n > 0) {
              merged += 1;
              updatedRows += n;
            }
          }
          if (merged === 0) {
            orphanListEl.innerHTML = `<div class="muted">Nothing to merge — no canonical names were picked.</div>`;
          } else {
            orphanListEl.innerHTML = `<div class="muted">✅ Merged ${merged} name(s), updated ${updatedRows} session_exercises row(s). Your old PBs should now surface under the new names.</div>`;
          }
          logLine(`✅ Merge: ${merged} names, ${updatedRows} rows`);
        });
      } catch (e) {
        logLine("❌ load orphans failed:", String(e));
      }
    });
  } catch (e) {
    logLine("❌ safeStart crashed:", String(e));
    if (e?.stack) logLine(e.stack);
  }
}

safeStart();
