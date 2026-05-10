# Changelog

## 2026-05-08 — Phase H: Rith's split + in-session UX overhaul

Branch: `ui-redesign-2026-04`

### What changed

**Rest timer**
- Now wall-clock based — keeps counting down while the app is backgrounded (taking a call, locking the phone, etc.)
- Added a `+15s` button to extend rest mid-countdown
- Auto-refreshes when the app comes back to the foreground

**Rith's split**
- Session focus dropdown now offers: Upper A, Lower A, Push, Pull, Lower B, Mixed, Cardio, Other
- Each named template pre-loads its exercises with starting weights, reps, and rest times taken from Rith's spreadsheet
- Catalog gained ~12 new exercises (Smith machine incline press 15°, Lying lateral raise, Single-arm tricep pushdown, Bulgarian split squat, Single leg press, Lean-forward seated cable row, etc.)

**In-session quality of life**
- The exercise you just logged a set on floats to the top of the list (so the timer stays in view)
- Newly typed exercises are saved to the catalog automatically — no more re-typing next session
- Last working set's weight + reps + unit pre-fill the next set's inputs as a recommendation
- Total session volume (in kg) shown at the bottom of the active session

**Unilateral logging**
- Single-arm / single-leg exercises now show **L** and **R** buttons instead of `+ Set`
- Each set records which side; reps and weight tracked independently per side

**Edit + correct old data**
- Every logged set has an `Edit` button — fix weight, unit, reps, side, or delete
- Per-exercise kg/lbs selector defaults to the last unit you used
- Fixes the "single-arm lat pulldown shows 130 max" issue caused by accidentally logging lbs as kg

**Coaching hint**
- After a session, if your last 3+ sets all hit 12+ reps, the next session shows a "try heavier" prompt on that exercise

### Commits in this batch
- `d2f8074` UI Redesign: Dark Navy/Indigo Theme (baseline from Claude Design)
- `d253e93` Phase H foundation: Rith's split + L/R schema
- `b07e016` Wall-clock rest timer + +15s button
- `69798e2` In-session UX: L/R sets, last-set defaults, latest-to-top, persist new exercises
- `0402c61` Review batch: edit sets, total volume, raise hint, kg/lbs toggle

### Deployed
APK built and installed via ADB on 2026-05-08. Existing data preserved — schema migrations are additive.

### Open ideas (not built yet)
- Form-check video links per exercise. Plan: store one video per exercise on Google Drive, filenames mirror the exercise name (lowercased, hyphenated, e.g. `bulgarian-split-squat.mp4`). App would auto-resolve the link from the exercise name.
