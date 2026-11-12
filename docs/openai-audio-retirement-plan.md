# OpenAI audio models retiring: plan (2026-11-12)

Status: **plan only. No code changed.** Needs the owner's yes before anything is built.

## What OpenAI says (read on OpenAI's own pages, 2026-11-12)

Source: <https://developers.openai.com/api/docs/deprecations> (platform.openai.com/docs/deprecations redirects here).

| Model we use | Shutdown | OpenAI's named replacement | Notice dated |
| --- | --- | --- | --- |
| `gpt-4o-mini-tts` (both snapshots) | **6 Jan 2027** | `gpt-realtime-2.1-mini` | 2026-10-01 |
| `whisper-1` | **26 Feb 2027** | `gpt-live-transcribe` or `gpt-transcribe` | 2026-08-26 |

So the System Map check on staging had the dates and names right. One fix: for `whisper-1`, OpenAI names two replacements, not one.

### Do the replacements work on the endpoints we call?

**Speech: no.** The text-to-speech guide (<https://developers.openai.com/api/docs/guides/text-to-speech>) says `gpt-realtime-2.1-mini` "isn't a supported model for `/v1/audio/speech`" and calls the move "a change of API workflow". We would need to rebuild the call over the Realtime API (a WebSocket session), not just swap the model name.

**Transcription: the endpoint works, but word timings stop.** `gpt-transcribe` runs on `/v1/audio/transcriptions` and costs **$0.0045/min** (model page: <https://developers.openai.com/api/docs/models/gpt-transcribe>). But the file transcription guide (<https://developers.openai.com/api/docs/guides/speech-to-text>) says: "The `timestamp_granularities[]` parameter is only supported for `whisper-1`." So `gpt-transcribe` gives back the text with **no word start and end times**. Every place we use whisper needs those times:

- voiceover captions and scene lengths (`src/lib/tts.ts` → `transcribeAudio`)
- own-voice recordings: captions, the "differs from the script" check, measured length (`src/utils/own-voice.ts`)
- footage review: tightening the "um"s and pauses (`src/utils/footage-review.ts`)

`gpt-live-transcribe` ($0.017/min) is the Realtime streaming model. It is built for live audio, so it's the wrong tool for files we already have.

**There is no drop-in OpenAI replacement for any of our audio calls.**

## Where the code is affected

| File | What breaks, and when |
| --- | --- |
| `src/lib/tts.ts:23` `TTS_MODEL` | Fallback voice (ElevenLabs off or failed) fails from 6 Jan 2027. Voiceovers already fail softly, but with no fallback an ElevenLabs outage means no voiceover at all. |
| `src/lib/tts.ts:24` `TRANSCRIBE_MODEL` + `transcribeAudio` | No captions or word timings from 26 Feb 2027 (own voice keeps the recording without words, as designed). |
| `netlify/functions/tour-narration.ts:31` | Tour narration fails from 6 Jan 2027. |
| `src/utils/provider-balance.ts:213` | The OpenAI health ping sends a `gpt-4o-mini-tts` request. From 6 Jan 2027 it will report OpenAI as down even when it's up. |
| `src/lib/tts.ts:121-127` `voiceoverCostUsd` | The costs are written inline here (`0.015` speech, `0.006` transcription). `WHISPER_USD_PER_MINUTE` and `SPEECH_USD_PER_MINUTE` don't exist in `src/utils/ai-usage.ts`. |

## Recommended path

### 1. Word timings: move to ElevenLabs Scribe (not `gpt-transcribe`)

ElevenLabs speech-to-text (`POST /v1/speech-to-text`, `model_id` `scribe_v2` or `scribe_v3`) returns a `words` array with `start`/`end` per word (`timestamps_granularity` defaults to `word`), plus a language hint. One upload, one response, the same shape we need. Files can be up to 5 GB (whisper's limit is 25 MB). Source: <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>.

- **Price:** $0.20/hour = **~$0.0033/min**, against whisper's $0.006/min, so about 45% cheaper (<https://elevenlabs.io/pricing/api>, 2026-11-12).
- **Effort:** small. Rewrite `transcribeAudio` and `parseWords` for the new response shape (`text` in place of `word`; drop entries where `type` isn't `word`). Callers keep the same `{ words, durationS }`. The key is already set (`ELEVENLABS_API_KEY`).
- **To check on staging first:** whether Scribe keeps the "um"s footage review needs (whisper needed a prompt for that; Scribe has audio tagging), and accuracy on British English.
- **Option worth testing:** for voiceovers *we* generate, ElevenLabs can return timings alongside the audio (TTS "with timestamps", character-level). That would remove the transcription call entirely for the Pepper voice. Transcription would still be needed for own-voice and footage.
- **Not recommended:** `gpt-transcribe` would mean guessing word times from text plus audio length. Captions would drift.

Deadline: before **26 Feb 2027**. Do it early so the date can't catch us out.

### 2. Fallback voice: pick one before 6 Jan 2027

The fallback only matters when ElevenLabs is off or failing, so it should **not** be ElevenLabs.

| Option | Rebuild | List price | Notes |
| --- | --- | --- | --- |
| **A. `gpt-realtime-2.1-mini` over Realtime WebSocket** (OpenAI's named replacement) | Medium: open a WebSocket from the function, send text, collect PCM audio, encode to MP3 | $20 per 1M audio output tokens. **Estimate ~$0.025/min**, using the ~1,250 tokens/min that the old $12/1M ≈ $0.015/min implied | Same key and vendor. Accent is set by instructions, as now. More moving parts in a 26 s function. |
| **B. `gpt-audio-1.5` via Chat Completions** (plain HTTP, not deprecated) | Small: one HTTP request that asks for audio output | $64 per 1M audio output tokens. **Estimate ~$0.08/min** | Simplest OpenAI route, but about 5× today's price. It's a chat model, so it may reword the script unless told firmly not to. |
| **C. Another provider (e.g. Google Cloud TTS or Azure Speech, both with British voices)** | Small to medium: new key, new adapter in `synthesize()` | Not priced here; check before choosing | Adds a vendor and a new sub-processor (DPA and privacy page update). |
| **D. No fallback** | None: remove the OpenAI path | £0 | An ElevenLabs outage means voiceovers fail with a clear message until it's back. |

**Recommendation: A** for the voiceover fallback and tour narration. It's the replacement OpenAI names, the price rise is small (~$0.015 → ~$0.025/min, and only on fallback runs), and it adds no new vendor or sub-processor. If the WebSocket proves awkward inside a Netlify function, fall back to **D** rather than B (B is 5× the price and may reword the script). The two minute prices are estimates, so log real token counts from staging and fix the numbers then.

Tour narration (`tour-narration.ts`) should move with the same choice. It could also use the ElevenLabs Pepper voice as its main voice, which would match voiceovers.

### 3. Small fixes that come with it

- `provider-balance.ts`: ping something that won't be retired (e.g. `GET /v1/models`) in place of a speech request.
- Cost lines in `voiceoverCostUsd`: Scribe ~$0.0033/min in place of whisper's $0.006; the fallback speech line set to the chosen option's measured price. Also note a side observation: ElevenLabs' API page now lists v2 Multilingual at **$0.08/1K characters**, but `ELEVENLABS_USD_PER_1K_CHARS` is `0.15`. That may depend on plan (credits vs pay-as-you-go), so check it against the bill.
- ElevenLabs is already a sub-processor, so Scribe adds none.

## Price change summary (per minute of audio, list prices)

| Part | Now | After |
| --- | --- | --- |
| Word timings | whisper-1 $0.006 | Scribe ~$0.0033 |
| Fallback voice (rare) | gpt-4o-mini-tts ~$0.015 | none (owner chose D) — $0 |
| Pepper voiceover (main path) | ElevenLabs chars + $0.006 | ElevenLabs chars + ~$0.0033, or + $0 with TTS timestamps |

## Decisions for the owner

1. Move word timings to ElevenLabs Scribe — **decided 2026-11-12: yes. Built** (not yet on staging):
   - `transcribeAudio` in `src/lib/tts.ts` calls Scribe (`ELEVENLABS_STT_MODEL`, default `scribe_v3`) with `language_code`, word timestamps, `no_verbatim=false` (the "um"s stay in for tightening), `tag_audio_events=false`, and the business name as a keyterm for footage.
   - whisper-1 stays as the fallback until it retires: used when there's no ElevenLabs key, or Scribe refuses (key, permission, credits, HTTP error). A Scribe **timeout** is not retried on whisper, because a second wait could outlast the request.
   - The voiceover cost line now charges the transcription to whoever did it (Scribe $0.20/h, whisper $0.006/min, nothing when it failed).
   - **⚠️ Owner action before it does anything:** the ElevenLabs key was made with only Text to Speech, Voices Read and User permissions. Add **Speech to Text** to the key (ElevenLabs → API keys) on the same key used by every context. Until then every call is refused and falls back to whisper, so nothing breaks, but nothing changes either.
   - To check on staging: one voiceover and one footage review. Captions should line up, the "um"s should be tightened, and the server log should *not* show `[tts] Scribe failed`.
   - Not covered: own-voice and footage transcription costs are not logged to `ai_usage_log` at all (they weren't with whisper either). This is a separate gap.
2. Fallback voice — **decided 2026-11-12: D, no fallback.** What that means when it's built:
   - `synthesize()` in `src/lib/tts.ts` stops falling back to OpenAI. If ElevenLabs is off or fails, the voiceover fails with a clear message. `TTS_MODEL`, `synthesizeSpeech` and the OpenAI speech cost line go.
   - `tour-narration.ts` uses OpenAI as its *main* voice, so "no fallback" there means moving it to the ElevenLabs Pepper voice, not just deleting a fallback.
   - The `provider-balance.ts` OpenAI ping switches to `GET /v1/models` (still needed for whisper until step 1 lands).
   - Timing: the OpenAI path keeps working until 6 Jan 2027, so this can be built any time before then. Building it in December keeps the current safety net for longest.
3. Test ElevenLabs TTS-with-timestamps to skip transcription on our own voiceovers? — **open**
