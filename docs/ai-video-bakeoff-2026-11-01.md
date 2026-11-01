# AI Clip Bake-off — 2026-11-01 (round 1)

Phase 0 of [video-producer-footage-and-ai-plan.md](./video-producer-footage-and-ai-plan.md) §5.3.
Run with `scripts/ai-video-bakeoff.mjs` (rerun it quarterly with the candidates updated).

## How it was run

- **5 prompts, one per style.** All are made-up people and businesses: a café owner pouring
  coffee (realistic), a lighthouse at sunrise with a drone push-in (cinematic), a small orange
  robot watering plants (3D animated), a dog walker in a park (2D cartoon), and a mug being glazed
  (product close-up). The exact prompts are in the script.
- **Same start for every model.** Each prompt got one FLUX 1.1 Pro first frame (9:16). Every model
  started from that frame with the same motion prompt, so the comparison is motion and fidelity
  only.
- **7 models** on fal: 1080p (Seedance at 720p, because its 1080p is $1.16/s), 5 s (Gemini Omni
  Flash and MiniMax 6 s, their nearest length), sound off.
- **35 clips, all succeeded.** Cost about $36.
- **Scored from six moments per clip** (0.3 s to 4.8 s) on contact sheets, kept with the run in
  the session scratchpad. Scores are 0–3: does it do what was asked, and does it stay coherent
  (faces, hands, objects, style).

Round 1 is smaller than the plan's 6 prompts per style. Read it as a strong signal, not a verdict:
one prompt per style can be luck.

## Results

| Model | fal id | $/s (on the day) | 5 s clip | Avg time | Realistic | Cinematic | 3D | Cartoon | Product | **Total /15** |
|---|---|---|---|---|---|---|---|---|---|---|
| **Kling 3.0 Pro** | `fal-ai/kling-video/v3/pro/image-to-video` | 0.112 | $0.56 | 3 m 48 s | 3 | 1.5 | 3 | 3 | 3 | **13.5** |
| Kling 4.0 | `kling/v4/image-to-video` | 0.235 | $1.18 | 4 m 57 s | 3 | 1.5 | 3 | 3 | 2.5 | 13 |
| Seedance 2.5 (720p) | `bytedance/seedance-2.5/us/image-to-video` | 0.473 | $2.37 | 4 m 21 s | 2 | 3 | 3 | 1 | 3 | 12 |
| MiniMax H3 Max | `minimax/h3-max/image-to-video` | 0.112 (30% off to 15 Nov) | $0.67 (6 s) | 20 s | 1 | 2.5 | 3 | 3 | 1 | 10.5 |
| Kling 2.5 Turbo (**what prod uses now**) | `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | 0.07 | $0.35 | 1 m 37 s | 1.5 | 0.5 | 2 | 2 | 2 | 8 |
| Wan 3.0 | `alibaba/wan-3.0/image-to-video` | 0.20 | $1.00 | 2 m 15 s | 1 | 2 | 1 | 2 | 0 | 6 |
| Gemini Omni Flash | `google/gemini-omni-flash/v1.1/image-to-video` | 0.15 | $0.90 (6 s) | 1 m 22 s | 1 | 1 | 1.5 | 2 | 0 | 5.5 |

### What each style showed

- **Realistic (the café).** Only the two Klings do the action: she picks up a jug, pours into the
  cup, looks up and smiles, and her face stays the same person throughout. Seedance pours from the
  cup itself. MiniMax tips one cup into another. Gemini, Wan and Kling 2.5 mostly smile and hold
  the cup. Wan also adds a customer who wasn't asked for.
- **Cinematic (the lighthouse).** Seedance is the only one that truly pushes in, and it lights the
  lighthouse beam as it goes. MiniMax moves the camera too. Wan has the biggest waves but a static
  camera. The Klings move subtly. Kling 2.5 is close to a still.
- **3D (the robot).** Kling 3, Kling 4, Seedance and MiniMax all pour visible water and bounce
  happily, with the character consistent. Gemini and Wan barely water.
- **2D cartoon (the dog walker).** Kling 3, Kling 4 and MiniMax walk naturally and keep the flat
  style. Gemini's style drifts. Seedance barely moves, apart from the leaves.
- **Product (the glazed mug).** Kling 3 sweeps glaze around the rim cleanly. Seedance and Kling 4
  are also clean. Gemini grows a mug handle where the hand was. Wan melts the mug into a swirl with
  a hole in it. MiniMax loses the brush. These two failures would be most embarrassing in a
  customer's post.

## What it means

1. **Prod is on the weakest-but-two model.** Kling 2.5 Turbo is the code default (`FAL_I2V_MODEL`
   is unset in every Netlify context). Moving to **Kling 3.0 Pro** is the biggest quality jump on
   offer. It's already supported in code (`imageToVideoInput` has a v3 branch, and v3 takes any
   length from 3 to 15 s).
2. **Kling 4.0 isn't worth it yet.** It isn't better than Kling 3 here, costs twice as much and is
   slower.
3. **Seedance 2.5 is a specialist.** It has the best camera moves, but costs 4× Kling 3 (at 720p)
   and is weak at character walking. It's a candidate for a "Cinematic" style only, if the
   cinematic re-test (below) doesn't close the gap with Kling 3.
4. **MiniMax H3 Max is fast (20 s).** It's a useful fallback and might suit a cheap draft preview,
   but it can't be trusted with realistic people or objects.
5. **Drop Wan 3.0 and Gemini Omni Flash** for now. Both morph objects.

## Before switching prod to Kling 3.0 Pro

- **Parallel AI clips (code).** `buildProject` makes scenes one after another inside a 15-minute
  background function, and the AI clip deadline is 9 minutes. Kling 3 averaged 3 m 48 s (up to
  4 m 25 s), so three AI clips in a row plus the voiceover can hit the 15-minute ceiling. Submit
  every AI clip first, then poll them together.
- **Price (owner decision D-F2).** Kling 3 Pro is $0.112/s, plus about $0.04 for the FLUX frame.
  The Busywork Buster plan is £69 for 2,750 tasks (about 2.5p a task), so today's flat 20 tasks
  (about 50p) roughly covers a 5 s clip and loses money on a 10 s one. Charging by length, about
  **4 tasks a second** (6 s = 24, 10 s = 40), keeps the margin as today's. Check the exchange
  rate and plan prices on the day.
- **Then** set `FAL_I2V_MODEL=fal-ai/kling-video/v3/pro/image-to-video` on staging, make one real
  video, then set it on prod.

## Round 2 (before picking per-style models)

- 5 more prompts per style for the top three (Kling 3 Pro, Kling 4, Seedance 2.5), including
  harder ones: two people interacting, hands holding a product, text-free signage, fast motion.
- A cinematic re-test of Kling 3 with explicit camera words ("drone dolly forward, steady
  push-in") to see whether Seedance is needed at all.
- Sound on, for the "with sound" option (§5.3): Kling 3 audio (+50%), Seedance (included).
