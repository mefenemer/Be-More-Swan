// src/constants/email-craft.ts
// How an expert email marketer writes one email — for the single newsletter and the welcome-sequence
// prompts (src/utils/newsletter-generate.ts). Campaign emails carry their own, longer version in
// newsletter-campaign-generate.ts ("HOW EVERY EMAIL IN THIS CAMPAIGN IS WRITTEN"), which these rules
// mirror, so a one-off email and a campaign email read as the same writer.
//
// Prompt audit, 2026-10-24 (owner: "assistants need to be experts in their role"): six fresh drafts
// across three businesses were fluent but closed "You've got this." five times, signed one email from
// a person who does not exist ("Juniper", for Juniper & Co), invented "we see it every year" anecdotes,
// asked twice in one email, and packed three offers into one newsletter.

/** The block. `business` is the sender's name, for the sign-off rule. Pure. */
export function emailCraftBlock(business: string | null | undefined): string {
    const team = (business || '').trim() ? `— The ${String(business).trim()} team` : 'the business’s name';
    return `EMAIL CRAFT — write it the way an expert email marketer does:
- ONE job and ONE ask. One main idea the reader can act on, and one call to action at the end. A short news line is fine; several competing offers are not.
- The first two lines carry the point — they show in the inbox preview. Write to one person, in short paragraphs.
- Headings say something ("Cut the stems at an angle"), never just label a section ("Tips", "Why now").
- Sign off with a real person's name ONLY if the brief or business information gives one; otherwise sign off "${team}". Never invent a name.
- No invented anecdotes, customers, quotes or "we see it every year" claims, and no invented results or figures ("customers say they last a week longer", "a two-week fix becomes six", "twice as long", "we're fully booked"). On health, money or legal topics give general information and never promise an outcome ("will tell you exactly what's wrong").
- Never give a named person a "he" or "she" the brief doesn't state; use their name or "they".
- The preheader adds a concrete detail; never a teaser cliché ("It's not what you think").
- Never use: "You've got this", "Here's the thing", "game-changer", "In today's…", "I hope this finds you well", "Let's dive in".`;
}
