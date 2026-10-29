// src/lib/ai-visibility-accuracy.ts
// Admin → AI Visibility: suggest "Accurate?" for an answer that names Be More Swan.
//
// The facts come from the same places a prospect's AI reads: the live llms.txt (assistants, plans and
// prices, baked from production at each publish) and the public /connections page (which platforms
// are live and which are coming), plus plan prices, the trial length and our own review count and
// average straight from the database (an answer quoting a star rating we don't have is wrong).
// Nothing here is typed by hand, so the judge never checks against a stale list.
//
// Used by the background fetcher (after each fetched answer) and by the admin function (a pasted
// answer, and "Check accuracy" for answers fetched before this existed).

import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterPlans, platformReviews } from '../../db/schema';
import { reviewStats } from '../utils/platform-reviews';
import { TRIAL_DAYS } from '../utils/trial';
import { gatewayGenerate } from './ai-gateway';
import { accuracySystemPrompt, parseAccuracyVerdict, htmlToText } from '../utils/ai-visibility';

const SITE = (process.env.URL || 'https://bemoreswan.com').replace(/\/$/, '');
const FACTS_TTL_MS = 10 * 60 * 1000;
let cached: { at: number; text: string } | null = null;

async function fetchText(path: string, max: number): Promise<string> {
    try {
        const res = await fetch(`${SITE}${path}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return '';
        const body = await res.text();
        return (path.endsWith('.txt') ? body : htmlToText(body)).slice(0, max);
    } catch {
        return '';
    }
}

/** The fact sheet the judge checks against. Cached for ten minutes per warm function. */
export async function loadFacts(): Promise<string> {
    if (cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.text;
    const [plans, reviews, llms, connections] = await Promise.all([
        getDb().select({ name: masterPlans.name, monthlyPriceGbp: masterPlans.monthlyPriceGbp, isContactSales: masterPlans.isContactSales })
            .from(masterPlans).where(and(eq(masterPlans.isActive, true), ne(masterPlans.tierKey, 'trial')))
            .orderBy(asc(masterPlans.monthlyPriceGbp)),
        getDb().select({ rating: platformReviews.rating, status: platformReviews.status, sharedTo: platformReviews.sharedTo })
            .from(platformReviews).where(inArray(platformReviews.status, ['published', 'hidden']))
            .then((rows) => reviewStats(rows), () => null),
        fetchText('/llms.txt', 12_000),
        fetchText('/connections', 8_000),
    ]);
    const text = [
        'PLANS (from the database):',
        ...plans.map((p) => `- ${p.name}: ${p.isContactSales ? 'priced on request' : `£${Number(p.monthlyPriceGbp)} a month`}`),
        `FREE TRIAL: ${TRIAL_DAYS} days.`,
        reviews && reviews.average != null
            ? `REVIEWS (from the database, collected in the app): ${reviews.total} reviews, average ${reviews.average} out of 5. Ratings on Trustpilot or G2 are separate and not known here — do not mark a quoted Trustpilot or G2 rating wrong for that reason alone.`
            : 'REVIEWS: none published yet. Any star rating or review quote attributed to Be More Swan is not something we can confirm.',
        'Be More Swan is a UK-based web app for small businesses at bemoreswan.com. Nothing goes out until the owner approves it, unless they let an assistant publish on its own.',
        '',
        llms ? `=== llms.txt (live) ===\n${llms}` : '(llms.txt could not be read)',
        '',
        connections ? `=== Connections page (live: which platforms are live and which are coming soon) ===\n${connections}` : '(the Connections page could not be read)',
    ].join('\n');
    cached = { at: Date.now(), text };
    return text;
}

/**
 * Claude's suggested verdict for one answer, or null when it could not be made (no answer text, the
 * model failed, or its reply was not the JSON asked for). Never throws: a missing suggestion just
 * leaves the cell for the admin, as before.
 */
export async function suggestAccuracy(question: string, answerText: string, deadlineMs?: number): Promise<{ accurate: 'yes' | 'partly' | 'no'; wrongFacts: string | null } | null> {
    if (!String(answerText || '').trim()) return null;
    try {
        const facts = await loadFacts();
        const call = gatewayGenerate({
            system: accuracySystemPrompt(facts),
            messages: [{ role: 'user', content: `The question they asked:\n${question}\n\nThe answer they were given:\n${answerText.slice(0, 15_000)}` }],
            maxTokens: 700,
            deadlineMs,
        });
        // gatewayGenerate gives a non-thinking model the client's 24 s per attempt whatever the
        // deadline, so on a request path (26 s cap) the deadline is enforced here as well.
        const gw = deadlineMs === undefined ? await call : await Promise.race([
            call,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('accuracy check ran out of time')), deadlineMs)),
        ]);
        return parseAccuracyVerdict(gw.text);
    } catch (err) {
        console.error('[ai-visibility-accuracy]', err instanceof Error ? err.message : err);
        return null;
    }
}
