// netlify/functions/site-audit-public.ts
// The Mystery Shopper's free public taster — the ONE unauthenticated way into the pipeline
// (docs/mystery-shopper-plan.md §4.7, page: mystery-shopper.html). Anyone can make us fetch a page
// and call a model from here, so every request passes, in order:
//
//   1. the AI kill switch (platform config global_ai_disabled) — off means off, here too;
//   2. a honeypot field and a minimum fill time — a bot that trips either gets the SAME reply a
//      person would, pointing at a result that just says "couldn't check" (a bot that can tell it
//      was caught adapts — the audience-public.ts rule);
//   3. per-IP and per-email rate limits (src/utils/rate-limit.ts) — the address itself is never
//      stored, only a hash;
//   4. a 24-hour cache: the same page checked again returns the earlier result and costs nothing;
//   5. a platform-wide daily cap on new checks (SITE_TASTER_DAILY_CAP).
//
// POST { action: 'start', url, email, hp, ms }   → 202 { runId, token } | 4xx/503 { error }
// POST { action: 'status', runId, token }        → 200 { status, result? , error? }
//
// The check itself runs in run-site-audit-background.ts (site-audit.ts executeTasterRun).

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { siteAuditRuns } from '../../db/schema';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { looksLikeEmail, normaliseEmail } from '../../src/utils/audience-contacts';
import { warmPlatformConfigCache, CONFIG_KEYS } from '../../src/utils/platform-config';
import { failAuditRun, normaliseSiteUrl, sendTasterEmail } from '../../src/utils/site-audit';
import {
    dailyCap, TASTER_LIMITS, tasterEmailHash, tasterToken, tasterUrlHash, verifyTasterToken, type TasterResult,
} from '../../src/utils/site-taster';
import { triggerSiteAudit } from '../../src/utils/trigger-site-audit';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

const BUSY = 'Lots of people are checking their websites right now. Please try again in a little while.';
const STATUS_WORDS: Record<string, string> = { queued: 'checking', running: 'checking', done: 'done', unreadable: 'done', failed: 'failed' };

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
    const db = getDb();

    if (body.action === 'status') {
        const runId = Number(body.runId);
        if (runId === 0) return json(200, { status: 'failed', error: 'We couldn\'t check that page. Please try again.' });   // the honeypot's run
        if (!Number.isInteger(runId) || runId < 0 || !verifyTasterToken(runId, body.token)) return json(404, { error: 'Result not found.' });
        const [run] = await db.select({ status: siteAuditRuns.status, report: siteAuditRuns.report, error: siteAuditRuns.error })
            .from(siteAuditRuns).where(and(eq(siteAuditRuns.id, runId), eq(siteAuditRuns.kind, 'public_taster'))).limit(1);
        if (!run) return json(404, { error: 'Result not found.' });
        const status = STATUS_WORDS[run.status] ?? 'checking';
        const result = (run.report as { result?: TasterResult } | null)?.result ?? null;
        return json(200, { status, ...(status === 'done' && result ? { result } : {}), ...(status === 'failed' ? { error: run.error || 'We couldn\'t check that page.' } : {}) });
    }

    if (body.action !== 'start') return json(400, { error: 'Unknown action.' });

    // 1. Off switches. No secret → no tokens → no way to read a result, so refuse up front.
    const config = await warmPlatformConfigCache().catch(() => ({} as Record<string, unknown>));
    if (config[CONFIG_KEYS.GLOBAL_AI_DISABLED] === true || !tasterToken(1)) {
        return json(503, { error: 'Free website checks are paused right now. Please try again later.' });
    }

    // 2. A person, not a script. Same reply as success, pointing at a run that reports a failure.
    const ms = Number(body.ms);
    if ((typeof body.hp === 'string' && body.hp.trim()) || !Number.isFinite(ms) || ms < TASTER_LIMITS.minFillMs) {
        return json(202, { runId: 0, token: '0' });
    }

    const url = normaliseSiteUrl(body.url);
    if (!url) return json(400, { error: 'Enter your website address, e.g. yourbusiness.co.uk' });
    const email = normaliseEmail(typeof body.email === 'string' ? body.email : '');
    if (!looksLikeEmail(email)) return json(400, { error: 'Enter your email address so we can send you your result.' });
    const emailHash = tasterEmailHash(email);

    // 3. Limits.
    const ip = getClientIp(event.headers as Record<string, string | undefined>);
    const [byIp, byEmail] = await Promise.all([
        checkRateLimit(db, 'site_taster_ip', ip, TASTER_LIMITS.perIp),
        checkRateLimit(db, 'site_taster_email', emailHash, TASTER_LIMITS.perEmail),
    ]);
    if (!byIp.allowed || !byEmail.allowed) {
        return json(429, { error: 'That is as many free checks as we can run for you today. Hire the Mystery Shopper to check your site every week.' });
    }

    // 4. Cache: the same page, checked in the last 24 hours, by anyone.
    const urlHash = tasterUrlHash(url);
    const cacheFromIso = new Date(Date.now() - TASTER_LIMITS.cacheHours * 3_600_000).toISOString();
    const [cached] = await db.select({ id: siteAuditRuns.id, report: siteAuditRuns.report }).from(siteAuditRuns).where(and(
        eq(siteAuditRuns.kind, 'public_taster'),
        eq(siteAuditRuns.urlHash, urlHash),
        sql`${siteAuditRuns.status} IN ('done', 'unreadable')`,
        gte(siteAuditRuns.createdAt, sql`${cacheFromIso}::timestamp`),
    )).orderBy(desc(siteAuditRuns.id)).limit(1);
    if (cached) {
        const result = (cached.report as { result?: TasterResult } | null)?.result;
        if (result) await sendTasterEmail(cached.id, result, email);
        return json(202, { runId: cached.id, token: tasterToken(cached.id), cached: true });
    }

    // 5. The daily cap on NEW checks (cache hits above never count).
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(siteAuditRuns).where(and(
        eq(siteAuditRuns.kind, 'public_taster'),
        gte(siteAuditRuns.createdAt, sql`${todayStart}::timestamp`),
    ));
    if (Number(n) >= dailyCap()) return json(503, { error: BUSY });

    const [run] = await db.insert(siteAuditRuns).values({
        kind: 'public_taster', status: 'queued', report: { url }, urlHash, emailHash,
    }).returning({ id: siteAuditRuns.id });
    if (!(await triggerSiteAudit(run.id, { emailTo: email }))) {
        await failAuditRun(db, run.id, 'The check couldn\'t be started.');
        return json(503, { error: BUSY });
    }
    return json(202, { runId: run.id, token: tasterToken(run.id) });
});
