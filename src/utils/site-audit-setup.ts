// src/utils/site-audit-setup.ts — the Mystery Shopper's settings, and the bridge between its set-up
// answers (ai_assistants.onboarding_context) and its audit (site_audits). docs/mystery-shopper-plan.md §4.2.
//
// TWO PLACES HOLD THE SAME FIVE ANSWERS, on purpose, and this file keeps them equal:
//   · onboarding_context — what the set-up wizard and Profile ▸ Setup Answers show and edit, and what
//     the chat route restates (onboardingValue). The platform's generic surfaces read only this.
//   · site_audits         — what the pipeline reads. A run must not depend on parsing free-form
//     onboarding JSON, and the audit carries state (hashes, scores) the context has no place for.
// Every write goes through one of the two functions below, and each writes BOTH:
//   saving set-up    → update-assistant-context.ts → syncSiteAuditFromSetup()
//   saving the tab   → site-audits.ts `save`       → saveSiteAuditSettings() (also patches the context)
//
// The keys below are the ONLY onboarding keys this role has. tests/assistant-surfaces-review.test.ts
// fails on a set-up question nothing reads — each one is read here.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditRuns, siteAudits } from '../../db/schema';
import { MAX_COMPETITORS, normaliseSiteUrl, requestAuditRun, sameSite, failAuditRun } from './site-audit';
import { triggerSiteAudit } from './trigger-site-audit';

type Db = ReturnType<typeof getDb>;

/** Set-up keys (assistant-onboarding-schemas.js → mystery_shopper). */
export const SETUP_KEYS = {
    url: 'siteUrl',
    icp: 'idealCustomer',
    conversionGoal: 'conversionGoal',
    competitors: 'competitorUrls',
    weekday: 'checkWeekday',
} as const;

/** "What should a visitor do?" — the set-up radio's values, and the words the prompts use. */
export const CONVERSION_GOALS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'book_call', label: 'Book a call or consultation' },
    { value: 'buy', label: 'Buy online' },
    { value: 'start_trial', label: 'Start a free trial or sign up' },
    { value: 'get_quote', label: 'Ask for a quote' },
    { value: 'phone', label: 'Phone us' },
    { value: 'visit', label: 'Visit us in person' },
    { value: 'subscribe', label: 'Join the mailing list' },
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const SETTINGS_LIMITS = { icp: 400, conversionGoal: 200 } as const;

export interface SiteAuditSettings {
    url: string;
    icp: string | null;
    /** The words, not the radio value — this is what goes into prompts. */
    conversionGoal: string | null;
    competitorUrls: string[];
    checkWeekday: number;
}

/** A set-up value or a stored label → the label. Unknown free text is kept as written. */
export function conversionGoalLabel(v: unknown): string | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    const hit = CONVERSION_GOALS.find((g) => g.value === v.trim());
    return (hit ? hit.label : v.trim()).slice(0, SETTINGS_LIMITS.conversionGoal);
}

/** The label back to the radio value, so the set-up form re-opens on the right option. */
export function conversionGoalValue(label: string | null): string | null {
    if (!label) return null;
    return CONVERSION_GOALS.find((g) => g.label === label)?.value ?? label;
}

/** Competitors arrive as an array (the tab, chat) or one-per-line text (set-up). */
function competitorList(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') return raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return [];
}

/**
 * Validate settings from any surface. `current` fills anything not supplied, so a chat card that
 * changes only the competitors cannot blank the ideal customer. Returns a user-facing error string.
 */
export function validateSettings(
    raw: Record<string, unknown>,
    current: SiteAuditSettings | null,
): { ok: true; settings: SiteAuditSettings } | { ok: false; error: string } {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;

    const url = has('url') ? normaliseSiteUrl(raw.url) : current?.url ?? null;
    if (!url) return { ok: false, error: 'Enter your website address, e.g. yourbusiness.co.uk' };

    let competitorUrls = current?.competitorUrls ?? [];
    if (has('competitorUrls')) {
        const list = competitorList(raw.competitorUrls).filter((x) => !(typeof x === 'string' && !x.trim()));
        if (list.length > MAX_COMPETITORS) return { ok: false, error: `Up to ${MAX_COMPETITORS} competitors.` };
        competitorUrls = [];
        for (const item of list) {
            const c = normaliseSiteUrl(item);
            if (!c) return { ok: false, error: `"${String(item).slice(0, 80)}" isn't a website address we can read.` };
            if (sameSite(c, url)) return { ok: false, error: 'A competitor can\'t be your own website.' };
            if (!competitorUrls.some((x) => sameSite(x, c))) competitorUrls.push(c);
        }
    } else {
        // The site itself changed to one of the saved competitors — drop that competitor.
        competitorUrls = competitorUrls.filter((c) => !sameSite(c, url));
    }

    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '') || null;
    const icp = has('icp') ? text(raw.icp, SETTINGS_LIMITS.icp) : current?.icp ?? null;
    const conversionGoal = has('conversionGoal') ? conversionGoalLabel(raw.conversionGoal) : current?.conversionGoal ?? null;

    let checkWeekday = current?.checkWeekday ?? 1;
    if (has('checkWeekday')) {
        const n = Number(raw.checkWeekday);
        if (Number.isInteger(n) && n >= 0 && n <= 6) checkWeekday = n;
    }
    return { ok: true, settings: { url, icp, conversionGoal, competitorUrls, checkWeekday } };
}

/** Settings → the set-up answers, in the shape the wizard and Profile read back. */
export function setupAnswersFor(s: SiteAuditSettings): Record<string, unknown> {
    return {
        [SETUP_KEYS.url]: s.url,
        [SETUP_KEYS.icp]: s.icp ?? '',
        [SETUP_KEYS.conversionGoal]: conversionGoalValue(s.conversionGoal) ?? '',
        [SETUP_KEYS.competitors]: s.competitorUrls.join('\n'),
        [SETUP_KEYS.weekday]: String(s.checkWeekday),
    };
}

/** The set-up answers → raw settings for validateSettings (only keys present are passed). */
export function rawFromSetup(ctx: Record<string, unknown>): Record<string, unknown> {
    const raw: Record<string, unknown> = {};
    const pick = (from: string, to: string) => { if (ctx[from] !== undefined) raw[to] = ctx[from]; };
    pick(SETUP_KEYS.url, 'url');
    pick(SETUP_KEYS.icp, 'icp');
    pick(SETUP_KEYS.conversionGoal, 'conversionGoal');
    pick(SETUP_KEYS.competitors, 'competitorUrls');
    pick(SETUP_KEYS.weekday, 'checkWeekday');
    return raw;
}

export function settingsOf(audit: typeof siteAudits.$inferSelect | null | undefined): SiteAuditSettings | null {
    if (!audit) return null;
    return {
        url: audit.url,
        icp: audit.icp,
        conversionGoal: audit.conversionGoal,
        competitorUrls: Array.isArray(audit.competitorUrls) ? (audit.competitorUrls as string[]) : [],
        checkWeekday: audit.checkWeekday,
    };
}

/**
 * Save the audit. When the PAGE changes (a new site, or moving on to the pricing page after the
 * homepage hit its target) the scores belong to the old page: the baseline, current score, hashes
 * and goal status start again, and `pageChanged` tells the caller to run a fresh first check.
 * Old fixes keep their page_url, so they are never "verified" against the new page.
 */
async function upsertAudit(db: Db, opts: { orgId: number; assistantId: number; userId: number | null; settings: SiteAuditSettings; existingUrl: string | null }) {
    const pageChanged = opts.existingUrl !== null && opts.existingUrl !== opts.settings.url;
    const values = {
        ...opts.settings,
        ...(pageChanged ? { baselineScore: null, currentScore: null, lastHashes: {}, lastRunId: null, status: 'active' } : {}),
        updatedAt: new Date(),
    };
    const [saved] = await db.insert(siteAudits)
        .values({ ...values, organisationId: opts.orgId, aiAssistantId: opts.assistantId, createdBy: opts.userId })
        .onConflictDoUpdate({ target: siteAudits.aiAssistantId, set: values })
        .returning();
    return { saved, pageChanged };
}

/** Has this audit ever been checked, or is a check on its way? Then don't start a baseline. */
async function hasAnyRun(db: Db, auditId: number): Promise<boolean> {
    const [row] = await db.select({ id: siteAuditRuns.id }).from(siteAuditRuns).where(and(
        eq(siteAuditRuns.auditId, auditId),
        inArray(siteAuditRuns.status, ['queued', 'running', 'done', 'unchanged', 'unreadable']),
    )).limit(1);
    return !!row;
}

/**
 * Start the first check. Called once the site is known; a second call finds the run and does nothing.
 * A baseline costs a task like any check that scores — the hire itself is the user's click.
 */
export async function startBaselineIfNeeded(db: Db, opts: { auditId: number; orgId: number; userId: number | null; pageChanged?: boolean }): Promise<boolean> {
    if (!opts.pageChanged && await hasAnyRun(db, opts.auditId)) return false;
    const { runId, alreadyRunning } = await requestAuditRun(db, { auditId: opts.auditId, organisationId: opts.orgId, kind: 'baseline', userId: opts.userId });
    if (alreadyRunning) return false;
    if (await triggerSiteAudit(runId)) return true;
    await failAuditRun(db, runId, 'The first check couldn\'t be started. Press "Check my site now" to try again — nothing was charged.');
    return false;
}

/**
 * Set-up was saved: copy the answers into the audit and, the first time, start the baseline check.
 * Never throws — set-up is already saved, and the Website tab can always finish the job.
 */
export async function syncSiteAuditFromSetup(
    db: Db,
    opts: { assistantId: number; orgId: number; userId: number | null; onboardingContext: unknown },
): Promise<{ saved: boolean; started: boolean; error?: string }> {
    try {
        const ctx = (opts.onboardingContext && typeof opts.onboardingContext === 'object' && !Array.isArray(opts.onboardingContext))
            ? opts.onboardingContext as Record<string, unknown> : {};
        const [existing] = await db.select().from(siteAudits).where(eq(siteAudits.aiAssistantId, opts.assistantId)).limit(1);
        const raw = rawFromSetup(ctx);
        if (!existing && !raw.url) return { saved: false, started: false };
        const v = validateSettings(raw, settingsOf(existing));
        if (!v.ok) return { saved: false, started: false, error: v.error };
        const { saved, pageChanged } = await upsertAudit(db, { orgId: opts.orgId, assistantId: opts.assistantId, userId: opts.userId, settings: v.settings, existingUrl: existing?.url ?? null });
        const started = await startBaselineIfNeeded(db, { auditId: saved.id, orgId: opts.orgId, userId: opts.userId, pageChanged });
        return { saved: true, started };
    } catch (err) {
        console.error('[site-audit-setup] sync from set-up failed', { assistantId: opts.assistantId, message: err instanceof Error ? err.message : String(err) });
        return { saved: false, started: false, error: 'Your answers were saved, but the website check could not be set up. Open the Website tab to finish.' };
    }
}

/**
 * Settings saved from the Website tab or a chat card: write the audit AND the set-up answers, so
 * Profile ▸ Setup Answers and the chat never describe an old site.
 */
export async function saveSiteAuditSettings(
    db: Db,
    opts: { assistantId: number; orgId: number; userId: number | null; raw: Record<string, unknown> },
): Promise<{ ok: true; audit: typeof siteAudits.$inferSelect; started: boolean } | { ok: false; error: string }> {
    const [existing] = await db.select().from(siteAudits).where(and(
        eq(siteAudits.aiAssistantId, opts.assistantId), eq(siteAudits.organisationId, opts.orgId),
    )).limit(1);
    const v = validateSettings(opts.raw, settingsOf(existing));
    if (!v.ok) return v;
    const { saved: audit, pageChanged } = await upsertAudit(db, { orgId: opts.orgId, assistantId: opts.assistantId, userId: opts.userId, settings: v.settings, existingUrl: existing?.url ?? null });
    // jsonb || jsonb merges the five keys in, leaving every other set-up answer alone.
    await db.update(aiAssistants)
        .set({ onboardingContext: sql`COALESCE(${aiAssistants.onboardingContext}, '{}'::jsonb) || ${JSON.stringify(setupAnswersFor(v.settings))}::jsonb` })
        .where(and(eq(aiAssistants.id, opts.assistantId), eq(aiAssistants.organisationId, opts.orgId)));
    const started = await startBaselineIfNeeded(db, { auditId: audit.id, orgId: opts.orgId, userId: opts.userId, pageChanged });
    return { ok: true, audit, started };
}
