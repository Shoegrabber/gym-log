// Stats: dashboard tiles, per-exercise pages, comparisons.
//
// Everything is computed in memory from db.getAllSetRows() (a few thousand
// rows), so adding a new statistic means adding a function here, not SQL.
//
// EXTENDING (future health modules such as body weight, sleep, food):
//   1. Log values into the daily_metrics table (see db.js).
//   2. Add a tile object to TILES below — { id, title, render(ctx) }.
//      It then appears in the Stats tab and in "Customise" automatically.

import {
  getAllSetRows,
  listAllSessions,
  listExercises,
  getSetting,
  setSetting,
  getExercise,
  updateExerciseSettings,
  mergeExerciseName,
} from "./db.js";
import {
  MUSCLE_GROUPS,
  TRAINING_GROUPS,
  inferMuscleGroup,
  MEASUREMENT_LABELS,
} from "./muscles.js";
import { LIBRARY_CONTENT } from "./library-content.js";

// Chart series colours (validated for the dark card surface #1e293b).
const SERIES = ["#6d70f3", "#b87d15"];
const DAY = 86400000;
const VW = 340; // chart viewBox width

let hooks = {
  focusLabel: (f) => f || "",
  resolveVideoUrl: () => null,
  openExercise: () => {},
  onExerciseChanged: () => {},
};
export function configureStats(h) {
  hooks = { ...hooks, ...h };
}

/* ---------------- small helpers ---------------- */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const toKg = (w, unit) => (w == null ? null : unit === "lbs" ? Number(w) * 0.45359237 : Number(w));

// Epley estimate. A single is its own 1RM; very high-rep sets are a poor
// predictor, so they are capped rather than allowed to invent big numbers.
export function e1rm(kg, reps) {
  if (!(kg > 0) || !(reps >= 1)) return null;
  if (reps === 1) return kg;
  return kg * (1 + Math.min(reps, 15) / 30);
}

export function fmtNum(v, dp = 1) {
  if (v == null || !Number.isFinite(v)) return "–";
  const r = Math.round(v * 10 ** dp) / 10 ** dp;
  return Math.abs(r) >= 1000 ? Math.round(r).toLocaleString() : String(r);
}
const fmtKg = (v) => `${fmtNum(v)}kg`;

export function fmtDur(sec) {
  if (sec == null) return "–";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const parseDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso, withYear = false) {
  const d = iso instanceof Date ? iso : parseDate(iso);
  const yr = withYear || d.getFullYear() !== new Date().getFullYear() ? ` ${String(d.getFullYear()).slice(2)}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${yr}`;
}
const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function weekStart(dateOrIso) {
  const d = dateOrIso instanceof Date ? new Date(dateOrIso) : parseDate(dateOrIso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  d.setHours(0, 0, 0, 0);
  return d;
}

/* ---------------- data ---------------- */

async function loadData() {
  const rows = await getAllSetRows();
  const sessions = await listAllSessions();
  const exercises = await listExercises(2000);
  const exByKey = new Map(exercises.map((e) => [e.name.toLowerCase(), e]));

  const sets = rows.map((r) => {
    const ex = exByKey.get(String(r.exercise_name).toLowerCase());
    const kg = toKg(r.weight, r.weight_unit);
    const reps = r.reps == null ? null : Number(r.reps);
    return {
      id: r.id,
      name: ex?.name ?? r.exercise_name,
      key: String(r.exercise_name).toLowerCase(),
      group: ex?.muscle_group || inferMuscleGroup(r.exercise_name),
      type: ex?.measurement_type || "weight_reps",
      sessionId: r.session_id,
      date: r.date,
      focus: r.focus,
      kg,
      reps,
      side: r.side || null,
      dur: r.duration_sec == null ? null : Number(r.duration_sec),
      dist: r.distance_m == null ? null : Number(r.distance_m),
      e1: e1rm(kg, reps),
      vol: kg != null && reps != null ? kg * reps : 0,
      // An L and an R set together make one "set" of a one-sided exercise.
      setCount: r.side ? 0.5 : 1,
    };
  });
  return { sets, sessions, exercises, exByKey };
}

function setText(s) {
  const side = s.side ? `${s.side} ` : "";
  if (s.dur != null && s.kg != null && s.kg > 0) return `${side}${fmtKg(s.kg)} × ${fmtDur(s.dur)}`;
  if (s.dur != null) return `${side}${fmtDur(s.dur)}${s.dist ? `, ${s.dist}m` : ""}`;
  if (s.kg != null && s.kg > 0 && s.reps != null) return `${side}${fmtNum(s.kg)}×${s.reps}`;
  if (s.reps != null) return `${side}${s.reps} reps`;
  if (s.kg != null) return `${side}${fmtKg(s.kg)}`;
  return "–";
}

// Group one exercise's sets into per-session summaries, oldest first.
function bySession(sets) {
  const map = new Map();
  for (const s of sets) {
    let a = map.get(s.sessionId);
    if (!a) {
      a = { sessionId: s.sessionId, date: s.date, focus: s.focus, sets: [], top: null, bestE1: null, volume: 0, maxReps: null, totalReps: 0, maxDur: null, totalDur: 0 };
      map.set(s.sessionId, a);
    }
    a.sets.push(s);
    if (s.kg != null && s.kg > 0 && (!a.top || s.kg > a.top.kg || (s.kg === a.top.kg && (s.reps ?? 0) > (a.top.reps ?? 0)))) a.top = s;
    if (s.e1 != null && (!a.bestE1 || s.e1 > a.bestE1.e1)) a.bestE1 = s;
    a.volume += s.vol;
    if (s.reps != null) {
      a.totalReps += s.reps;
      if (!a.maxReps || s.reps > a.maxReps.reps) a.maxReps = s;
    }
    if (s.dur != null) {
      a.totalDur += s.dur;
      if (!a.maxDur || s.dur > a.maxDur.dur) a.maxDur = s;
    }
  }
  return [...map.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.sessionId - y.sessionId));
}

const METRICS = {
  e1: { label: "Est. 1RM", unit: "kg", get: (a) => a.bestE1?.e1 ?? null },
  top: { label: "Top weight", unit: "kg", get: (a) => a.top?.kg ?? null },
  vol: { label: "Volume", unit: "kg", get: (a) => (a.volume > 0 ? a.volume : null) },
  reps: { label: "Best reps", unit: "reps", get: (a) => a.maxReps?.reps ?? null },
  totalReps: { label: "Total reps", unit: "reps", get: (a) => (a.totalReps > 0 ? a.totalReps : null) },
  dur: { label: "Longest", unit: "time", get: (a) => a.maxDur?.dur ?? null },
  totalDur: { label: "Total time", unit: "time", get: (a) => (a.totalDur > 0 ? a.totalDur : null) },
};
function metricsFor(type) {
  if (type === "bodyweight") return ["reps", "totalReps", "top"];
  if (type === "time_only" || type === "cardio") return ["dur", "totalDur"];
  if (type === "weight_time") return ["dur", "top", "totalDur"];
  return ["e1", "top", "vol", "reps"];
}
const fmtMetric = (m, v) => (METRICS[m].unit === "time" ? fmtDur(v) : METRICS[m].unit === "kg" ? fmtKg(v) : `${fmtNum(v)} reps`);

/* ---------------- charts (inline SVG, no library) ---------------- */

const pending = new Map();
let chartSeq = 0;
function chartBox(svg, hit, label) {
  const id = `c${++chartSeq}`;
  pending.set(id, hit);
  return `<div class="chart" data-chart="${id}" role="img" aria-label="${esc(label)}">${svg}<div class="chart-tip" hidden></div></div>`;
}

// Attach hover / touch tooltips to charts just written into `root`.
export function wireCharts(root) {
  root.querySelectorAll(".chart[data-chart]").forEach((el) => {
    const hit = pending.get(el.dataset.chart);
    pending.delete(el.dataset.chart);
    if (!hit) return;
    const svg = el.querySelector("svg");
    const tip = el.querySelector(".chart-tip");
    const cross = svg.querySelector(".crosshair");
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const h = hit(((ev.clientX - r.left) / r.width) * VW);
      if (!h) return;
      tip.innerHTML = h.html;
      tip.hidden = false;
      const px = (h.x / VW) * r.width;
      tip.style.left = `${Math.min(Math.max(px, 74), r.width - 74)}px`;
      if (cross) {
        cross.setAttribute("x1", h.x);
        cross.setAttribute("x2", h.x);
        cross.style.display = "";
      }
    };
    const hide = () => {
      tip.hidden = true;
      if (cross) cross.style.display = "none";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", move);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointercancel", hide);
  });
}

const emptyChart = (msg) => `<div class="muted chart-empty">${esc(msg)}</div>`;

// series: [{ name, color, points: [{ t (ms), y, date }] }]
function lineChart({ series, fmt, label }) {
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return emptyChart(all.length ? "Only one session so far — the chart starts at two." : "No data yet.");
  const H = 170, L = 40, R = 12, T = 12, B = 24;
  let t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  if (t0 === t1) { t0 -= DAY; t1 += DAY; }
  let lo = Math.min(...all.map((p) => p.y)), hi = Math.max(...all.map((p) => p.y));
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  const y0 = lo >= 0 ? Math.max(0, lo - pad) : lo - pad, y1 = hi + pad;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (VW - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

  let g = "";
  for (const f of [0, 0.5, 1]) {
    const v = y0 + (y1 - y0) * f;
    g += `<line x1="${L}" x2="${VW - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/>`;
    g += `<text x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end" class="axis">${esc(fmt(v, true))}</text>`;
  }
  g += `<text x="${L}" y="${H - 6}" text-anchor="start" class="axis">${esc(fmtDate(new Date(t0), true))}</text>`;
  g += `<text x="${VW - R}" y="${H - 6}" text-anchor="end" class="axis">${esc(fmtDate(new Date(t1), true))}</text>`;
  g += `<line class="crosshair" y1="${T}" y2="${H - B}" style="display:none"/>`;

  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const dots = s.points.length <= 24 ? s.points : [s.points[s.points.length - 1]];
    for (const p of dots) g += `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4" fill="${s.color}" class="dot"/>`;
  }
  const svg = `<svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;

  const hit = (xv) => {
    const t = t0 + ((xv - L) / (VW - L - R)) * (t1 - t0);
    let best = null;
    for (const s of series) for (const p of s.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (!best) return null;
    const lines = series
      .map((s) => {
        const p = s.points.reduce((a, b) => (!a || Math.abs(b.t - best.t) < Math.abs(a.t - best.t) ? b : a), null);
        if (!p || Math.abs(p.t - best.t) > 10 * DAY) return "";
        return `<div><span class="swatch" style="background:${s.color}"></span>${series.length > 1 ? `${esc(s.name)}: ` : ""}<strong>${esc(fmt(p.y))}</strong>${p.note ? ` <span class="tip-note">${esc(p.note)}</span>` : ""}</div>`;
      })
      .join("");
    return { x: X(best.t), html: `<div class="tip-date">${esc(fmtDate(new Date(best.t), true))}</div>${lines}` };
  };
  return chartBox(svg, hit, label);
}

// items: [{ label, value, tip }]
function columnChart({ items, fmt, label, color = SERIES[0] }) {
  if (!items.length || items.every((i) => !i.value)) return emptyChart("No data yet.");
  const H = 150, L = 40, R = 6, T = 10, B = 24;
  const hi = Math.max(...items.map((i) => i.value)) || 1;
  const step = (VW - L - R) / items.length;
  const bw = Math.max(4, step - 2); // 2px surface gap between bars
  const Y = (v) => T + (1 - v / hi) * (H - T - B);
  let g = "";
  for (const f of [0, 0.5, 1]) {
    g += `<line x1="${L}" x2="${VW - R}" y1="${Y(hi * f)}" y2="${Y(hi * f)}" class="grid"/>`;
    g += `<text x="${L - 6}" y="${Y(hi * f) + 3.5}" text-anchor="end" class="axis">${esc(fmt(hi * f, true))}</text>`;
  }
  items.forEach((it, i) => {
    const x = L + i * step + (step - bw) / 2;
    const h = Math.max(it.value > 0 ? 2 : 0, H - B - Y(it.value));
    const r = Math.min(4, bw / 2, h);
    if (h > 0) {
      g += `<path d="M${x},${H - B} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z" fill="${color}" data-bar="${i}"/>`;
    }
  });
  g += `<text x="${L}" y="${H - 6}" text-anchor="start" class="axis">${esc(items[0].label)}</text>`;
  g += `<text x="${VW - R}" y="${H - 6}" text-anchor="end" class="axis">${esc(items[items.length - 1].label)}</text>`;
  const svg = `<svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  const hit = (xv) => {
    const i = Math.min(items.length - 1, Math.max(0, Math.floor((xv - L) / step)));
    const it = items[i];
    return { x: L + i * step + step / 2, html: `<div class="tip-date">${esc(it.tip || it.label)}</div><div><strong>${esc(fmt(it.value))}</strong></div>` };
  };
  return chartBox(svg, hit, label);
}

const chips = (name, options, current) =>
  `<div class="chips">${options
    .map(([v, l]) => `<button class="chip ${String(v) === String(current) ? "on" : ""}" data-${name}="${esc(v)}">${esc(l)}</button>`)
    .join("")}</div>`;

const setsLabel = (n) => `${fmtNum(n, 0)} set${Math.round(n) === 1 ? "" : "s"}`;
const exLink = (name) => `<a class="exlink" data-open-exercise="${esc(name)}">${esc(name)}</a>`;

/* ---------------- dashboard ---------------- */

const ui = {
  range: "all",
  muscleWeek: 0,
  cmpA: null,
  cmpB: null,
  cmpMetric: "pct",
  sessA: null,
  sessB: null,
  customising: false,
};

function rangeStartISO() {
  if (ui.range === "all") return "0000-00-00";
  const d = new Date();
  d.setMonth(d.getMonth() - Number(ui.range));
  return isoOf(d);
}

function weeklyBuckets(ctx, weeks) {
  // Last `weeks` Monday-weeks ending with the current one.
  const cur = weekStart(new Date());
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(cur);
    d.setDate(d.getDate() - i * 7);
    out.push({ start: isoOf(d), label: fmtDate(d, true), sessions: new Set(), volume: 0, sets: 0 });
  }
  const idx = new Map(out.map((b, i) => [b.start, i]));
  for (const s of ctx.sets) {
    const b = out[idx.get(isoOf(weekStart(s.date)))];
    if (!b) continue;
    b.sessions.add(s.sessionId);
    b.volume += s.vol;
    b.sets += s.setCount;
  }
  return out;
}

function weeksInRange(ctx) {
  if (ui.range !== "all") return Math.round((Number(ui.range) * 30.4) / 7);
  const first = ctx.sets[0]?.date;
  if (!first) return 12;
  return Math.min(104, Math.max(8, Math.ceil((weekStart(new Date()) - weekStart(first)) / (7 * DAY)) + 1));
}

const TILES = [
  {
    id: "week",
    title: "This week",
    render(ctx) {
      const b = weeklyBuckets(ctx, 2);
      const [last, cur] = b;
      let delta = "";
      if (last.volume > 0) {
        const pct = Math.round(((cur.volume - last.volume) / last.volume) * 100);
        delta = pct > 0 ? `▲ ${pct}% on last week` : pct < 0 ? `▼ ${Math.abs(pct)}% on last week` : "same as last week";
      }
      const lastDate = ctx.sets[ctx.sets.length - 1]?.date;
      const days = lastDate ? Math.round((weekStartless(new Date()) - parseDate(lastDate)) / DAY) : null;
      const stat = (n, l) => `<div class="stat"><div class="stat-num">${n}</div><div class="stat-label">${l}</div></div>`;
      return `<div class="dash-grid">
          ${stat(cur.sessions.size, "sessions")}
          ${stat(`${Math.round(cur.volume).toLocaleString()}<span class="stat-unit">kg</span>`, "volume")}
        </div>
        <div class="dash-grid" style="margin-top:10px;">
          ${stat(fmtNum(cur.sets, 0), "sets")}
          ${stat(days == null ? "–" : days === 0 ? "today" : `${days}<span class="stat-unit">d</span>`, "since last session")}
        </div>
        ${delta ? `<div class="muted" style="margin-top:10px;">Volume ${delta}.</div>` : ""}`;
    },
  },
  {
    id: "muscles",
    title: "Sets per muscle group",
    render(ctx) {
      const cur = weekStart(new Date());
      cur.setDate(cur.getDate() - ui.muscleWeek * 7);
      const startISO = isoOf(cur);
      const end = new Date(cur); end.setDate(end.getDate() + 7);
      const endISO = isoOf(end);
      const avgStart = new Date(cur); avgStart.setDate(avgStart.getDate() - 28);
      const avgISO = isoOf(avgStart);
      const now = Object.fromEntries(TRAINING_GROUPS.map((g) => [g, 0]));
      const avg = { ...now };
      for (const s of ctx.sets) {
        if (!(s.group in now)) continue;
        if (s.date >= startISO && s.date < endISO) now[s.group] += s.setCount;
        else if (s.date >= avgISO && s.date < startISO) avg[s.group] += s.setCount / 4;
      }
      const max = Math.max(1, ...TRAINING_GROUPS.map((g) => Math.max(now[g], avg[g])));
      const rows = TRAINING_GROUPS.map((g) => {
        const w = (now[g] / max) * 100, a = (avg[g] / max) * 100;
        return `<div class="hbar-row">
            <div class="hbar-label">${g}</div>
            <div class="hbar-track">
              ${now[g] > 0 ? `<div class="hbar-fill" style="width:${w}%"></div>` : ""}
              ${avg[g] > 0 ? `<div class="hbar-mark" style="left:${a}%" title="4-week average"></div>` : ""}
            </div>
            <div class="hbar-val">${fmtNum(now[g], 0)}<span class="muted"> / ${fmtNum(avg[g], 0)}</span></div>
          </div>`;
      }).join("");
      return `${chips("muscle-week", [[0, "This week"], [1, "Last week"]], ui.muscleWeek)}
        <div class="hbars">${rows}</div>
        <div class="muted" style="margin-top:8px;">Sets done / your 4-week average (the tick). A left + right pair counts as one set.</div>`;
    },
  },
  {
    id: "volume",
    title: "Weekly volume",
    render(ctx) {
      const b = weeklyBuckets(ctx, weeksInRange(ctx));
      return columnChart({
        items: b.map((w) => ({ label: w.label, value: Math.round(w.volume), tip: `Week of ${w.label}` })),
        fmt: (v, axis) => (axis ? (v >= 1000 ? `${fmtNum(v / 1000, v >= 10000 ? 0 : 1)}t` : fmtNum(v, 0)) : `${Math.round(v).toLocaleString()} kg`),
        label: "Total weight lifted per week",
      });
    },
  },
  {
    id: "frequency",
    title: "Sessions per week",
    render(ctx) {
      const b = weeklyBuckets(ctx, weeksInRange(ctx));
      return columnChart({
        items: b.map((w) => ({ label: w.label, value: w.sessions.size, tip: `Week of ${w.label}` })),
        fmt: (v, axis) => (axis ? fmtNum(v, 0) : `${v} session${v === 1 ? "" : "s"}`),
        label: "Sessions per week",
      });
    },
  },
  {
    id: "records",
    title: "Recent records",
    render(ctx) {
      const best = new Map();
      const seenSessions = new Map();
      const events = [];
      for (const s of ctx.sets) {
        if (s.e1 == null) continue;
        const prev = best.get(s.key);
        const seen = seenSessions.get(s.key) || new Set();
        seen.add(s.sessionId);
        seenSessions.set(s.key, seen);
        if (prev == null || s.e1 > prev + 0.01) {
          // Ignore the first two sessions of an exercise — everything is a "record" then.
          if (prev != null && seen.size > 2) events.push({ ...s, prev });
          best.set(s.key, s.e1);
        }
      }
      // Keep the best event per exercise per session, newest first.
      const dedup = new Map();
      for (const e of events) dedup.set(`${e.key}|${e.sessionId}`, e);
      const list = [...dedup.values()].reverse().slice(0, 6);
      if (!list.length) return `<div class="muted">No records yet — they appear once a lift beats its previous best.</div>`;
      return `<div class="dash-pbs">${list
        .map((e) => `<div class="pb-row"><span>${exLink(e.name)}<br><span class="muted">${fmtNum(e.kg)}kg × ${e.reps} · ${fmtDate(e.date)}</span></span>
            <span class="badge pb-badge">est. ${fmtKg(e.e1)}</span></div>`)
        .join("")}</div>`;
    },
  },
  {
    id: "movers",
    title: "Most improved",
    render(ctx) {
      const start = rangeStartISO();
      const byEx = new Map();
      for (const s of ctx.sets) {
        if (s.e1 == null || s.date < start) continue;
        if (!byEx.has(s.key)) byEx.set(s.key, []);
        byEx.get(s.key).push(s);
      }
      const rows = [];
      for (const sets of byEx.values()) {
        const ag = bySession(sets).filter((a) => a.bestE1);
        if (ag.length < 6) continue;
        const mean = (xs) => xs.reduce((t, a) => t + a.bestE1.e1, 0) / xs.length;
        const first = mean(ag.slice(0, 3)), last = mean(ag.slice(-3));
        rows.push({ name: sets[0].name, first, last, pct: ((last - first) / first) * 100, n: ag.length });
      }
      rows.sort((a, b) => b.pct - a.pct);
      if (!rows.length) return `<div class="muted">Needs at least 6 sessions of an exercise in this period.</div>`;
      return `<div class="dash-pbs">${rows.slice(0, 6)
        .map((r) => `<div class="pb-row"><span>${exLink(r.name)}<br><span class="muted">est. 1RM ${fmtKg(r.first)} → ${fmtKg(r.last)} · ${r.n} sessions</span></span>
            <span class="dash-delta ${r.pct >= 0 ? "up" : "down"}">${r.pct >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(r.pct))}%</span></div>`)
        .join("")}</div>
        <div class="muted" style="margin-top:8px;">Average of your first three sessions against your latest three.</div>`;
    },
  },
  {
    id: "compare-ex",
    title: "Compare exercises",
    render(ctx) {
      const counts = new Map();
      for (const s of ctx.sets) {
        if (s.e1 == null) continue;
        const c = counts.get(s.key) || { name: s.name, sessions: new Set() };
        c.sessions.add(s.sessionId);
        counts.set(s.key, c);
      }
      const opts = [...counts.entries()].filter(([, c]) => c.sessions.size >= 2).sort((a, b) => b[1].sessions.size - a[1].sessions.size);
      if (opts.length < 2) return `<div class="muted">Needs two exercises with at least two sessions each.</div>`;
      if (!counts.has(ui.cmpA)) ui.cmpA = opts[0][0];
      if (!counts.has(ui.cmpB) || ui.cmpB === ui.cmpA) ui.cmpB = opts.find(([k]) => k !== ui.cmpA)[0];
      const sel = (which, cur) =>
        `<select data-cmp="${which}">${opts
          .slice()
          .sort((a, b) => a[1].name.localeCompare(b[1].name))
          .map(([k, c]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(c.name)}</option>`)
          .join("")}</select>`;
      const start = rangeStartISO();
      const mk = (key, color) => {
        const ag = bySession(ctx.sets.filter((s) => s.key === key && s.date >= start)).filter((a) => a.bestE1);
        const base = ag[0]?.bestE1.e1;
        return {
          name: counts.get(key).name,
          color,
          points: ag.map((a) => ({
            t: parseDate(a.date).getTime(),
            y: ui.cmpMetric === "pct" ? ((a.bestE1.e1 - base) / base) * 100 : a.bestE1.e1,
            note: `${fmtNum(a.bestE1.kg)}×${a.bestE1.reps}`,
          })),
        };
      };
      const series = [mk(ui.cmpA, SERIES[0]), mk(ui.cmpB, SERIES[1])];
      const fmt = ui.cmpMetric === "pct" ? (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%` : (v) => fmtKg(v);
      return `<div class="cmp-pick">
          <div><span class="swatch" style="background:${SERIES[0]}"></span>${sel("A", ui.cmpA)}</div>
          <div><span class="swatch" style="background:${SERIES[1]}"></span>${sel("B", ui.cmpB)}</div>
        </div>
        ${chips("cmp-metric", [["pct", "Change since start"], ["kg", "Est. 1RM (kg)"]], ui.cmpMetric)}
        ${lineChart({ series, fmt, label: `${series[0].name} against ${series[1].name}` })}`;
    },
  },
  {
    id: "compare-sess",
    title: "Compare sessions",
    render(ctx) {
      const done = ctx.sessions.filter((s) => ctx.sets.some((x) => x.sessionId === s.id)).slice().reverse();
      if (done.length < 2) return `<div class="muted">Needs two logged sessions.</div>`;
      const ids = new Set(done.map((s) => String(s.id)));
      if (!ids.has(String(ui.sessA))) ui.sessA = done[0].id;
      if (!ids.has(String(ui.sessB)) || String(ui.sessB) === String(ui.sessA)) {
        const a = done.find((s) => String(s.id) === String(ui.sessA));
        ui.sessB = (done.find((s) => s.id !== a.id && s.focus === a.focus && s.date <= a.date) || done.find((s) => s.id !== a.id)).id;
      }
      const sel = (which, cur) =>
        `<select data-sess="${which}">${done
          .slice(0, 150)
          .map((s) => `<option value="${s.id}" ${String(s.id) === String(cur) ? "selected" : ""}>${esc(fmtDate(s.date, true))} · ${esc(hooks.focusLabel(s.focus))}</option>`)
          .join("")}</select>`;
      const pack = (id) => {
        const sets = ctx.sets.filter((s) => String(s.sessionId) === String(id));
        const byEx = new Map();
        for (const s of sets) {
          if (!byEx.has(s.key)) byEx.set(s.key, { name: s.name, sets: [], volume: 0 });
          const e = byEx.get(s.key);
          e.sets.push(s);
          e.volume += s.vol;
        }
        return { byEx, volume: sets.reduce((t, s) => t + s.vol, 0), sets: sets.reduce((t, s) => t + s.setCount, 0) };
      };
      const A = pack(ui.sessA), B = pack(ui.sessB);
      const bestOf = (e) => {
        if (!e) return "–";
        const top = e.sets.reduce((a, s) => (!a || (s.e1 ?? -1) > (a.e1 ?? -1) || (a.e1 == null && (s.reps ?? s.dur ?? 0) > (a.reps ?? a.dur ?? 0)) ? s : a), null);
        return `${setText({ ...top, side: null })}<span class="muted"> · ${setsLabel(e.sets.reduce((t, s) => t + s.setCount, 0))}</span>`;
      };
      const keys = [...new Set([...A.byEx.keys(), ...B.byEx.keys()])];
      const rows = keys
        .map((k) => {
          const a = A.byEx.get(k), b = B.byEx.get(k);
          let d = "";
          if (a && b && b.volume > 0 && a.volume > 0) {
            const pct = Math.round(((a.volume - b.volume) / b.volume) * 100);
            d = `<span class="dash-delta ${pct > 0 ? "up" : pct < 0 ? "down" : "flat"}">${pct > 0 ? "▲" : pct < 0 ? "▼" : ""}${Math.abs(pct)}%</span>`;
          }
          return `<tr><td>${exLink((a || b).name)}</td><td>${bestOf(a)}</td><td>${bestOf(b)}</td><td>${d}</td></tr>`;
        })
        .join("");
      return `<div class="cmp-pick"><div><span class="cmp-tag">A</span>${sel("A", ui.sessA)}</div><div><span class="cmp-tag">B</span>${sel("B", ui.sessB)}</div></div>
        <div class="table-wrap"><table class="cmp-table">
          <thead><tr><th>Exercise</th><th>A · best set</th><th>B · best set</th><th>Vol.</th></tr></thead>
          <tbody>${rows}
            <tr class="total"><td>Total</td><td>${Math.round(A.volume).toLocaleString()}kg<span class="muted"> · ${setsLabel(A.sets)}</span></td>
            <td>${Math.round(B.volume).toLocaleString()}kg<span class="muted"> · ${setsLabel(B.sets)}</span></td><td></td></tr>
          </tbody></table></div>
        <div class="muted" style="margin-top:8px;">Vol. is A's volume on that exercise against B's.</div>`;
    },
  },
  {
    id: "recent",
    title: "Recent sessions",
    render(ctx) {
      const vol = new Map();
      for (const s of ctx.sets) vol.set(s.sessionId, (vol.get(s.sessionId) || 0) + s.vol);
      const list = ctx.sessions.slice().reverse().slice(0, 6);
      if (!list.length) return `<div class="muted">No sessions yet.</div>`;
      return `<div class="dash-pbs">${list
        .map((s) => `<div class="pb-row"><span>${esc(hooks.focusLabel(s.focus))} <span class="muted">— ${fmtDate(s.date)}</span></span>
            <span class="muted">${Math.round(vol.get(s.id) || 0).toLocaleString()} kg</span></div>`)
        .join("")}</div>`;
    },
  },
];

function weekStartless(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

async function tileConfig() {
  let saved = null;
  try {
    saved = JSON.parse(await getSetting("dash_tiles", "null"));
  } catch (_) { /* fall through to defaults */ }
  const known = TILES.map((t) => t.id);
  if (!saved || !Array.isArray(saved.order)) return { order: known, hidden: [] };
  const order = saved.order.filter((id) => known.includes(id));
  for (const id of known) if (!order.includes(id)) order.push(id); // new tiles appear automatically
  return { order, hidden: (saved.hidden || []).filter((id) => known.includes(id)) };
}

let dashCtx = null;
let dashCfg = null;

export async function renderDashboard(el, { reload = true } = {}) {
  if (!el) return;
  if (reload || !dashCtx) {
    dashCtx = await loadData();
    dashCfg = await tileConfig();
  }
  const ctx = dashCtx, cfg = dashCfg;
  const byId = new Map(TILES.map((t) => [t.id, t]));

  let body;
  if (ui.customising) {
    body = `<div class="section"><h2>Choose your tiles</h2>${cfg.order
      .map((id, i) => `<div class="tile-opt">
          <label><input type="checkbox" data-tile-toggle="${id}" ${cfg.hidden.includes(id) ? "" : "checked"}/> ${esc(byId.get(id).title)}</label>
          <span><button class="linkbtn tiny" data-tile-move="${id}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">▲</button>
          <button class="linkbtn tiny" data-tile-move="${id}" data-dir="1" ${i === cfg.order.length - 1 ? "disabled" : ""} aria-label="Move down">▼</button></span>
        </div>`)
      .join("")}</div>`;
  } else if (!ctx.sets.length) {
    body = `<div class="section"><div class="muted">No sets logged yet. Stats appear after your first session.</div></div>`;
  } else {
    body = cfg.order
      .filter((id) => !cfg.hidden.includes(id))
      .map((id) => {
        const t = byId.get(id);
        let inner;
        try {
          inner = t.render(ctx);
        } catch (e) {
          inner = `<div class="muted">Couldn't draw this tile (${esc(String(e.message || e))}).</div>`;
        }
        return `<div class="section" data-tile="${id}"><h2>${esc(t.title)}</h2>${inner}</div>`;
      })
      .join("");
  }

  el.innerHTML = `
    <div class="stats-bar">
      ${ui.customising ? "<span></span>" : chips("range", [["3", "3 months"], ["12", "1 year"], ["all", "All time"]], ui.range)}
      <button class="linkbtn tiny" data-customise>${ui.customising ? "Done" : "Customise"}</button>
    </div>
    ${body}`;
  wireCharts(el);

  const again = () => renderDashboard(el, { reload: false });
  const saveCfg = async () => {
    await setSetting("dash_tiles", JSON.stringify(cfg));
    again();
  };
  el.onclick = async (ev) => {
    const t = ev.target.closest("button, a");
    if (!t) return;
    if (t.dataset.openExercise) return hooks.openExercise(t.dataset.openExercise);
    if (t.hasAttribute("data-customise")) { ui.customising = !ui.customising; return again(); }
    if (t.dataset.range) { ui.range = t.dataset.range; return again(); }
    if (t.dataset.muscleWeek != null) { ui.muscleWeek = Number(t.dataset.muscleWeek); return again(); }
    if (t.dataset.cmpMetric) { ui.cmpMetric = t.dataset.cmpMetric; return again(); }
    if (t.dataset.tileMove) {
      const i = cfg.order.indexOf(t.dataset.tileMove), j = i + Number(t.dataset.dir);
      if (j < 0 || j >= cfg.order.length) return;
      [cfg.order[i], cfg.order[j]] = [cfg.order[j], cfg.order[i]];
      return saveCfg();
    }
  };
  el.onchange = async (ev) => {
    const t = ev.target;
    if (t.dataset.cmp) { ui[`cmp${t.dataset.cmp}`] = t.value; return again(); }
    if (t.dataset.sess) { ui[`sess${t.dataset.sess}`] = t.value; return again(); }
    if (t.dataset.tileToggle) {
      const id = t.dataset.tileToggle;
      cfg.hidden = t.checked ? cfg.hidden.filter((x) => x !== id) : [...cfg.hidden, id];
      return saveCfg();
    }
  };
}

/* ---------------- library list ---------------- */

// Returns exercises grouped by muscle group with how often each was logged.
export async function libraryIndex() {
  const ctx = await loadData();
  const stat = new Map();
  for (const s of ctx.sets) {
    const e = stat.get(s.key) || { sessions: new Set(), last: null };
    e.sessions.add(s.sessionId);
    if (!e.last || s.date > e.last) e.last = s.date;
    stat.set(s.key, e);
  }
  const groups = new Map(MUSCLE_GROUPS.map((g) => [g, []]));
  for (const e of ctx.exercises) {
    const g = e.muscle_group || inferMuscleGroup(e.name);
    const st = stat.get(e.name.toLowerCase());
    (groups.get(g) || groups.get("Other")).push({
      name: e.name,
      sessions: st ? st.sessions.size : 0,
      last: st?.last ?? null,
      unilateral: !!Number(e.is_unilateral),
    });
  }
  for (const list of groups.values()) list.sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  return groups;
}

/* ---------------- exercise page ---------------- */

const pageUi = { metric: null, showAll: false, name: null };

export async function renderExercisePage(el, name) {
  if (!el) return;
  if (pageUi.name !== name) { pageUi.name = name; pageUi.metric = null; pageUi.showAll = false; }
  const ctx = await loadData();
  const ex = (await getExercise(name)) || { name, measurement_type: "weight_reps", is_unilateral: 0 };
  const key = ex.name.toLowerCase();
  const type = ex.measurement_type || "weight_reps";
  const group = ex.muscle_group || inferMuscleGroup(ex.name);
  const sets = ctx.sets.filter((s) => s.key === key);
  const ag = bySession(sets);

  const avail = metricsFor(type).filter((m) => ag.some((a) => METRICS[m].get(a) != null));
  if (!avail.includes(pageUi.metric)) pageUi.metric = avail[0] || null;
  const m = pageUi.metric;

  let chartHtml = `<div class="muted">Nothing logged for this exercise yet.</div>`;
  if (m) {
    const pts = ag.filter((a) => METRICS[m].get(a) != null).map((a) => ({
      t: parseDate(a.date).getTime(),
      y: METRICS[m].get(a),
      note: a.sets.length ? `${a.sets.length} set${a.sets.length === 1 ? "" : "s"}` : "",
    }));
    const latest = pts[pts.length - 1];
    chartHtml = `${chips("metric", avail.map((k) => [k, METRICS[k].label]), m)}
      <div class="chart-head"><span class="hero">${esc(fmtMetric(m, latest.y))}</span><span class="muted"> latest · ${esc(fmtDate(new Date(latest.t)))}</span></div>
      ${lineChart({
        series: [{ name: METRICS[m].label, color: SERIES[0], points: pts }],
        fmt: (v, axis) => (METRICS[m].unit === "time" ? fmtDur(v) : axis ? fmtNum(v, v >= 100 ? 0 : 1) : fmtMetric(m, v)),
        label: `${METRICS[m].label} for ${ex.name} over time`,
      })}`;
  }

  // Records
  const rec = [];
  const best = (pick, better) => sets.reduce((a, s) => (pick(s) != null && (!a || better(s, a)) ? s : a), null);
  const heavy = best((s) => (s.kg > 0 ? s.kg : null), (s, a) => s.kg > a.kg || (s.kg === a.kg && (s.reps ?? 0) > (a.reps ?? 0)));
  const bestE = best((s) => s.e1, (s, a) => s.e1 > a.e1);
  const mostReps = best((s) => s.reps, (s, a) => s.reps > a.reps || (s.reps === a.reps && (s.kg ?? 0) > (a.kg ?? 0)));
  const longest = best((s) => s.dur, (s, a) => s.dur > a.dur);
  const bigVol = ag.reduce((a, x) => (x.volume > 0 && (!a || x.volume > a.volume) ? x : a), null);
  const row = (label, value, date) => `<div class="pb-row"><span>${label}<br><span class="muted">${esc(fmtDate(date, true))}</span></span><span class="rec-val">${value}</span></div>`;
  if (heavy) rec.push(row("Heaviest set", `${fmtKg(heavy.kg)}${heavy.reps != null ? ` × ${heavy.reps}` : ""}`, heavy.date));
  if (bestE) rec.push(row("Best estimated 1RM", `${fmtKg(bestE.e1)} <span class="muted">(${fmtNum(bestE.kg)}×${bestE.reps})</span>`, bestE.date));
  if (mostReps) rec.push(row("Most reps in a set", `${mostReps.reps}${mostReps.kg > 0 ? ` <span class="muted">at ${fmtKg(mostReps.kg)}</span>` : ""}`, mostReps.date));
  if (longest) rec.push(row("Longest", fmtDur(longest.dur), longest.date));
  if (bigVol) rec.push(row("Biggest session volume", `${Math.round(bigVol.volume).toLocaleString()}kg`, bigVol.date));

  // History, newest first
  const hist = ag.slice().reverse();
  const shown = pageUi.showAll ? hist : hist.slice(0, 6);
  const histHtml = shown
    .map((a) => `<div class="hist-row"><div><strong>${esc(fmtDate(a.date, true))}</strong> <span class="muted">${esc(hooks.focusLabel(a.focus))}</span></div>
        <div class="hist-sets">${a.sets.map((s) => esc(setText(s))).join(" · ")}</div></div>`)
    .join("");

  // Form notes (video + tips), if any
  const content = LIBRARY_CONTENT[ex.name];
  const video = hooks.resolveVideoUrl(ex.name);
  const notes = content || video
    ? `<details class="section" ${sets.length ? "" : "open"}><summary>Form notes${video ? " + video" : ""}</summary>
        ${video ? `<video class="exercise-video" src="${video}" controls playsinline loop preload="metadata"></video>` : ""}
        ${content?.description ? `<p class="exercise-desc">${esc(content.description)}</p>` : ""}
        ${content?.tips?.length ? `<div class="tips-label">Coaching tips</div><ul class="tips-list">${content.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      </details>`
    : "";

  const others = ctx.exercises.filter((e) => e.name.toLowerCase() !== key).sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `
    <div class="section">
      <h3 class="page-title">${esc(ex.name)}</h3>
      <div class="muted">${esc(group)}${Number(ex.is_unilateral) ? " · each side" : ""} · ${ag.length} session${ag.length === 1 ? "" : "s"}</div>
      ${content?.tagline ? `<div class="exercise-tagline">${esc(content.tagline)}</div>` : ""}
      <div style="margin-top:12px;">${chartHtml}</div>
    </div>
    ${rec.length ? `<div class="section"><h2>Records</h2><div class="dash-pbs">${rec.join("")}</div></div>` : ""}
    ${hist.length ? `<div class="section"><h2>History</h2>${histHtml}
        ${hist.length > 6 ? `<button class="linkbtn tiny" data-show-all style="margin-top:10px;">${pageUi.showAll ? "Show fewer" : `Show all ${hist.length}`}</button>` : ""}</div>` : ""}
    ${notes}
    <details class="section"><summary>Exercise settings</summary>
      <label class="switch-row"><span>Log each side (L / R)</span>
        <input type="checkbox" data-set-uni ${Number(ex.is_unilateral) ? "checked" : ""}/></label>
      <label class="field-row"><span>What you record</span>
        <select data-set-type>${Object.entries(MEASUREMENT_LABELS).map(([k, l]) => `<option value="${k}" ${k === type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field-row"><span>Muscle group</span>
        <select data-set-group>${MUSCLE_GROUPS.map((g) => `<option ${g === group ? "selected" : ""}>${g}</option>`).join("")}</select></label>
      <label class="field-row"><span>Rest between sets (seconds)</span>
        <input type="number" inputmode="numeric" min="0" step="15" data-set-rest value="${ex.rest_sec ?? ""}" placeholder="plan / default"/></label>
      <div class="field-row"><span>Same exercise under another name? Move this history into:</span>
        <select data-merge-target><option value="">— choose —</option>${others.map((e) => `<option>${esc(e.name)}</option>`).join("")}</select>
        <button class="linkbtn tiny" data-merge style="margin-top:8px;">Merge</button></div>
    </details>`;
  wireCharts(el);

  const again = () => renderExercisePage(el, ex.name);
  const save = async (fields) => {
    await updateExerciseSettings(ex.name, fields);
    hooks.onExerciseChanged(ex.name);
    again();
  };
  el.onclick = async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    if (t.dataset.metric) { pageUi.metric = t.dataset.metric; return again(); }
    if (t.hasAttribute("data-show-all")) { pageUi.showAll = !pageUi.showAll; return again(); }
    if (t.hasAttribute("data-merge")) {
      const target = el.querySelector("[data-merge-target]").value;
      if (!target) return;
      if (!window.confirm(`Move all "${ex.name}" history into "${target}"? "${ex.name}" will disappear from the list.`)) return;
      await mergeExerciseName(ex.name, target);
      hooks.onExerciseChanged(target);
      return hooks.openExercise(target);
    }
  };
  el.onchange = (ev) => {
    const t = ev.target;
    if (t.hasAttribute("data-set-uni")) return save({ is_unilateral: t.checked ? 1 : 0 });
    if (t.hasAttribute("data-set-type")) return save({ measurement_type: t.value });
    if (t.hasAttribute("data-set-group")) return save({ muscle_group: t.value });
    if (t.hasAttribute("data-set-rest")) return save({ rest_sec: t.value === "" ? null : Math.max(0, Number(t.value) || 0) });
  };
}
