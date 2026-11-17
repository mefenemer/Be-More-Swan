# AI Presenter Bake-off: Round 1 (2026-11-15)

Phase A0 of [video-producer-screen-walkthrough-plan.md](./video-producer-screen-walkthrough-plan.md) §11.
Script: `scripts/ai-avatar-bakeoff.mjs`. Viewer with every clip: https://claude.ai/artifact/T53q4EbNkfosruNwWaHCrT (private to the owner).

**Spent:** $21.43 on fal (16 test clips + 1 Welsh clip), 2 FLUX.2 Pro images, a few cents of ElevenLabs.

## Set-up

- **Two made-up presenters** from FLUX.2 Pro (`landscape_16_9`, 1024×576): a woman in her late thirties
  (brown bob, navy blazer) and a man in his mid forties (short beard, grey jumper), both on a plain light-grey
  studio background, waist up, looking into the camera. Neither is a real person.
- **Three lines** (~10–13 s), the same software-walkthrough opening, spoken by catalogue voices with
  `eleven_multilingual_v2`: English female (Pepper), French male (Nicolas), Polish female (Hanna).
- **The same face and audio** went to each service, so only the face movement differs.
- **Drift:** one 37.6 s English line (Archer, male face) through Kling Standard in one call.

## Results

| Service (fal endpoint) | $/s | Output | Time to make ~10 s | What it does |
|---|---|---|---|---|
| Kling AI Avatar v2 Standard `fal-ai/kling-video/ai-avatar/v2/standard` | 0.0562 | 1280×720, 30 fps | 4–6 min | Calm, steady framing, natural blinks. Cheapest. |
| Kling AI Avatar v2 Pro `…/v2/pro` | 0.115 | 1920×1072, 30 fps | 5–7 min | Same behaviour as Standard at full HD. |
| OmniHuman 1.5 `fal-ai/bytedance/omnihuman/v1.5` (720p) | 0.16 | 1248×704, 25 fps | 3½–4½ min | Most expressive: hand gestures, camera moves and zooms. Framing changes, a risk for the bubble crop. Dearest. |
| VEED Fabric 1.0 `veed/fabric-1.0` (720p) | 0.15 | 1312×736, 25 fps | 1¼–1½ min | Head and face, occasional hand at the bottom edge, steady. Fastest. |
| HeyGen Avatar IV `fal-ai/heygen/avatar4/image-to-video` (720p) | 0.10 | 1280×720, 25 fps | 1–2 min | Head and face, steady, warm. Fast. |

- **All 16 clips worked first time.** Output length matched the audio within 0.3 s for every service.
- **Every service kept the face recognisably the same person** in all three languages (checked frame by frame on contact sheets).
- **No drift** across the 37.6 s Kling Standard clip (12 min 26 s to make; long clips should be made in pieces side by side).
- **Lip-sync accuracy was not scored by Claude.** It needs watching with sound, so the owner judges it in the viewer.

## Welsh

- `eleven_multilingual_v2` (the app's default, `ELEVENLABS_TTS_MODEL`) **refuses** `language_code: 'cy'` (400 `unsupported_language`).
- `eleven_v3` **speaks Welsh**. Scribe (`scribe_v1`, `cy`) heard *"Croeso. Heddiw, dw i am ddangos i chi sut i archebu apwyntiad a chael eich talu i gyd yn un lle syml"*
  for the line *"Croeso! Heddiw, rydw i am ddangos i chi sut i archebu apwyntiad a chael eich talu, i gyd o un lle syml."*
  That's two small differences, both close.
- **To offer Welsh,** Welsh lines must use `eleven_v3`, and a Welsh voice entry goes in the catalogue. A Welsh Kling Standard clip is in the viewer ($0.48).

## Decision

**2026-11-17: the owner watched the clips and chose Kling AI Avatar v2 Standard** (plan D-A1).

## Recommendation (as written before the decision)

- **Default: Kling AI Avatar v2 Standard.** It's the cheapest by 2–3×, has steady framing that suits the bubble, and showed no drift.
  Its slowness doesn't matter, because pieces are made side by side.
- **"High quality": Kling Pro** only if Standard looks soft full-screen on 16:9.
- **OmniHuman 1.5** is the pick for a lively full-frame presenter, but it moves the camera. Consider it later as a "Lively"
  style for full-frame-only videos, not for the bubble.
- If the owner judges Kling's lip-sync worse than HeyGen IV or Fabric, **HeyGen Avatar IV** is the next choice ($0.10/s, fast).

Rerun every quarter, with new candidates added (LongCat avatar, newer Kling and OmniHuman versions).
