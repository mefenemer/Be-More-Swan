-- Guided tour voice narration cache (issue #161).
--
-- The tour previously narrated steps with the browser's free SpeechSynthesis API, which sounds
-- robotic on most systems ("Still sounds like an AI robot"). tour-narration.ts now generates real
-- neural speech via the OpenAI TTS API and caches the result here, keyed by a hash of the spoken
-- text + voice — since TOUR_STEPS copy is static platform content (not user data), each step is
-- synthesized once ever and served to every subsequent user from cache, keeping API cost negligible.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS tour_narration_cache (
    text_hash   TEXT PRIMARY KEY,
    voice       TEXT NOT NULL,
    audio_base64 TEXT NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'audio/mpeg',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
