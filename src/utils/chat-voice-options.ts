// src/utils/chat-voice-options.ts
// The voices and caption looks a chat may name on a card — the SAME list the voice picker shows
// (src/public/voice-catalogue.json via src/lib/tts.ts) and the same caption choices the caption editor
// offers (src/lib/captions.ts). A voice the model invents is replaced by the default when the card is
// built (chat-post-action.ts / video-producer.ts readBrief), so this list is guidance, not the gate.

import { OFFERED_VOICES, VOICE_LANGUAGES } from '../lib/tts';
import { CAPTION_FONTS } from '../lib/captions';

/** Every offered voice by language, one line each: `id — Name, description`. Pure. */
export function voiceListForPrompt(): string {
    return VOICE_LANGUAGES.map((l) => {
        const vs = OFFERED_VOICES.filter((v) => v.lang === l.code);
        return vs.length ? `${l.label}: ${vs.map((v) => `${v.id} — ${v.name}, ${v.label}`).join('; ')}` : '';
    }).filter(Boolean).join('\n');
}

/** The caption look a card may carry, every field optional. Pure. */
export function captionStyleForPrompt(): string {
    return `"captionStyle" (all optional — leave out what the user didn't ask about): "mode": "highlight" (short phrases, the spoken word coloured — the default) | "phrase" (longer phrases, no colouring) | "word" (one big word at a time); "position": "bottom" | "middle" | "top"; "size": "small" | "medium" | "large"; "font": ${CAPTION_FONTS.map((f) => `"${f}"`).join(' | ')}; "textColor": "#RRGGBB"; "highlight": "brand" (their brand colour) or "#RRGGBB"; "box": true for a dark band behind the words.`;
}

/** The whole block, for a chat that can put a voice on something. Pure. */
export function voiceOptionsBlock(): string {
    return `VOICES — name one by its id. Each reads the script in the language it is written in and sounds most natural in its own; write the script in the voice's language. The user can listen to every voice with the ▶ Listen button on the card or in the voice picker.\n${voiceListForPrompt()}\n\nCAPTION LOOK — ${captionStyleForPrompt()}`;
}
