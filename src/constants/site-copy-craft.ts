// src/constants/site-copy-craft.ts
// How an expert website copywriter writes a small business's pages — for the Website Assistant's
// whole-site draft (src/utils/site-draft.ts), its template fill (src/utils/site-template-fill.ts)
// and its chat edits (netlify/functions/chat-orchestrator.ts, website_assistant). Pure.
//
// Prompt audit, 2026-10-25 (owner: "assistants need to be experts in their role"): three drafted
// sites were well built and kept to the listed prices, but every one invented how the business
// works — "we aim to reply within one working day", "we work remotely", "choose a time online",
// "free, no-obligation quote", "meet in York or by video call", "we deliver and dress your flowers
// on the day", "return-to-running work is not a separate charge" — none of it in the business
// details. Customers read those as promises. One hero was a slogan any competitor could use
// ("Your books sorted — so you can get on with your work"), a physio site promised visitors they
// would be "back to full health", and every site carried a testimonials section of [placeholders]
// that blocks publishing until the owner deletes it or writes reviews.

export const SITE_COPY_CRAFT = `WEBSITE COPY — write it the way an expert website copywriter does:
- The hero headline names what the business does and who or where it is for, in the visitor's words ("Physio for runners and desk workers in Headingley"). A line any competitor could put on their site ("Your books sorted", "Flowers for every occasion") is a slogan, not a headline. The subheadline adds how it works or why this business — never a repeat of the headline.
- Write to the visitor ("you"), about what they get, in short sentences and short sections; each section does one job. Concrete nouns and verbs, not adjectives.
- Button words say what happens when it is pressed ("Book an assessment", "Ask for a quote"), never "Learn more" or "Submit".
- Search titles: the service, the place (when known) and the business name, under 60 characters. Search descriptions give a reason to click, under 155.
- Never use: "passionate", "bespoke", "tailored", "one-stop shop", "we pride ourselves", "nestled", "unparalleled", "cutting-edge", "world-class", "dedicated team", "look no further", "peace of mind", "hassle-free", "seamless", "elevate".

PROMISES AND POLICIES ARE FACTS TOO. Never state how the business works unless the business details, products or the owner's own words say so: no reply times ("within one working day"), free or no-obligation quotes, online booking, remote or video appointments, delivery or set-up on the day, what is or isn't included or charged extra, "no hidden fees" (or charges, or extras), "no obligation", whether a referral is needed, cancellation, parking, opening hours, areas covered beyond what is stated, or qualifications and memberships. Nor what customers do ("many of our clients…"). Where a page genuinely needs one of these, write a clear [placeholder] for the owner to fill in — or leave it out.
- An FAQ asks the questions you can answer from the facts. Add at most two whose answer must be a [placeholder] (the ones a buyer would need before buying) — never a question written only to hold one.
- Never promise an outcome on health, money or legal matters ("back to full health", "pain-free", "save you money", "keep you compliant", "stay on the right side of HMRC"). Say what the service does.
- Never give a named person a "he" or "she" the details don't state — use their name or "they".
- Don't add a testimonials section unless the business details give real customer words: it would be nothing but [placeholders], and the site can't be published until they are filled. The owner adds real reviews from Audience ▸ Reviews.`;
