// src/utils/newsletter-campaign-chat-draft.ts
// Normalise the `newsletter_campaign_draft` uiElement the newsletter chat route emits — a short,
// ordered series of emails — before anything renders it or writes it. The sibling of
// src/utils/newsletter-chat-draft.ts (one issue), and the same reasons apply: the card holds the
// ONLY copy of a campaign somebody may have iterated on for several turns, and the model's output
// reaches it unvalidated. docs/newsletter-campaigns-system-prompt.md is the prompt it pairs with.
//
// ── What this enforces that the prompt only asks for ────────────────────────────────────────────
//  • THE TIMING ADDS UP. The model writes both `sendDay` (what people think in: Day 1, Day 3) and
//    `delayDaysAfterPrevious` (what newsletter_sequence_steps.delay_days stores: days since the
//    PREVIOUS email). Two numbers that must agree will, eventually, not — so the delay is RECOMPUTED
//    from the days here and the model's own delay is ignored. A Day-7 email saved with a delay of 7
//    would arrive on Day 11.
//  • "STARTS BY ITSELF" IS NOT THE MODEL'S CALL. Only the `subscribed` trigger can enrol anybody
//    (newsletter_sequences_trigger_check). A card that said a renewal campaign would start on its own
//    would be a promise nothing keeps, so the flag is derived from the event, never read.
//  • NO INVENTED LINKS. A call to action or a body link survives only when its exact URL appears in
//    text the human supplied — the same rule, and the same function, as a generated layout's.
//  • MERGE TAGS the send worker cannot resolve are removed and reported, as on every write path.

import { scrubMergeTags, MAX_SUBJECT_CHARS, MAX_PREHEADER_CHARS } from './newsletter-generate';
import { groundMarkdownLinks } from './layout-ir';

export const NEWSLETTER_CAMPAIGN_DRAFT_TYPE = 'newsletter_campaign_draft';

export const CAMPAIGN_TYPES = ['onboarding', 'renewal', 'upgrade', 'winback', 'reengagement', 'launch', 'custom'] as const;
export type CampaignType = typeof CAMPAIGN_TYPES[number];

/**
 * The events that can put somebody into a campaign BY THEMSELVES. Must match
 * newsletter_sequences_trigger_check (db/schema.ts) — a test holds the two together, and the prompt's
 * "TRIGGERS THAT START BY THEMSELVES" line is held to this list.
 */
export const AUTOMATIC_TRIGGERS = ['subscribed'] as const;

/** The prompt caps a campaign at 7; the welcome sequence holds 8 (MAX_STEPS). Below both. */
export const MAX_CAMPAIGN_EMAILS = 7;
/** Same ceiling newsletter-sequences.ts saveStep clamps delay_days to. */
export const MAX_DELAY_DAYS = 90;
/** Same as a sequence step's MAX_BODY. */
export const MAX_CAMPAIGN_BODY_CHARS = 20_000;

export interface CampaignEmail {
    sequenceOrder: number;
    sendDay: number;
    delayDaysAfterPrevious: number;
    role: string;
    subject: string;
    preheader: string;
    callToAction: { label: string; url: string | null } | null;
    bodyMarkdown: string;
}

export interface NewsletterCampaignDraft {
    /**
     * 'plan' = the outline, no copy yet; 'draft' = every email written.
     *
     * ⚠️ DERIVED, not read: a reply that says "draft" with one email missing its copy is a plan as
     * far as saving goes. Saving it would file an empty email — which the sequence endpoint refuses
     * and the issues endpoint would happily create.
     */
    stage: 'plan' | 'draft';
    name: string;
    campaignType: CampaignType;
    goal: string;
    audience: string;
    trigger: { event: 'subscribed' | 'custom'; description: string; startsAutomatically: boolean };
    tone: string;
    newsletters: CampaignEmail[];
    /** What was changed on the way in, so the card can say so rather than silently editing. */
    warnings: string[];
}

const DEFAULT_NAMES: Record<CampaignType, string> = {
    onboarding: 'Welcome sequence',
    renewal: 'Renewal reminders',
    upgrade: 'Upgrade sequence',
    winback: 'Win-back sequence',
    reengagement: 'Re-engagement sequence',
    launch: 'Launch sequence',
    custom: 'Email sequence',
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * @param suppliedText Everything the HUMAN gave this conversation — their messages and the setup
 *   answers. A URL the model writes survives only if it appears here verbatim. Omit it and every
 *   link is removed, which is the safe failure.
 */
export function campaignDraftFromUiElement(uiElement: unknown, suppliedText = ''): NewsletterCampaignDraft | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== NEWSLETTER_CAMPAIGN_DRAFT_TYPE) return null;
    // Accept the object either wrapped ({ campaign: {...} }, as the prompt asks) or flat — a model
    // that drops the wrapper has still written the campaign, and refusing it discards real work.
    const c = (ui.campaign && typeof ui.campaign === 'object' ? ui.campaign : ui) as Record<string, unknown>;
    const raw = Array.isArray(c.newsletters) ? c.newsletters : [];
    if (!raw.length) return null;   // nothing to show — the caller falls back to text-only

    const warnings: string[] = [];
    const scrub = (v: string) => { const out = scrubMergeTags(v); warnings.push(...out.warnings); return out.text; };

    // Order by what the model SAID the order was, falling back to array position for ties and gaps.
    const items = raw
        .map((n, i) => ({ n: (n && typeof n === 'object' ? n : {}) as Record<string, unknown>, i }))
        .sort((a, b) => ((int(a.n.sequenceOrder) ?? a.i + 1) - (int(b.n.sequenceOrder) ?? b.i + 1)) || a.i - b.i);
    if (items.length > MAX_CAMPAIGN_EMAILS) {
        warnings.push(`A campaign can hold at most ${MAX_CAMPAIGN_EMAILS} emails, so the last ${items.length - MAX_CAMPAIGN_EMAILS} were left off.`);
        items.length = MAX_CAMPAIGN_EMAILS;
    }

    // ── Timing: days first, delays derived ─────────────────────────────────────────────────────
    // A sendDay that is missing is rebuilt from the model's delay; one that goes BACKWARDS is held
    // at the previous day (two emails on one day is legal for a countdown; time travel is not).
    let prevDay = 0;
    let shuffled = false;
    let clamped = false;
    const newsletters: CampaignEmail[] = items.map(({ n }, idx) => {
        let day = int(n.sendDay);
        if (day == null) {
            const delay = Math.max(0, int(n.delayDaysAfterPrevious) ?? (idx === 0 ? 0 : 2));
            day = (idx === 0 ? 1 : prevDay) + delay;
        }
        day = Math.max(1, day);
        if (day < prevDay) { day = prevDay; shuffled = true; }
        let delay = idx === 0 ? day - 1 : day - prevDay;
        if (delay > MAX_DELAY_DAYS) { delay = MAX_DELAY_DAYS; day = (idx === 0 ? 1 : prevDay) + delay; clamped = true; }
        prevDay = day;

        const body = scrub(text(n.bodyMarkdown, MAX_CAMPAIGN_BODY_CHARS));
        const grounded = groundMarkdownLinks(body, suppliedText);
        if (grounded.removed) warnings.push(`Email ${idx + 1} linked to a page nobody gave me, so the words are there without the link. Add the address before you send.`);

        const cta = n.callToAction && typeof n.callToAction === 'object' ? n.callToAction as Record<string, unknown> : null;
        const ctaLabel = cta ? scrub(text(cta.label, 80)) : '';
        let ctaUrl = cta ? text(cta.url, 2000) : '';
        if (ctaUrl && (!/^https?:\/\//i.test(ctaUrl) || !suppliedText.includes(ctaUrl))) {
            warnings.push(`Email ${idx + 1}'s button pointed at a page nobody gave me, so it has no link yet.`);
            ctaUrl = '';
        }

        const subject = scrub(text(n.subject, MAX_SUBJECT_CHARS));
        return {
            sequenceOrder: idx + 1,
            sendDay: day,
            delayDaysAfterPrevious: delay,
            role: text(n.role, 80),
            subject: subject || `Email ${idx + 1}`,
            preheader: scrub(text(n.preheader, MAX_PREHEADER_CHARS)),
            callToAction: ctaLabel ? { label: ctaLabel, url: ctaUrl || null } : null,
            bodyMarkdown: grounded.markdown.trim(),
        };
    });
    if (shuffled) warnings.push('Two emails were out of order by day, so the later one now goes out the same day as the one before it.');
    if (clamped) warnings.push(`No gap between emails can be longer than ${MAX_DELAY_DAYS} days, so a long gap was shortened.`);

    const written = newsletters.filter((n) => n.bodyMarkdown).length;
    const stage: 'plan' | 'draft' = written === newsletters.length ? 'draft' : 'plan';
    if (written && stage === 'plan') {
        warnings.push(`${newsletters.length - written} of the emails came back without their copy, so this cannot be saved yet. Ask me to write the rest.`);
    }

    const campaignType: CampaignType = (CAMPAIGN_TYPES as readonly string[]).includes(String(c.campaignType))
        ? c.campaignType as CampaignType : 'custom';
    const trig = c.trigger && typeof c.trigger === 'object' ? c.trigger as Record<string, unknown> : {};
    const event: 'subscribed' | 'custom' = trig.event === 'subscribed' ? 'subscribed' : 'custom';

    return {
        stage,
        name: text(c.name, 80) || DEFAULT_NAMES[campaignType],
        campaignType,
        goal: text(c.goal, 300),
        audience: text(c.audience, 300),
        trigger: {
            event,
            description: text(trig.description, 300),
            // Derived — see the header. The model's own value is never read.
            startsAutomatically: (AUTOMATIC_TRIGGERS as readonly string[]).includes(event),
        },
        tone: text(c.tone, 120),
        newsletters,
        warnings: [...new Set(warnings)],
    };
}
