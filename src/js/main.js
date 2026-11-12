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
  getLatestSetForExercise,
  getPersonalBest,
  getSessionVolume,
  shouldSuggestRaise,
  getLastSessionSetsForExercise,
  getTopSetsForExercise,
  getSetting,
  setSetting,
  updateExerciseSettings,
  createCustomTemplate,
  listCustomTemplates,
  deleteCustomTemplate
} from "./db.js";
import { TEMPLATES, WEIGHT_INPUT_HINTS, SESSION_LABELS } from "./templates.js";
import { LocalNotifications } from "@capacitor/local-notifications";
import {
  configureStats,
  renderDashboard as renderStatsDashboard,
  renderExercisePage,
  libraryIndex,
  esc,
  fmtDate,
} from "./stats.js";
import { runBackup, lastBackupText, restoreFromText } from "./backup.js";
import { MEASUREMENT_LABELS } from "./muscles.js";
import {
  exportCustomTemplate,
  exportSessionAsTemplate,
  importTemplateFromText
} from "./session-io.js";

let selectedSessionId = null;
// Tracks the session_exercise the user most recently logged a set on,
// so we can float it to the top of the list (keeps the active exercise
// next to the rest timer). Reset when leaving a session.
let lastActiveSessionExerciseId = null;

// In-memory id→name cache for custom templates, so session headers can
// show a friendly label instead of the raw focus="custom:<id>" key
// without an async lookup on every render. Refreshed whenever templates
// are (re)loaded.
let customTemplateNames = {};

// Draft exercise list for the custom-session builder (item 7).
let customBuilderExercises = [];

// Human label for a session's focus. Handles the static 5-day/4-day keys
// plus custom templates (focus="custom:<id>").
function focusLabel(focus) {
  if (typeof focus === "string" && focus.startsWith("custom:")) {
    const id = focus.slice("custom:".length);
    return customTemplateNames[id] || "Custom";
  }
  return SESSION_LABELS[focus] || focus || "";
}

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
// Default rest when neither the exercise nor the plan sets one. Loaded
// from Settings at boot.
let restDefaultSec = REST_TIMER_DEFAULT_SEC;
let restHideTimeout = null;
const REST_NOTIFICATION_ID = 4101;
let notifAllowed = null;
let audioCtx = null;

// Notifications are only used while the app is in the background (the
// page's own timers stop there, so it can't buzz by itself).
async function canNotify() {
  if (!Capacitor.isNativePlatform()) return false;
  if (notifAllowed === null) {
    try {
      let p = await LocalNotifications.checkPermissions();
      if (p.display !== "granted") p = await LocalNotifications.requestPermissions();
      notifAllowed = p.display === "granted";
    } catch (_) {
      notifAllowed = false;
    }
  }
  return notifAllowed;
}

async function cancelRestNotification() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: REST_NOTIFICATION_ID }] });
  } catch (_) { /* nothing scheduled */ }
}

async function scheduleRestNotification() {
  if (timerEndAt == null || timerEndAt <= Date.now() + 1000) return;
  if (!(await canNotify())) return;
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: REST_NOTIFICATION_ID,
        title: "Rest over",
        body: "Time for your next set.",
        schedule: { at: new Date(timerEndAt), allowWhileIdle: true },
      }],
    });
  } catch (e) {
    logLine("⚠️ Could not schedule rest notification:", String(e));
  }
}

function restDoneAlert() {
  try { navigator.vibrate?.([250, 120, 250]); } catch (_) { /* unsupported */ }
  try {
    if (!audioCtx) return;
    for (const at of [0, 0.3]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.15;
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + at);
      o.stop(audioCtx.currentTime + at + 0.2);
    }
  } catch (_) { /* no audio */ }
}

function startRestTimer(seconds) {
  const container = document.getElementById("rest-timer-container");
  if (!container) return;
  const secs = Number(seconds) > 0 ? Number(seconds) : restDefaultSec;

  // Called from a tap, so this is allowed to create/resume audio.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) { /* no audio */ }
  canNotify(); // ask once, early, rather than when the phone is locked

  if (timerTickInterval) clearInterval(timerTickInterval);
  if (restHideTimeout) { clearTimeout(restHideTimeout); restHideTimeout = null; }

  timerEndAt = Date.now() + secs * 1000;
  container.style.display = "block";
  container.classList.remove("done");

  renderRestTimer();
  // 250ms tick: cheap, smooth, makes +15s feel snappy
  timerTickInterval = setInterval(renderRestTimer, 250);
}

function renderRestTimer() {
  const display = document.getElementById("rest-timer-display");
  if (!display || timerEndAt == null) return;

  const remainingMs = timerEndAt - Date.now();

  if (remainingMs <= 0) {
    // Finished: say so for a few seconds instead of silently vanishing.
    const late = -remainingMs > 3000; // came back to the app after it ended
    if (timerTickInterval) { clearInterval(timerTickInterval); timerTickInterval = null; }
    timerEndAt = null;
    cancelRestNotification();
    display.textContent = "Go!";
    document.getElementById("rest-timer-container")?.classList.add("done");
    if (!late) restDoneAlert();
    restHideTimeout = setTimeout(stopRestTimer, 6000);
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
  if (restHideTimeout) { clearTimeout(restHideTimeout); restHideTimeout = null; }
  timerEndAt = null;
  cancelRestNotification();
  const container = document.getElementById("rest-timer-container");
  if (container) {
    container.style.display = "none";
    container.classList.remove("done");
  }
}

function addRestTime(seconds) {
  if (timerEndAt == null) return;
  timerEndAt += seconds * 1000;
  renderRestTimer();
}

// Foreground: the page counts down and buzzes itself. Background: hand
// the alert to a scheduled notification, and take it back on return.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    scheduleRestNotification();
  } else {
    cancelRestNotification();
    renderRestTimer();
  }
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
// The exercise this run is being timed for (set by "Time it" on an
// exercise card). null = a plain stopwatch.
let swTarget = null;
const TIMED_TYPES = ["time_only", "weight_time", "cardio"];

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
  renderStopwatchSave();
}

function resetStopwatch() {
  swRunning = false;
  swStartAt = null;
  swAccumMs = 0;
  if (swTickInterval) { clearInterval(swTickInterval); swTickInterval = null; }
  const btn = document.getElementById("btn-sw-start");
  if (btn) btn.textContent = "Start";
  renderStopwatch();
  renderStopwatchSave();
}

function fmtClock(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// Under the stopwatch: offer to save the time to a timed exercise in the
// session being worked. With no session (or no time yet) it stays a
// plain stopwatch.
async function renderStopwatchSave() {
  const el = document.getElementById("stopwatch-save");
  if (!el) return;
  const secs = Math.round(swElapsedMs() / 1000);
  const targetNote = swTarget ? `<div class="sw-target">Timing <strong>${esc(swTarget.name)}</strong></div>` : "";

  if (swRunning || secs < 1) {
    el.innerHTML = targetNote + (swRunning && swTarget ? `<div class="muted">Pause to save it.</div>` : "");
    return;
  }

  const activeId = await getActiveSessionId();
  if (!activeId) {
    el.innerHTML = `<div class="muted">Start a session to save this time to an exercise.</div>`;
    return;
  }
  let timed = (await listSessionExercises(activeId)).filter((r) => TIMED_TYPES.includes(r.measurement_type));
  if (swTarget) timed.sort((a, b) => (a.id === swTarget.seid ? -1 : b.id === swTarget.seid ? 1 : 0));
  if (!timed.length) {
    el.innerHTML = `<div class="muted">No timed exercises in this session. Add one (Bike, Plank…) and you can save times to it.</div>`;
    return;
  }
  el.innerHTML = `${targetNote}<div class="muted" style="margin-bottom:8px;">Save ${fmtClock(secs)} to:</div>` +
    timed.map((r, i) => `<button class="${i === 0 && swTarget ? "" : "linkbtn"} sw-save" data-sw-save="${r.id}" data-name="${esc(r.exercise_name)}" data-type="${r.measurement_type}">${esc(r.exercise_name)}</button>`).join("");

  el.onclick = async (ev) => {
    const b = ev.target.closest("[data-sw-save]");
    if (!b) return;
    const seid = Number(b.getAttribute("data-sw-save"));
    const name = b.getAttribute("data-name");
    let weight = null, unit = null;
    if (b.getAttribute("data-type") === "weight_time") {
      if (swTarget && swTarget.seid === seid && swTarget.weight != null) {
        weight = swTarget.weight; unit = swTarget.unit;
      } else {
        const last = await getLatestSetForExercise(name);
        if (last?.weight != null) { weight = last.weight; unit = last.weight_unit || "kg"; }
      }
    }
    await insertSet({ sessionExerciseId: seid, duration_sec: secs, weight, weight_unit: unit });
    logLine(`✅ Saved ${fmtClock(secs)} to ${name}`);
    swTarget = null;
    resetStopwatch();
    lastActiveSessionExerciseId = seid;
    selectedSessionId = activeId;
    setSelectedSessionUI(await getSessionDetail(activeId));
    await renderSelectedSessionExercises(activeId);
    showView("session");
  };
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
const VIEWS = ["session", "dashboard", "history", "library", "timer"];

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
      banner.innerHTML = `<button id="btn-resume">▶ Resume ${focusLabel(d.focus).toUpperCase()} — ${d.date}</button>`;
      banner.style.display = "block";
      document.getElementById("btn-resume")?.addEventListener("click", async () => {
        selectedSessionId = activeId;
        setSelectedSessionUI(d);
        await renderSelectedSessionExercises(activeId);
        showView("session");
      });
    }
  }
  await renderNextUp();
  await refreshCustomSessions();
}

/* --------------------------------------------------
   Custom sessions (items 7 & 8)
   - refreshCustomSessions: reload cache, dropdown options, saved list,
     and the exercise autocomplete datalist
   - the builder draft lives in customBuilderExercises
-------------------------------------------------- */
async function refreshCustomSessions() {
  const templates = await listCustomTemplates();

  // Refresh the id→name cache used by focusLabel().
  customTemplateNames = {};
  for (const t of templates) customTemplateNames[String(t.id)] = t.name;

  populateFocusDropdown(templates);
  renderCustomTemplatesList(templates);
  await populateExerciseDatalist();
}

// Append a "My sessions" optgroup of saved custom templates to the
// Create-session dropdown, so they start exactly like a built-in split.
function populateFocusDropdown(templates) {
  const sel = document.getElementById("session-focus");
  if (!sel) return;
  sel.querySelector('optgroup[data-custom="1"]')?.remove();
  if (!templates.length) return;
  const og = document.createElement("optgroup");
  og.label = "My sessions";
  og.setAttribute("data-custom", "1");
  for (const t of templates) {
    const opt = document.createElement("option");
    opt.value = `custom:${t.id}`;
    opt.textContent = t.name;
    og.appendChild(opt);
  }
  sel.appendChild(og);
}

// Render saved custom templates with Start / Share / Delete controls.
function renderCustomTemplatesList(templates) {
  const el = document.getElementById("custom-templates-list");
  if (!el) return;
  if (!templates.length) {
    el.innerHTML = `<div class="muted">No custom sessions yet. Build one below.</div>`;
    return;
  }
  el.innerHTML = templates
    .map(
      (t) => `
      <div class="card" style="margin-bottom:8px;">
        <div><strong>${t.name}</strong> <span class="muted">— ${t.exercise_count} exercises</span></div>
        <div class="row" style="margin-top:8px; gap:8px;">
          <button class="linkbtn tiny" data-tpl-start="${t.id}">▶ Start</button>
          <button class="linkbtn tiny" data-tpl-share="${t.id}">📤 Share</button>
          <button class="danger tiny" data-tpl-delete="${t.id}">🗑</button>
        </div>
      </div>`
    )
    .join("");

  el.querySelectorAll("[data-tpl-start]").forEach((b) =>
    b.addEventListener("click", () => startCustomSession(Number(b.getAttribute("data-tpl-start"))))
  );
  el.querySelectorAll("[data-tpl-share]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await exportCustomTemplate(Number(b.getAttribute("data-tpl-share")), { log: logLine });
      } catch (e) {
        logLine("❌ Share template failed:", String(e));
      }
    })
  );
  el.querySelectorAll("[data-tpl-delete]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.getAttribute("data-tpl-delete"));
      if (!window.confirm("Delete this custom session?")) return;
      await deleteCustomTemplate(id, logLine);
      await refreshCustomSessions();
    })
  );
}

// Fill the <datalist> that powers the builder's exercise autocomplete.
async function populateExerciseDatalist() {
  const dl = document.getElementById("exercise-datalist");
  if (!dl) return;
  const exercises = await listExercises(1000);
  dl.innerHTML = exercises.map((e) => `<option value="${e.name}"></option>`).join("");
}

// Create + start a session from a saved custom template.
async function startCustomSession(templateId) {
  try {
    const date = document.getElementById("session-date")?.value || todayISO();
    await startSession(`custom:${templateId}`, { date });
  } catch (e) {
    logLine("❌ Start custom session failed:", String(e));
  }
}

// Re-render the builder's draft exercise chips.
function renderCustomBuilderChips() {
  const el = document.getElementById("custom-tpl-exercises");
  if (!el) return;
  el.innerHTML = customBuilderExercises
    .map(
      (name, i) =>
        `<span class="badge" style="cursor:pointer;" data-chip-remove="${i}">${name} ✕</span>`
    )
    .join("");
  el.querySelectorAll("[data-chip-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-chip-remove"));
      customBuilderExercises.splice(i, 1);
      renderCustomBuilderChips();
    })
  );
}

/* --------------------------------------------------
   Exercise Library (Library tab)
   - Static video index (videos/index.json) fetched once and cached
   - resolveVideoUrl: exercise name → slug → check Set → url or null
   - renderLibrary: grouped list with search filter
   - openLibraryExercise: video player + description + tips
-------------------------------------------------- */
let availableVideos = new Set();

async function loadVideoIndex() {
  try {
    const resp = await fetch("videos/index.json");
    if (resp.ok) availableVideos = new Set(await resp.json());
  } catch (_) { /* non-fatal — no videos shown */ }
}

function resolveVideoUrl(exerciseName) {
  const slug = exerciseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${slug}.mp4`;
  return availableVideos.has(filename) ? `videos/${filename}` : null;
}

// The library lists every exercise in the catalogue (everything ever
// logged plus the seed list), grouped by muscle group. The header and
// search box are static HTML; only the rows are re-rendered while typing,
// so the keyboard never loses focus.
let libraryGroups = null;
let libraryReturnView = null; // where "Back" goes when opened from elsewhere

async function renderLibrary({ reload = true } = {}) {
  const rowsEl = document.getElementById("library-rows");
  if (!rowsEl) return;
  if (reload || !libraryGroups) libraryGroups = await libraryIndex();

  const q = (document.getElementById("library-search")?.value ?? "").trim().toLowerCase();
  const showUnlogged = !!document.getElementById("library-show-all")?.checked || !!q;

  let html = "";
  let shown = 0;
  for (const [group, list] of libraryGroups) {
    const rows = list.filter((e) => (showUnlogged || e.sessions > 0) && (!q || e.name.toLowerCase().includes(q)));
    if (!rows.length) continue;
    shown += rows.length;
    html += `<div class="library-group-label">${esc(group)}</div>`;
    html += rows
      .map((e) => {
        const sub = e.sessions
          ? `${e.sessions} session${e.sessions === 1 ? "" : "s"} · last ${fmtDate(e.last)}`
          : "not logged yet";
        return `
          <div class="library-row" data-library-exercise="${esc(e.name)}">
            <div>
              <div class="library-row-name">${esc(e.name)}${e.unilateral ? ` <span class="side-tag">L/R</span>` : ""}</div>
              <div class="library-row-tagline">${sub}</div>
            </div>
            ${resolveVideoUrl(e.name) ? `<span class="video-badge">▶ video</span>` : ""}
          </div>`;
      })
      .join("");
  }
  if (!shown) {
    html = `<div class="muted" style="padding:14px 4px;">${q ? `Nothing matches "${esc(q)}".` : "Nothing logged yet — tick the box above to see every exercise."}</div>`;
  }
  rowsEl.innerHTML = html;
}

function showLibraryList() {
  document.getElementById("library-detail").style.display = "none";
  document.getElementById("library-list").style.display = "block";
}

// Opens an exercise's page (chart, records, history, form notes,
// settings). Used by the library list, the Stats tab and exercise cards.
async function openLibraryExercise(name, { from = null } = {}) {
  const listEl = document.getElementById("library-list");
  const detailEl = document.getElementById("library-detail");
  const contentEl = document.getElementById("library-exercise-detail");
  if (!listEl || !detailEl || !contentEl) return;
  libraryReturnView = from;
  listEl.style.display = "none";
  detailEl.style.display = "block";
  showView("library");
  await renderExercisePage(contentEl, name);
  window.scrollTo(0, 0);
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
      <div style="font-family: 'Montserrat', sans-serif; font-size: 20px; font-weight: 700;">${focusLabel(session.focus).toUpperCase()}</div>
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
        <strong>${focusLabel(s.focus).toUpperCase()}</strong> — ${s.date}
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
      if (!window.confirm(`Delete the ${focusLabel(s.focus)} session from ${s.date}? This removes all its sets and can't be undone.`)) return;
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
      <div style="font-family:'Montserrat',sans-serif; font-size:20px; font-weight:700;">${focusLabel(detail.focus).toUpperCase()}</div>
      <div class="muted" style="margin-top:4px;">${detail.date}</div>
      ${detail.notes ? `<div class="muted">Notes: ${detail.notes}</div>` : ""}
      <div class="row" style="margin-top:10px;">
        <button class="linkbtn tiny" data-export-session="${s.id}">📤 Share as template</button>
      </div>
    `;
    header.querySelector(`[data-export-session="${s.id}"]`)?.addEventListener("click", async () => {
      try {
        await exportSessionAsTemplate(s.id, { log: logLine });
      } catch (e) {
        logLine("❌ Share session failed:", String(e));
      }
    });
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

  // The plan for this session (built-in splits only): target sets, reps,
  // rest and starting weight per exercise.
  const sessionRow = await getSessionDetail(sessionId);
  const planMap = new Map(
    (TEMPLATES[sessionRow?.focus]?.exercises || []).map((e) => [e.name.toLowerCase(), e])
  );
  const restBySeid = new Map();

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
    // orderIdx = rank in the session's intended sequence (rows arrive
    // position-ordered). Item 3: the warm-up cue is only relevant for the
    // first two exercises of a session, not every lift.
    rowsDetailed.push({ ...r, sets, pb, lastSet, suggestRaise, lastSessionSets, topSets, orderIdx: rowsDetailed.length });
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
      const plan = planMap.get(String(r.exercise_name).toLowerCase());
      // Rest: your own setting for the exercise, else the plan's, else default.
      restBySeid.set(r.id, Number(r.rest_sec) || Number(plan?.rest_sec) || restDefaultSec);
      const isBW = r.measurement_type === "bodyweight";

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
            } else if (r.measurement_type === "weight_time") {
              // Weighted hold: show load AND duration. PB tracks the load.
              const parts = [];
              if (w !== "") parts.push(`${w}${unit}`);
              if (duration !== "") {
                const mm = Math.floor(duration / 60);
                const ss = String(duration % 60).padStart(2, "0");
                parts.push(`${mm}:${ss}`);
              }
              label += parts.length ? ` — ${parts.join(" × ")}` : " — hold";
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
              if (isBW && !(Number(w) > 0)) label += reps !== "" ? ` — ${reps} reps` : "";
              else if (isBW) label += ` — +${w}${unit} × ${reps}`;
              else if (w !== "" && reps !== "") label += ` — ${w}${unit} × ${reps}`;
              else if (w !== "") label += ` — ${w}${unit}`;
              else if (reps !== "") label += ` — ${reps} reps`;
            }

            // Edit form is only offered for weight_reps sets; time/cardio
            // are simpler to delete-and-re-add.
            const editable = r.measurement_type !== "time_only"
              && r.measurement_type !== "cardio"
              && r.measurement_type !== "weight_time";
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
        placeholder="sec"
        style="width: 120px;"
      />
      <button
        data-action="add-time-set"
        data-seid="${r.id}"
        class="tiny">
        + Set
      </button>
      <button data-action="time-it" data-seid="${r.id}" data-name="${esc(r.exercise_name)}" class="linkbtn tiny">⏱ Time it</button>
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
      <button data-action="time-it" data-seid="${r.id}" data-name="${esc(r.exercise_name)}" class="linkbtn tiny">⏱ Time it</button>
    </div>
  `;
      } else if (r.measurement_type === "weight_time") {
        // Weighted hold (item 4): capture BOTH load and duration. PB is
        // tracked off the weight, so pre-fill the last-used load + unit.
        const lastW = (r.lastSet?.weight !== null && r.lastSet?.weight !== undefined)
          ? String(r.lastSet.weight) : "";
        const lastUnit = r.lastSet?.weight_unit === "lbs" ? "lbs" : "kg";
        addRow = `
    <div class="row" style="margin-top: 10px;">
      <input
        data-weight-for="${r.id}"
        inputmode="decimal"
        placeholder="weight"
        value="${lastW}"
        style="width: 60px;"
      />
      <select data-weight-unit-for="${r.id}" style="width: 56px;">
        <option value="kg" ${lastUnit === "kg" ? "selected" : ""}>kg</option>
        <option value="lbs" ${lastUnit === "lbs" ? "selected" : ""}>lbs</option>
      </select>
      <input
        data-duration-for="${r.id}"
        inputmode="numeric"
        placeholder="sec"
        style="width: 90px;"
      />
      <button
        data-action="add-weight-time-set"
        data-seid="${r.id}"
        class="tiny">
        + Set
      </button>
      <button data-action="time-it" data-seid="${r.id}" data-name="${esc(r.exercise_name)}" class="linkbtn tiny">⏱ Time it</button>
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
        let prefillW = isBW && !(Number(lastW) > 0) ? "" : lastW;
        let warmupHint = "";
        const isFirstSetThisSession = !(r.sets && r.sets.length);
        // Item 3: warm-up cue only for the first two exercises of the
        // session — later lifts are already warm.
        const warmupEligible = r.orderIdx < 2 && !isBW;
        if (isFirstSetThisSession && warmupEligible && r.pb) {
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
      ${isBW ? `
      <input data-reps-for="${r.id}" inputmode="numeric" placeholder="reps" value="${lastR}" style="width: 60px;" />
      <input data-weight-for="${r.id}" inputmode="decimal" placeholder="+kg" value="${prefillW}" style="width: 60px;" />
      <select data-weight-unit-for="${r.id}" style="display:none;"><option value="kg" selected>kg</option></select>
      ` : `
      <input data-weight-for="${r.id}" inputmode="decimal" placeholder="weight" value="${prefillW}" style="width: 60px;" />
      <select data-weight-unit-for="${r.id}" style="width: 56px;">
        <option value="kg" ${lastUnit === "kg" ? "selected" : ""}>kg</option>
        <option value="lbs" ${lastUnit === "lbs" ? "selected" : ""}>lbs</option>
      </select>
      <input data-reps-for="${r.id}" inputmode="numeric" placeholder="reps" value="${lastR}" style="width: 60px;" />
      `}

      ${setBtns}

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
              if (s.reps != null && !(Number(s.weight) > 0) && (isBW || s.weight != null)) return `${sideTag}${s.reps} reps`;
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
            return parts.join(" · ");
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

      // Plan + last session, always visible: what to aim for today.
      const doneSets = Math.ceil((r.sets || []).reduce((t, s) => t + (s.side ? 0.5 : 1), 0));
      const planBits = [];
      if (plan) {
        planBits.push(`<strong>${doneSets}/${plan.sets}</strong> sets`);
        if (plan.reps) planBits.push(`${esc(String(plan.reps))} reps`);
        if (plan.weight_kg && !r.lastSet) planBits.push(`start ~${plan.weight_kg}kg`);
      }
      const planLine = planBits.length ? `<div class="plan-line">🎯 ${planBits.join(" · ")}</div>` : "";
      const lastLine = (r.lastSessionSets && r.lastSessionSets.length)
        ? `<div class="last-line">Last time: ${lastSessionSetsHtml}</div>`
        : "";

      const typeOpts = Object.entries(MEASUREMENT_LABELS)
        .map(([k, l]) => `<option value="${k}" ${k === (r.measurement_type || "weight_reps") ? "selected" : ""}>${l}</option>`)
        .join("");
      const optionsPanel = `
        <div class="ex-options" data-ex-options="${r.id}" style="display:none;">
          <label class="switch-row"><span>Log each side (L / R)</span>
            <input type="checkbox" data-opt-uni data-name="${esc(r.exercise_name)}" ${r.is_unilateral ? "checked" : ""}/></label>
          <label class="field-row"><span>What you record</span>
            <select data-opt-type data-name="${esc(r.exercise_name)}">${typeOpts}</select></label>
          <div class="row" style="margin-top:10px;">
            <button class="linkbtn tiny" data-action="open-stats" data-name="${esc(r.exercise_name)}">📈 History &amp; stats</button>
            <button class="danger tiny" data-action="delete-exercise" data-seid="${r.id}" data-sets="${(r.sets || []).length}">Remove from session</button>
          </div>
        </div>`;

      return `<div class="exercise-item">
        <div class="exercise-header">
          <div>
            <strong>${r.exercise_name}</strong>
            ${note}
          </div>
          <div class="exercise-header-actions">
            ${pbBadge}
            <button class="linkbtn tiny icon-btn" data-action="toggle-options" data-seid="${r.id}" aria-label="Exercise options">⋯</button>
          </div>
        </div>
        ${planLine}
        ${lastLine}
        ${optionsPanel}
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

    if (action === "toggle-options") {
      const seid = btn.getAttribute("data-seid");
      const panel = container.querySelector(`[data-ex-options="${seid}"]`);
      if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
      return;
    }

    if (action === "open-stats") {
      await openLibraryExercise(btn.getAttribute("data-name"), {
        from: container.id === "history-exercises" ? "history" : "session",
      });
      return;
    }

    if (action === "time-it") {
      // Start the stopwatch already linked to this exercise.
      const seid = Number(btn.getAttribute("data-seid"));
      const wEl = container.querySelector(`input[data-weight-for="${seid}"]`);
      const uEl = container.querySelector(`select[data-weight-unit-for="${seid}"]`);
      const wRaw = (wEl?.value ?? "").trim();
      resetStopwatch();
      swTarget = {
        seid,
        name: btn.getAttribute("data-name"),
        weight: wRaw === "" || !Number.isFinite(Number(wRaw)) ? null : Number(wRaw),
        unit: uEl?.value || "kg",
      };
      toggleStopwatch();
      showView("timer");
      return;
    }

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
      startRestTimer(restBySeid.get(sessionExerciseId));

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
      startRestTimer(restBySeid.get(sessionExerciseId));

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
      startRestTimer(restBySeid.get(sessionExerciseId));
      await renderSelectedSessionExercises(sessionId, container);
      return;
    }

    if (action === "add-weight-time-set") {
      // Weighted hold (item 4): store BOTH load and duration in one set.
      const sessionExerciseId = Number(btn.getAttribute("data-seid"));
      const wEl = container.querySelector(`input[data-weight-for="${sessionExerciseId}"]`);
      const uEl = container.querySelector(`select[data-weight-unit-for="${sessionExerciseId}"]`);
      const dEl = container.querySelector(`input[data-duration-for="${sessionExerciseId}"]`);

      const weightRaw = (wEl?.value ?? "").trim();
      const durationRaw = (dEl?.value ?? "").trim();

      const weight = weightRaw === "" ? null : Number(weightRaw);
      const durationSec = durationRaw === "" ? null : Number(durationRaw);

      if (weightRaw !== "" && (!Number.isFinite(weight) || weight < 0)) {
        logLine("⚠️ Invalid weight value.");
        return;
      }
      if (durationRaw !== "" && (!Number.isFinite(durationSec) || durationSec < 0)) {
        logLine("⚠️ Invalid seconds value.");
        return;
      }

      await insertSet({
        sessionExerciseId,
        weight,
        weight_unit: weight === null ? null : (uEl?.value || "kg"),
        duration_sec: durationSec,
        reps: null,
        distance_m: null,
        assisted: 0,
        notes: null
      });

      if (dEl) dEl.value = "";

      lastActiveSessionExerciseId = sessionExerciseId;
      startRestTimer(restBySeid.get(sessionExerciseId));
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
        startRestTimer(restBySeid.get(sessionExerciseId));

        await renderSelectedSessionExercises(sessionId, container);
      } catch (e) {
        logLine("❌ repeat-set failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    }

    if (action === "delete-exercise") {
      try {
        const sessionExerciseId = Number(btn.getAttribute("data-seid"));
        const n = Number(btn.getAttribute("data-sets") || 0);
        if (n > 0 && !window.confirm(`Remove this exercise and its ${n} logged set${n === 1 ? "" : "s"} from the session?`)) return;

        await deleteSessionExercise(sessionExerciseId);

        logLine("✅ Removed exercise from session_exercises:", { sessionExerciseId });
        await renderSelectedSessionExercises(sessionId, container);
      } catch (e) {
        logLine("❌ delete-exercise failed:", String(e));
        if (e?.stack) logLine(e.stack);
      }
    }

  };

  // Per-exercise options (each side / what you record) changed in place.
  container.onchange = async (ev) => {
    const t = ev.target;
    const name = t.getAttribute?.("data-name");
    if (!name) return;
    if (t.hasAttribute("data-opt-uni")) {
      await updateExerciseSettings(name, { is_unilateral: t.checked ? 1 : 0 });
    } else if (t.hasAttribute("data-opt-type")) {
      await updateExerciseSettings(name, { measurement_type: t.value });
    } else {
      return;
    }
    libraryGroups = null;
    await renderSelectedSessionExercises(sessionId, container);
  };
}

/* --------------------------------------------------
   Starting sessions + "next up" suggestion
-------------------------------------------------- */
async function startSession(focus, { date = todayISO(), notes = "" } = {}) {
  const id = await createSession({ date, focus, notes });
  selectedSessionId = id;
  lastActiveSessionExerciseId = null;
  await preloadTemplateExercises(id, focus, logLine);
  setSelectedSessionUI(await getSessionDetail(id));
  await renderSelectedSessionExercises(id);
  await updateLiveDot();
  showView("session");
  window.scrollTo(0, 0);
  await refreshSessionsList();
  return id;
}

const SPLITS = [
  ["fourday_back", "fourday_push", "fourday_lower", "fourday_pull"],
  ["upper_a", "lower_a", "push", "pull", "lower_b"],
];

// One-tap start for the next day of whichever split was trained last.
async function renderNextUp() {
  const el = document.getElementById("next-up");
  if (!el) return;
  el.style.display = "none";
  if (await getActiveSessionId()) return;
  const recent = (await listSessions(30)).filter((s) => s.status === "finished");
  const last = recent.find((s) => SPLITS.some((sp) => sp.includes(s.focus)));
  if (!last) return;
  const split = SPLITS.find((sp) => sp.includes(last.focus));
  const next = split[(split.indexOf(last.focus) + 1) % split.length];
  el.innerHTML = `
    <h2>Next up</h2>
    <button id="btn-next-up" class="big-start">▶ Start ${esc(focusLabel(next))}</button>
    <div class="muted" style="margin-top:8px;">Last was ${esc(focusLabel(last.focus))} on ${esc(fmtDate(last.date))}. Pick something else below.</div>`;
  el.style.display = "block";
  document.getElementById("btn-next-up")?.addEventListener("click", async () => {
    try {
      await startSession(next);
    } catch (e) {
      logLine("❌ Start session failed:", String(e));
    }
  });
}

async function refreshBackupStatus() {
  const el = document.getElementById("backup-status");
  if (el) el.textContent = await lastBackupText();
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

    await loadVideoIndex();
    await initDb(logLine);

    try {
      await seedExercisesFromCsv(logLine);
      const ex = await listExercises(5);
      logLine("✅ Sample exercises:", ex.map(x => x.name));
    } catch (e) {
      logLine("⚠️ Exercise seed/list failed (non-fatal):", String(e));
    }

    // Measurement types are now applied declaratively inside initDb via
    // applyMeasurementTypes() (MEASUREMENT_TYPES map) — the old single
    // hardcoded "Bike" correction missed real logged variants like
    // "Bike warm-up" (item 6).

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

        await startSession(focus, { date, notes });
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

    // ---------------------------
    // Custom session builder (items 7 & 8)
    // ---------------------------
    const addBuilderExercise = () => {
      const input = document.getElementById("custom-tpl-exercise");
      const name = (input?.value ?? "").trim();
      if (!name) return;
      customBuilderExercises.push(name);
      if (input) input.value = "";
      renderCustomBuilderChips();
    };

    document.getElementById("btn-custom-add-exercise")?.addEventListener("click", addBuilderExercise);
    document.getElementById("custom-tpl-exercise")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addBuilderExercise();
      }
    });

    document.getElementById("btn-custom-save")?.addEventListener("click", async () => {
      try {
        const nameEl = document.getElementById("custom-tpl-name");
        const name = (nameEl?.value ?? "").trim();
        if (!name) {
          logLine("⚠️ Name your custom session first.");
          return;
        }
        if (!customBuilderExercises.length) {
          logLine("⚠️ Add at least one exercise.");
          return;
        }
        await createCustomTemplate(name, customBuilderExercises.slice(), logLine);
        // Reset the draft.
        customBuilderExercises = [];
        if (nameEl) nameEl.value = "";
        renderCustomBuilderChips();
        await refreshCustomSessions();
        logLine(`✅ Saved custom session "${name}"`);
      } catch (e) {
        logLine("❌ Save custom session failed:", String(e));
      }
    });

    // Import a shared template file → save as a custom session.
    const importInput = document.getElementById("import-file-input");
    document.getElementById("btn-import-template")?.addEventListener("click", () => {
      importInput?.click();
    });
    importInput?.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await importTemplateFromText(text, { log: logLine });
        await refreshCustomSessions();
        logLine(`✅ Imported "${res.name}"`);
      } catch (e) {
        logLine("❌ Import failed:", String(e));
        window.alert(`Import failed: ${e.message || e}`);
      } finally {
        importInput.value = "";
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
        // Automatic backup — runs in the background, never blocks finishing.
        runBackup({ log: logLine }).then(refreshBackupStatus);

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
        if (name === "dashboard") await renderStatsDashboard(document.getElementById("dashboard-content"));
        if (name === "history") await refreshSessionsList();
        if (name === "library") { libraryReturnView = null; showLibraryList(); await renderLibrary(); }
        if (name === "timer") await renderStopwatchSave();
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

    // Back from library exercise detail → return to library list.
    document.getElementById("btn-library-back")?.addEventListener("click", async () => {
      if (libraryReturnView) {
        const v = libraryReturnView;
        libraryReturnView = null;
        if (v === "dashboard") await renderStatsDashboard(document.getElementById("dashboard-content"));
        showView(v);
        return;
      }
      showLibraryList();
      await renderLibrary();
    });

    // Library: search + filter are wired once; only the rows re-render.
    document.getElementById("library-search")?.addEventListener("input", () => renderLibrary({ reload: false }));
    document.getElementById("library-show-all")?.addEventListener("change", () => renderLibrary({ reload: false }));
    document.getElementById("library-rows")?.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-library-exercise]");
      if (row) openLibraryExercise(row.getAttribute("data-library-exercise"));
    });

    configureStats({
      focusLabel,
      resolveVideoUrl,
      openExercise: (name) => openLibraryExercise(name, {
        from: document.getElementById("view-dashboard")?.style.display !== "none" ? "dashboard" : libraryReturnView,
      }),
      onExerciseChanged: async () => {
        libraryGroups = null;
        if (selectedSessionId) await renderSelectedSessionExercises(selectedSessionId);
      },
    });

    // ---------------------------
    // Backup & settings
    // ---------------------------
    restDefaultSec = Number(await getSetting("rest_default_sec", REST_TIMER_DEFAULT_SEC)) || REST_TIMER_DEFAULT_SEC;
    const restInput = document.getElementById("set-rest-default");
    if (restInput) {
      restInput.value = restDefaultSec;
      restInput.addEventListener("change", async () => {
        const v = Math.max(10, Number(restInput.value) || REST_TIMER_DEFAULT_SEC);
        restDefaultSec = v;
        restInput.value = v;
        await setSetting("rest_default_sec", v);
      });
    }
    await refreshBackupStatus();
    document.getElementById("btn-backup-now")?.addEventListener("click", async () => {
      const st = document.getElementById("backup-status");
      if (st) st.textContent = "Backing up…";
      await runBackup({ log: logLine });
      await refreshBackupStatus();
    });
    const ghRepo = document.getElementById("set-gh-repo");
    const ghToken = document.getElementById("set-gh-token");
    if (ghRepo) ghRepo.value = await getSetting("gh_repo", "");
    if (ghToken && (await getSetting("gh_token", ""))) ghToken.placeholder = "saved — leave blank to keep";
    document.getElementById("btn-gh-save")?.addEventListener("click", async () => {
      await setSetting("gh_repo", (ghRepo?.value ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""));
      const tok = (ghToken?.value ?? "").trim();
      if (tok) await setSetting("gh_token", tok);
      if (ghToken) { ghToken.value = ""; ghToken.placeholder = "saved — leave blank to keep"; }
      const st = document.getElementById("backup-status");
      if (st) st.textContent = "Saved. Testing with a backup now…";
      await runBackup({ log: logLine });
      await refreshBackupStatus();
    });
    document.getElementById("btn-gh-clear")?.addEventListener("click", async () => {
      await setSetting("gh_repo", "");
      await setSetting("gh_token", "");
      if (ghRepo) ghRepo.value = "";
      if (ghToken) { ghToken.value = ""; ghToken.placeholder = "paste token"; }
      await refreshBackupStatus();
    });
    const restoreInput = document.getElementById("restore-file-input");
    document.getElementById("btn-restore")?.addEventListener("click", () => restoreInput?.click());
    restoreInput?.addEventListener("change", async () => {
      const file = restoreInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        if (!window.confirm("Replace EVERYTHING in the app with this backup? Sessions logged since that backup will be lost.")) return;
        const res = await restoreFromText(text, { log: logLine });
        window.alert(`Restored ${res.sessions} sessions and ${res.sets} sets. The app will reload.`);
        window.location.reload();
      } catch (e) {
        logLine("❌ Restore failed:", String(e));
        window.alert(`Restore failed: ${e.message || e}`);
      } finally {
        restoreInput.value = "";
      }
    });

    // Load custom-template name cache before rendering any session header
    // (so a custom active session shows its real name, not "custom:<id>").
    await refreshCustomSessions();

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
    // Add exercise to the session: type to search, tap a result to add
    // it straight away. "Add" adds whatever is typed (a new exercise).
    // -----------------------------
    const exerciseInput = document.getElementById("exercise-name");
    const listDiv = document.getElementById("exercise-picker-list");

    const addExerciseByName = async (rawName) => {
      const name = String(rawName || "").trim();
      if (!name) return;
      if (!selectedSessionId) {
        logLine("⚠️ No active session");
        return;
      }
      await addExerciseToSession(selectedSessionId, name, null);
      libraryGroups = null;
      if (exerciseInput) exerciseInput.value = "";
      if (listDiv) listDiv.style.display = "none";
      await renderSelectedSessionExercises(selectedSessionId);
      logLine("🟦 Exercise added:", name);
    };

    if (exerciseInput && listDiv) {
      let catalogue = null; // loaded once per focus so typing stays instant
      exerciseInput.addEventListener("focus", async () => {
        catalogue = await listExercises(2000);
      });
      exerciseInput.addEventListener("input", async () => {
        const q = exerciseInput.value.trim().toLowerCase();
        if (!q) {
          listDiv.style.display = "none";
          return;
        }
        if (!catalogue) catalogue = await listExercises(2000);
        const starts = catalogue.filter((e) => e.name.toLowerCase().startsWith(q));
        const contains = catalogue.filter((e) => !e.name.toLowerCase().startsWith(q) && e.name.toLowerCase().includes(q));
        const hits = [...starts, ...contains].slice(0, 10);
        if (!hits.length) {
          listDiv.style.display = "none";
          return;
        }
        listDiv.innerHTML = hits
          .map((e) => `<button type="button" data-name="${esc(e.name)}" class="search-item">${esc(e.name)}</button>`)
          .join("");
        listDiv.style.display = "block";
      });
      listDiv.addEventListener("click", (ev) => {
        const b = ev.target.closest("button[data-name]");
        if (b) addExerciseByName(b.getAttribute("data-name"));
      });
      exerciseInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          addExerciseByName(exerciseInput.value);
        }
      });
      document.addEventListener("click", (ev) => {
        if (!exerciseInput.contains(ev.target) && !listDiv.contains(ev.target)) {
          listDiv.style.display = "none";
        }
      });
    }
    document.getElementById("btn-add-exercise")?.addEventListener("click", () => addExerciseByName(exerciseInput?.value));
  } catch (e) {
    logLine("❌ safeStart crashed:", String(e));
    if (e?.stack) logLine(e.stack);
  }
}

safeStart();

// Dev-only hook (stripped from production builds) for loading test data
// in the browser preview.
if (import.meta.env?.DEV) window.__gymDev = { restoreFromText, runBackup };
