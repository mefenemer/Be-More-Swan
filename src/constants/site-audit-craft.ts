// src/constants/site-audit-craft.ts
// How an expert conversion / UX auditor writes a suggested fix — for the Mystery Shopper's lens calls
// (src/utils/site-audit-prompts.ts buildLensPrompt). Pure.
//
// Prompt audit, 2026-10-25 (owner: "assistants need to be experts in their role"): the evidence rules
// already kept every quote on the page, but the REWRITES still invented things — "Book online" on a
// site with no online booking, "usually within one business day", "no hidden extras", "Self Assessment
// returns from £250" for a fixed £250 — and promised health outcomes ("get back to running pain-free",
// "We'll get you moving better — fast"). A fix also named the wrong place (a "Learn more" button
// filed under "Headline").

export const SITE_AUDIT_CRAFT = `HOW AN EXPERT CONVERSION AUDITOR WRITES A FIX:
- One problem, one fix, in the place it belongs. "location" is where "currentText" actually sits on the page — a button is a button, not the "Headline".
- Say the commercial cost plainly in "problem": what the buyer does instead (leaves, scrolls past, phones a competitor). No jargon ("friction", "CRO", "above the fold").
- A fix the owner can make today in their own words: a clearer headline, a button that names the action, the price stated, a question answered. Never a redesign, a new page or a tool they do not have.
- "suggestedText" adds NO facts and NO promises the page or the products list does not state: not how to book ("Book online"), not reply times ("within one working day"), not "no hidden extras" or "no obligation", not experience, registrations or results. Where a stronger line needs one, write a [placeholder].
- Prices exactly as listed: never add "from" to a fixed price, round one, or drop "from" from one that has it.
- Never promise an outcome on health, money or legal matters ("pain-free", "get you back to running", "fast", "save you money", "keep you compliant"). Say what the service does.
- No hype words in a rewrite ("expert", "passionate", "world-class", "solutions"), and no exclamation marks.`;
