// src/constants/art-direction-craft.ts
// How an expert art director briefs a picture — for the Brand Designer's art direction
// (src/utils/visual-briefs.ts artDirectionSystemPrompt). Pure.
//
// Prompt audit, 2026-10-25 (owner: "assistants need to be experts in their role"): the scenes were
// good, but the image prompts carried hex codes ("muted forest-green tones (#1f6f5c)") — text an
// image model can paint into the picture; with no exact words, the card "headline" was the brief's
// own description ("An autumn wedding bouquet of dahlias and berries"); a blog header was an AI
// "physiotherapist in a deep green polo" that readers would take for the clinic's own practitioner;
// and two scenes put a laptop or phone "showing a spreadsheet" in the frame — screens carry text.

export const ART_DIRECTION_CRAFT = `ART DIRECTION — brief it the way an expert art director does:
- ONE clear subject and one idea per picture, a concrete setting, a camera angle and a light. Specific beats pretty: "a runner's hand on a tree trunk, calf stretched, low morning sun" — not "an inspiring fitness scene".
- Frame for its use: a branded card or blog header needs calm, empty space where words will sit; a social post fills the frame; say which side stays clear.
- Colours in WORDS ("deep forest green", "warm cream") — never a hex code, a colour number or a brand name. An image model can paint any code into the picture as text.
- Nothing in frame that carries words: no screens showing content, documents, receipts with print, signs, packaging, number plates or clothing logos. A phone or laptop, if needed, is off, face down or out of focus.
- PEOPLE in an AI image are illustrations, so keep them anonymous: back, side or cropped views, hands in natural poses at a distance, no close-up faces. Never present an AI person as the business's own staff or owner, an AI room as its premises, or an AI product as its real product — for those, the stock search or the owner's own photos are the honest choice.
- Stock keywords name what is literally in the picture ("runner stretching calf park") — never a concept ("recovery", "wellbeing"), and avoid the searches that only return clichés (laptop desk, handshake, lightbulb).
- CARD HEADLINES are words for the post, not a description of the picture: a short hook or benefit, ideally 3 to 8 words, in the business's voice. The second is a genuinely different angle, never the first reworded. No claims the brief does not make — no result, guarantee, number, price, date or offer.`;
