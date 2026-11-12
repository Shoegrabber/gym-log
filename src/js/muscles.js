// Exercise defaults inferred from the name: muscle group, each-side
// (unilateral) and measurement type. These are only starting guesses —
// anything the user changes in the exercise's settings wins (the
// exercises.user_edited flag stops boot-time defaults overwriting it).

import { UNILATERAL_EXERCISES, MEASUREMENT_TYPES } from "./templates.js";

export const MUSCLE_GROUPS = [
  "Chest", "Back", "Shoulders", "Biceps", "Triceps",
  "Quads", "Hamstrings", "Hips", "Calves", "Core",
  "Cardio", "Other",
];

// Groups that count as resistance training in "sets per muscle" stats.
export const TRAINING_GROUPS = MUSCLE_GROUPS.filter((g) => g !== "Cardio" && g !== "Other");

// Ordered: first match wins.
const RULES = [
  ["Cardio", /\bbike\b|treadmill|rowing machine|elliptical|stair|sprint/],
  ["Other", /warm|stretch|mobility/],
  ["Core", /plank|\bcore\b|crunch|\babs?\b/],
  ["Calves", /calf/],
  ["Hamstrings", /leg curl|\brdl\b|deadlift|back extension/],
  ["Hips", /adductor|abductor|hip thrust|glute/],
  ["Quads", /squat|leg press|leg extension|lunge/],
  ["Triceps", /tricep|skull|\bdips?\b|pushdown|close-grip bench/],
  ["Biceps", /curl|chin-?up/],
  ["Back", /\brow\b|pulldown|pull-?ups?|shrug|dead hang/],
  ["Shoulders", /lateral|shoulder|overhead press|arnold|rear delt|reverse pec|face pull|raise/],
  ["Chest", /bench|chest|\bfly\b|press|push-?ups?|pec/],
];

export function inferMuscleGroup(name) {
  const n = String(name || "").toLowerCase();
  for (const [group, re] of RULES) if (re.test(n)) return group;
  return "Other";
}

const UNILATERAL_SET = new Set(
  [...UNILATERAL_EXERCISES, "Dumbbell row"].map((n) => n.toLowerCase())
);

export function inferUnilateral(name) {
  const n = String(name || "").trim().toLowerCase();
  if (UNILATERAL_SET.has(n)) return true;
  return /single[- ](arm|leg)|one[- ](arm|leg)/.test(n);
}

const TYPE_MAP = new Map(
  Object.entries(MEASUREMENT_TYPES).map(([k, v]) => [k.toLowerCase(), v])
);

export function inferMeasurementType(name) {
  const n = String(name || "").trim().toLowerCase();
  if (TYPE_MAP.has(n)) return TYPE_MAP.get(n);
  if (/pull-?ups?$|chin-?ups?$|push-?ups?$|^dips$/.test(n) && !/assisted/.test(n)) return "bodyweight";
  return null; // leave as the default (weight_reps)
}

export const MEASUREMENT_LABELS = {
  weight_reps: "Weight + reps",
  bodyweight: "Bodyweight (reps)",
  time_only: "Time only",
  weight_time: "Weight + time",
  cardio: "Time + distance",
  notes_only: "Notes only",
};
