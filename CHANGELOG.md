# Changelog

## 2026-11-13 — Revamp: easier logging, real stats, automatic backup

Branch: `revamp-2026-11`

**Fixes**
- Library search no longer loses the keyboard after one letter (only the rows re-render).
- "Each side (L/R)" is now a switch on every exercise (⋯ on the card, or the exercise page) instead of a fixed list in code. Defaults are applied the moment an exercise is added, not at the next app start. Dumbbell row and both hammer-curl names default to L/R.
- Exercise names match regardless of capitals, so a re-typed name reuses the existing exercise and its settings.
- New "Bodyweight (reps)" type for pull-ups, push-ups, dips: reps first, optional added kg.
- Library lists every exercise you have logged, grouped by muscle, with session counts.
- Exports and backups now include the L/R side of each set (they silently dropped it before).

**Timer**
- "⏱ Time it" on timed exercises starts the stopwatch linked to that exercise; pausing offers "Save to …". With no session it is still a plain stopwatch.
- Rest timer uses the plan's rest for the exercise (or your own per-exercise setting, else the default in Settings), shows "Go!", beeps and vibrates. If the app is in the background it sends a notification instead.

**Stats**
- Stats tab rebuilt as tiles you can hide and reorder: this week, sets per muscle group (vs 4-week average), weekly volume, sessions per week, recent records, most improved, compare two exercises, compare two sessions, recent sessions.
- Every exercise has a page: chart (est. 1RM / top weight / volume / best reps), records, full history, form notes, settings, and "merge into another name".

**In-session**
- "Next up" one-tap start for the next day of your split.
- Each card shows the plan (sets done / target, rep range) and last session's sets.
- Bigger inputs and buttons. Remove-exercise moved into ⋯ and asks first. Deleting a session asks first.
- Tapping a search result adds the exercise straight away.

**Backup**
- Automatic backup to `Documents/GymLogBackups/` every time a session is finished. Optional push to a GitHub repo (Settings). "Restore from a backup file" added.

**Room to grow**
- `daily_metrics` table (date, kind, value, unit) reserved for body weight, sleep, food. Stats tiles are a registry (`TILES` in `src/js/stats.js`) — a new tile is one object.

**Build note:** build the APK with JDK 21 (`JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew assembleDebug`); the system default JDK 25 fails.

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
