// Phase E — Templates (data-only)
// Uses canonical exercise_name strings that must exist in exercises_seed.csv

export const SESSION_TYPES = ["push", "pull", "legs", "mixed", "cardio", "other"];

export const TEMPLATES = {
  push: {
    anchors: [
      "Incline dumbbell press",
      "Chest fly machine",
    ],
    suggested: [
      "Seated shoulder press machine",
      "Lateral raises",
    ],
  },

  pull: {
    anchors: [
      "Lat pulldown",
      "Seated cable row",
    ],
    suggested: [
      "Single-arm cable row",
      "Face pull",
    ],
  },

  legs: {
    anchors: [
      "Smith machine Squat",
      "Seated leg curl",
      "Leg extension",
    ],
    suggested: [
      "Leg press",
      "Adductor machine",
    ],
  },

  // Non-prescriptive session types
  mixed: { anchors: [], suggested: [] },
  cardio: { anchors: [], suggested: [] },
  other: { anchors: [], suggested: [] },
};

// Controlled alias map (template wording or variants -> canonical seed name)
export const EXERCISE_ALIASES = {
  // Push
  "Incline chest press": "Incline dumbbell press",
  "Incline chest press (db or machine)": "Incline dumbbell press",
  "Secondary chest movement": "Chest fly machine",
  "Chest fly": "Chest fly machine",
  "Shoulder press": "Seated shoulder press machine",
  "Lateral raise": "Lateral raises",

  // Pull
  "Lat pulldown or assisted pull-up": "Lat pulldown",
  "Assisted pull-up": "Assisted pull-ups",
  "Horizontal row": "Seated cable row",
  "Rear delt / upper back": "Face pull",

  // Legs
  "Squat machine": "Smith machine Squat",
  "Smith squat": "Smith machine Squat",
  "Leg curl": "Seated leg curl",
  "Leg extension": "Leg extension",
  "Hip adductor": "Adductor machine",
};

// Resolve to canonical seed name (no fuzzy guessing)
export function resolveExerciseName(name) {
  if (!name) return null;
  const raw = String(name).trim();
  return EXERCISE_ALIASES[raw] ?? raw;
}
