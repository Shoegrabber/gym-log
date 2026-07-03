// Phase H — Rith's split: Upper A / Lower A / Push / Pull / Lower B
// Uses canonical exercise_name strings that must exist in exercises_seed.csv

export const SESSION_TYPES = [
  "upper_a",
  "lower_a",
  "push",
  "pull",
  "lower_b",
  // Rith's 4-day split (added alongside the 5-day split, not replacing it)
  "fourday_back",
  "fourday_push",
  "fourday_lower",
  "fourday_pull",
  "mixed",
  "cardio",
  "other",
];

export const SESSION_LABELS = {
  upper_a: "Upper A",
  lower_a: "Lower A",
  push: "Push",
  pull: "Pull",
  lower_b: "Lower B",
  fourday_back: "4-Day Back/Ham",
  fourday_push: "4-Day Push",
  fourday_lower: "4-Day Lower",
  fourday_pull: "4-Day Pull/Upper",
  mixed: "Mixed",
  cardio: "Cardio",
  other: "Other",
};

// Exercises Ben treats as unilateral (each set logged with side L or R)
export const UNILATERAL_EXERCISES = [
  "Single-arm lat pulldown",
  "Single-arm cable row",
  "Single-leg extension",
  "Bulgarian split squat",
  "Single-arm tricep pushdown",
  "Single leg press",
  "Single-leg lying leg curl",
  // Dumbbell-in-each-hand exercises: each side is its own working effort,
  // so log L and R independently.
  "Hammer curl",
  "Dumbbell preacher curl",
  // Item 9 — the three lifts Ben explicitly wants logged per-side.
  // "Single-leg lying leg curl" already covered above.
  "Dumbbell hammer curl",
  "Lateral raises",
];

// Declarative measurement-type map: exercise_name → measurement_type.
// Applied idempotently at init (see db.applyMeasurementTypes) and when an
// exercise is added to a session. This is the single source of truth for
// which exercises are time/cardio/hold-based rather than weight+reps — it
// replaces the old ad-hoc, name-exact hardcoded corrections that missed
// variants like "Bike warm-up".
//   weight_reps  (default) — weight + reps
//   time_only               — duration only (e.g. stationary bike)
//   cardio                  — duration + distance (treadmill, rower…)
//   weight_time             — weight + duration (weighted planks / holds)
//   notes_only              — no sets (stretch / mobility)
export const MEASUREMENT_TYPES = {
  // Duration-based conditioning
  "Bike": "time_only",
  "Bike warm-up": "time_only",
  "Treadmill": "cardio",
  "Rowing machine": "cardio",
  "Elliptical": "cardio",
  "Stair climber": "cardio",
  // Weighted holds — capture BOTH load and time; PB tracks the load
  "Core hold": "weight_time",
  "Plank": "weight_time",
  "Side plank": "weight_time",
  "Dead hang": "weight_time",
  // Non-loaded prep work — no sets to log
  "Warm-up": "notes_only",
  "Light warm-up stretches": "notes_only",
  "Dynamic warm-up": "notes_only",
  "Cool-down stretch": "notes_only",
  "Mobility work": "notes_only",
  "Hip band warm-up": "notes_only",
};

// Per-exercise hint shown next to the weight input. Used to disambiguate
// "weight per hand" vs "total" for exercises where the convention isn't obvious.
export const WEIGHT_INPUT_HINTS = {
  "Walking lunges": "per hand",
  "Bulgarian split squat": "per hand",
  "Hammer curl": "per hand",
  "Dumbbell preacher curl": "per hand",
};

// Rith's split, per Sheet2.csv (2026-04). Targets are starting weights.
export const TEMPLATES = {
  upper_a: {
    label: "Upper A",
    exercises: [
      { name: "Smith machine incline press 15°", sets: 3, reps: "6-8", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Seated high incline press machine", sets: 3, reps: "8-10", rest_sec: 150, weight_kg: 25, rir: "0-1" },
      { name: "Cable chest fly", sets: 3, reps: "8-12", rest_sec: 180, weight_kg: 10, rir: "0-1" },
      { name: "Single-arm lat pulldown", sets: 3, reps: "6-8", rest_sec: 180, weight_kg: 45, rir: "0-1" },
      { name: "Single-arm cable row", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 45, rir: "0-1" },
      { name: "Lying lateral raise", sets: 3, reps: "10-12", rest_sec: 120, weight_kg: 10, rir: "0-1" },
      { name: "Tricep rope pushdown", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 30, rir: "0-1" },
      { name: "Incline dumbbell curl", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 7.5, rir: "0-1" },
    ],
  },

  lower_a: {
    label: "Lower A",
    exercises: [
      { name: "Seated leg curl", sets: 3, reps: "8-12", rest_sec: 180, weight_kg: 91, rir: "0-1" },
      { name: "Barbell back squat", sets: 3, reps: "6-10", rest_sec: 180, weight_kg: 70, rir: "0-1" },
      { name: "Leg press", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 190, rir: "0-1" },
      { name: "Bulgarian split squat", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 12, rir: "0-1" },
      { name: "Seated calf raise", sets: 3, reps: "12", rest_sec: 180, weight_kg: 70, rir: "0-1" },
      { name: "Adductor machine", sets: 3, reps: "12", rest_sec: 180, weight_kg: 85, rir: "0-1" },
    ],
  },

  push: {
    label: "Push",
    exercises: [
      { name: "Smith machine bench press", sets: 2, reps: "6-8", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Seated chest press machine", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 65, rir: "0-1" },
      { name: "Cable chest fly", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 25, rir: "0-1" },
      { name: "High incline press", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Lateral raises", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Overhead tricep extension", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 32, rir: "0-1" },
      { name: "Single-arm tricep pushdown", sets: 3, reps: "10-12", rest_sec: 180, weight_kg: 10, rir: "0-1" },
    ],
  },

  pull: {
    label: "Pull",
    exercises: [
      { name: "Single-arm lat pulldown", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 45, rir: "0-1" },
      { name: "T-bar row", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 60, rir: "0-1" },
      { name: "Lean-forward seated cable row", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 41, rir: "0-1" },
      { name: "Face pull", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Dumbbell preacher curl", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 12, rir: "0-1" },
      { name: "Hammer curl", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: null, rir: "0-1" },
    ],
  },

  lower_b: {
    label: "Lower B",
    exercises: [
      { name: "Dumbbell RDL", sets: 3, reps: "6-8", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Single leg press", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Leg extension", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Lying leg curl", sets: 3, reps: "8-10", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Walking lunges", sets: 3, reps: "20 step", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Abductor machine", sets: 3, reps: "12", rest_sec: 180, weight_kg: null, rir: "0-1" },
      { name: "Seated calf raise", sets: 3, reps: "10", rest_sec: 180, weight_kg: null, rir: "0-1" },
    ],
  },

  // ----------------------------------------------------------------
  // Rith's 4-day split (2026-07). No baseline weights yet — weight_kg
  // left null so nothing is pre-filled and Ben logs fresh each lift.
  // Exercise names map to existing canonical names where possible so PB
  // history carries over; genuinely new movements were added to the seed.
  // ----------------------------------------------------------------
  fourday_back: {
    label: "4-Day Back/Ham",
    exercises: [
      { name: "Barbell RDL", sets: 2, reps: "6-8", rest_sec: 120, weight_kg: null },
      { name: "Single-leg lying leg curl", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Dumbbell row", sets: 2, reps: "6-8", rest_sec: 120, weight_kg: null },
      { name: "Pull-ups", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Single-arm lat pulldown", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Rear delt fly", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Dumbbell preacher curl", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
    ],
  },

  fourday_push: {
    label: "4-Day Push",
    exercises: [
      { name: "Smith machine incline press 15°", sets: 3, reps: "6-8", rest_sec: 120, weight_kg: null },
      { name: "Dumbbell bench press", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Chest fly machine", sets: 3, reps: "10-12", rest_sec: 120, weight_kg: null },
      { name: "High incline press", sets: 2, reps: "6-8", rest_sec: 120, weight_kg: null },
      { name: "Lateral raises", sets: 3, reps: "10-12", rest_sec: 120, weight_kg: null },
      { name: "Tricep rope pushdown", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
    ],
  },

  fourday_lower: {
    label: "4-Day Lower",
    exercises: [
      { name: "Seated leg curl", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Adductor machine", sets: 2, reps: "10-12", rest_sec: 120, weight_kg: null },
      { name: "Smith machine Squat", sets: 2, reps: "6-8", rest_sec: 120, weight_kg: null },
      { name: "Leg press", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Bulgarian split squat", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Abductor machine", sets: 2, reps: "12-15", rest_sec: 120, weight_kg: null },
      { name: "Seated calf raise", sets: 2, reps: "10-15", rest_sec: 120, weight_kg: null },
    ],
  },

  fourday_pull: {
    label: "4-Day Pull/Upper",
    exercises: [
      { name: "Close-grip pull-up", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Single-arm cable row", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Reverse-grip lat pulldown", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Floor press", sets: 2, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Seated high incline press machine", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Face pull", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Lying lateral raise", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Overhead tricep extension", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
      { name: "Decline cable bicep curl", sets: 3, reps: "8-10", rest_sec: 120, weight_kg: null },
    ],
  },

  mixed: { label: "Mixed", exercises: [] },
  cardio: { label: "Cardio", exercises: [] },
  other: { label: "Other", exercises: [] },
};

// Aliases for legacy template wording
export const EXERCISE_ALIASES = {
  "Smith squat": "Smith machine Squat",
  "Squat machine": "Smith machine Squat",
  "Leg curl": "Seated leg curl",
  "Hip adductor": "Adductor machine",
  "Lat pulldown or assisted pull-up": "Lat pulldown",
  "Assisted pull-up": "Assisted pull-ups",
  "Horizontal row": "Seated cable row",
  "Rear delt / upper back": "Face pull",
  "Lateral raise": "Lateral raises",
  "Shoulder press": "Seated shoulder press machine",
  "Chest fly": "Cable chest fly",
  "Incline chest press": "Incline dumbbell press",
  "Incline chest press (db or machine)": "Incline dumbbell press",
  "Secondary chest movement": "Cable chest fly",
};

export function resolveExerciseName(name) {
  if (!name) return null;
  const raw = String(name).trim();
  return EXERCISE_ALIASES[raw] ?? raw;
}
