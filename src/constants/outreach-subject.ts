// src/constants/outreach-subject.ts
// Static subject-line rules for every AI-generated outreach email. Same pattern as
// CONTENT_QUALITY_STANDARDS: ONE constant appended to the generation system prompt, so the rules
// live in a single editable place rather than scattered inline.
//
// There are FOUR seams that generate a subject — manual lead scoring and send-time generation in
// lead-generation.ts, discovery scoring in src/lib/discovery-scoring.ts, and follow-up drafting in
// process-sequence-sends.ts — and a bad opener subject propagates: the follow-up inherits it as
// "Re: <opener>". So the rules have to be shared, not repeated.
//
// The false-pretext rules exist because a real staging send produced "Clarification Needed: Your
// Be More Swan Account" to a stranger — a manufactured-urgency phrase implying an account that does
// not exist. That is the pattern spam filters score hardest on, and it is a misrepresentation
// regardless of deliverability.
export const OUTREACH_SUBJECT_RULES = `
SUBJECT LINE RULES — these are hard constraints, not preferences:
- NEVER imply a relationship that does not exist. This is cold outreach to a stranger. Do not reference an account, subscription, order, invoice, payment, support ticket, application, booking, delivery or case — the recipient has none with us. Do not imply they contacted us, signed up, enquired, or that anything of theirs is pending, failed, expiring or needs attention.
- NEVER manufacture urgency or obligation. Banned outright, including close variants: "Clarification Needed", "Action Required", "Response Required", "Urgent", "Important Notice", "Final Notice", "Immediate Attention", "Your Account", "Issue With Your…", "Overdue", "Confirm Your…", "Verify Your…", "Last Chance". These read as phishing and are treated as such by both filters and readers.
- NEVER fake a reply or forward. Do not begin a first email with "Re:", "Re :", "RE:", "Fwd:" or "FW:". A "Re:" prefix is only legitimate on a follow-up that genuinely continues a thread we already sent to this recipient.
- Say what the email is ACTUALLY about, in plain words the recipient would recognise as coming from a stranger with something to offer. If the honest subject is less clicky than a pretext, use the honest one.
- No clickbait or curiosity-gap tricks: no withheld information ("You won't believe…", "One thing about {company}…"), no fake personalisation, no questions the body doesn't answer.
- No ALL-CAPS words, no exclamation marks, no emoji, no "$" or "£" amounts, no square brackets or placeholders.
- Keep it under about 60 characters — specific and concrete beats clever.
`.trim();
