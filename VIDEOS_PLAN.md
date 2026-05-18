# Form-check Videos — Implementation Plan

Decisions captured 2026-05-10. To be implemented once Ben finishes
collecting and compressing his exercise videos.

## Decisions

### Hosting: bundled in the APK
- Videos ship inside the APK at `src/public/videos/`
- Pros: works offline, zero playback friction, gym wifi irrelevant
- Cons: APK grows by ~10 MB, video changes require rebuild + reinstall
  (acceptable — form videos rarely change)
- Rejected alternatives: Drive streaming (needs internet + Drive direct
  URLs are fiddly), separate phone storage folder (requires permission
  + manual file management)

### Naming convention
Filename = exercise name from `src/js/templates.js`, lowercased, spaces
→ hyphens, with `.mp4`. The `°` symbol gets dropped.

Examples:
- `smith-machine-incline-press-15.mp4`
- `single-arm-lat-pulldown.mp4`
- `bulgarian-split-squat.mp4`
- `dumbbell-rdl.mp4`

App will resolve the URL by transforming the exercise name with that
same rule — no per-exercise mapping table needed.

### Full filename list — Rith's split

**Upper A**
- `smith-machine-incline-press-15.mp4`
- `seated-incline-press-machine.mp4`
- `cable-chest-fly.mp4`
- `single-arm-lat-pulldown.mp4`
- `single-arm-cable-row.mp4`
- `lying-lateral-raise.mp4`
- `tricep-rope-pushdown.mp4`
- `incline-dumbbell-curl.mp4`

**Lower A**
- `seated-leg-curl.mp4`
- `barbell-back-squat.mp4`
- `leg-press.mp4`
- `bulgarian-split-squat.mp4`
- `seated-calf-raise.mp4`
- `adductor-machine.mp4`

**Push**
- `smith-machine-bench-press.mp4`
- `seated-chest-press-machine.mp4`
- `cable-chest-fly.mp4` *(shared with Upper A)*
- `high-incline-press.mp4`
- `lateral-raises.mp4`
- `overhead-tricep-extension.mp4`
- `single-arm-tricep-pushdown.mp4`

**Pull**
- `single-arm-lat-pulldown.mp4` *(shared with Upper A)*
- `t-bar-row.mp4`
- `lean-forward-seated-cable-row.mp4`
- `face-pull.mp4`
- `dumbbell-preacher-curl.mp4`
- `hammer-curl.mp4`

**Lower B**
- `dumbbell-rdl.mp4`
- `single-leg-press.mp4`
- `leg-extension.mp4`
- `lying-leg-curl.mp4`
- `walking-lunges.mp4`
- `abductor-machine.mp4`
- `seated-calf-raise.mp4` *(shared with Lower A)*

## Compression target

| Setting    | Value              |
| ---------- | ------------------ |
| Resolution | 360p (640×360)     |
| Codec      | H.264              |
| Bitrate    | ~200–300 kbps      |
| Audio      | None (stripped)    |
| Container  | MP4                |
| Length     | 10–15 s            |
| Expected   | ~250–400 KB / clip |

Expected total bundle: ~10 MB for ~30 clips. Source quality irrelevant —
1080p sources downscale cleanly to 360p (in fact better than native
720p shoots).

### ffmpeg command

```bash
cd ~/path/to/videos
mkdir compressed
for f in *.mp4; do
  ffmpeg -i "$f" \
    -vf "scale=-2:360" \
    -c:v libx264 -preset slow -crf 30 \
    -an \
    -movflags +faststart \
    "compressed/$f"
done
```

- `-an` strips audio
- `crf 30` is aggressive but readable for form-check; drop to 25 if too
  blurry on test clips
- `-movflags +faststart` puts metadata at the front so playback starts
  instantly

Recommended workflow:
1. Pick two test videos (one simple, one with detail you care about)
2. Run the command on them
3. Open the outputs, check form is still readable
4. If yes → run on the whole folder; if no → drop CRF and retry

## UX design

### Playback flow
1. Each exercise card shows a small **▶** icon next to the name, only if
   a matching video file exists in `src/public/videos/`.
2. Tap the icon → full-screen overlay opens
3. Video fills the screen, **autoplays muted on loop** (loop is important —
   form watching is repetitive, no reason to re-tap play)
4. Native HTML5 controls visible: play/pause/scrub/fullscreen
5. **✕** button in the corner, OR tap-outside-to-dismiss → returns to
   session screen exactly as it was

### Element
Use a plain `<video>` tag — webview renders it natively, no library
needed:

```html
<video src="videos/smith-machine-bench-press.mp4"
       controls
       autoplay
       loop
       muted
       playsinline></video>
```

`playsinline` is critical — without it, iOS/some webviews force fullscreen
takeover with their own UI.

## Implementation checklist (for the future build)

1. Create `src/public/videos/` and drop in the compressed `.mp4` files
2. Add a small helper `resolveVideoUrl(exerciseName)` that:
   - Lowercases the name
   - Replaces spaces with hyphens
   - Strips non-alphanumeric chars (handles the `°` in "15°")
   - Appends `.mp4`
   - Returns the URL, or `null` if no matching file
3. In `renderSelectedSessionExercises`, render a ▶ button next to the
   exercise name if `resolveVideoUrl(r.exercise_name)` is not null
4. On click, open a modal/overlay with the `<video>` element above
5. Wire the ✕ + tap-outside-to-dismiss handlers
6. Run `npm run build && npx cap sync android && ./gradlew assembleDebug`
   and install — APK should grow by ~10 MB and videos play from local
   storage with zero network use.

### Video file presence detection
At app start, fetch a list of video filenames present in `videos/`
(either an auto-generated `videos/index.json` or a runtime HEAD request
per exercise name when first rendered). Caching the list once on init
is cheaper than 30 HEAD calls per render.

## Open thoughts

- If some exercises don't have videos yet, the ▶ button just doesn't
  appear. Graceful degradation.
- Future: maybe a "missing videos" section in the home-screen tools to
  show which canonical exercise names lack a video file.
