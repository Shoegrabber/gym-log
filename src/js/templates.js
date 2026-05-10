// Phase H — Rith's split: Upper A / Lower A / Push / Pull / Lower B
// Uses canonical exercise_name strings that must exist in exercises_seed.csv

export const SESSION_TYPES = [
  "upper_a",
  "lower_a",
  "push",
  "pull",
  "lower_b",
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
];

// Rith's split, per Sheet2.csv (2026-04). Targets are starting weights.
export const TEMPLATES = {
  upper_a: {
    label: "Upper A",
    exercises: [
      { name: "Smith machine incline press 15°", sets: 3, reps: "6-8", rest_sec: 180, weight_kg: 50, rir: "0-1" },
      { name: "Seated incline press machine", sets: 3, reps: "8-10", rest_sec: 150, weight_kg: 25, rir: "0-1" },
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
