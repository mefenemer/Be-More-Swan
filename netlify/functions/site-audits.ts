// netlify/functions/site-audits.ts
// The Mystery Shopper's API — the ONE server path both surfaces use: the assistant's screens and the
// chat cards (docs/mystery-shopper-plan.md §4.6). Chat proposes; only a human click on either
// surface saves settings, starts a check (which can spend a task) or changes a fix.
//
// POST { action, … }
//   get        { assistantId }                       → the audit, recent runs, the latest report, fixes
//   save       { assistantId, url?, icp?, conversionGoal?, competitorUrls?, checkWeekday? }
//                                                    → fields not sent keep their value; writes the
//                                                      set-up answers too (site-audit-setup.ts)
//   performance { assistantId }                      → the four KPI cards
//   calendar   { assistantId, from, to }             → checks that ran in the window (calendar.js)
//   run        { assistantId }                       → queue a check (baseline the first time); returns runId
//   run_status { runId }                             → poll a check
//   fix        { fixId, status: 'accepted'|'dismissed'|'open'|'done' }
//   brief      { assistantId, source: 'idea', runId, handoffIndex }   → a "Brief <name>" click: the
//              { assistantId, source: 'stalled_fix', fixId }            suggestion is actioned and moves
//              { assistantId, source: 'chat', target, title?, brief }   to History (site_audit_briefs)
//   unbrief    { briefId }                           → undo a brief that was clicked by mistake
//
// A check marks a fix done when the old text has gone or the suggested text is on the page
// (site-audit.ts fixesNowDone) and records which run proved it (verified_run_id). The user can also
// say "I've made this change" (status 'done', verified_run_id NULL): a check can't always see the
// change — a long testimonial is read only in part — and the next check that can see it confirms it.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, contentRules, siteAuditBriefs, siteAuditFixes, siteAuditRuns, siteAudits } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { MYSTERY_SHOPPER_ROLE_KEY } from '../../src/constants/roles';
import { failAuditRun, MAX_COMPETITORS, requestAuditRun, sweepStuckAuditRuns } from '../../src/utils/site-audit';
import { CONVERSION_GOALS, saveSiteAuditSettings, WEEKDAYS } from '../../src/utils/site-audit-setup';
import { asUtcDate, nextCheckDate } from '../../src/utils/site-audit-schedule';
import { HANDOFF_TARGETS, type Handoff } from '../../src/utils/site-audit-prompts';
import { plainLocation } from '../../src/utils/site-score';
import { pickSecondaryPages, type SitePage } from '../../src/utils/site-extract';

/** A fix the user said they'd make that a check has not found on the site for this long. */
const STALLED_DAYS = 7;
import { triggerSiteAudit } from '../../src/utils/trigger-site-audit';
import { stalledFixBrief } from '../../src/utils/site-audit-briefs';

// 'rejected_idea' is not a brief: it records an idea the user turned down, so it leaves To review for
// Archived and later checks are told not to suggest it again (site-audit-covered.ts). Needs
// db/z-mystery-shopper-rejected-ideas.sql (the table's CHECK lists the sources).
const BRIEF_SOURCES = ['idea', 'stalled_fix', 'chat', 'rejected_idea'] as const;
/** Postgres: relation does not exist — db/z-mystery-shopper-briefs.sql not applied yet. */
const isMissingTable = (err: unknown) => (err as { code?: string })?.code === '42P01'
    || /site_audit_briefs/.test(String((err as Error)?.message ?? '')) && /does not exist/.test(String((err as Error)?.message ?? ''));

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const USER_FIX_STATUSES = ['accepted', 'dismissed', 'open', 'done'] as const;

/** Run fields the screens need — never `pages`, which is large and for the server's own comparisons. */
const RUN_SUMMARY = {
    id: siteAuditRuns.id, kind: siteAuditRuns.kind, status: siteAuditRuns.status, overallScore: siteAuditRuns.overallScore,
    error: siteAuditRuns.error, createdAt: siteAuditRuns.createdAt, finishedAt: siteAuditRuns.finishedAt,
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    /** IDOR + role guard: only THIS organisation's Mystery Shopper. */
    async function requireShopper(raw: unknown) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) return null;
        const [a] = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(
            eq(aiAssistants.id, id),
            eq(aiAssistants.organisationId, orgId),
            sql`(${aiAssistants.configuration} ->> 'type') = ${MYSTERY_SHOPPER_ROLE_KEY}`,
        )).limit(1);
        return a ?? null;
    }

    async function auditFor(assistantId: number) {
        const [a] = await db.select().from(siteAudits)
            .where(and(eq(siteAudits.aiAssistantId, assistantId), eq(siteAudits.organisationId, orgId))).limit(1);
        return a ?? null;
    }

    if (action === 'get') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });
        const audit = await auditFor(shopper.id);
        const vocab = { conversionGoals: CONVERSION_GOALS.map((g) => g.label), weekdays: WEEKDAYS, maxCompetitors: MAX_COMPETITORS };
        if (!audit) return json(200, { audit: null, runs: [], latest: null, fixes: [], vocab });

        await sweepStuckAuditRuns(db, audit.id);
        const runs = await db.select(RUN_SUMMARY).from(siteAuditRuns)
            .where(eq(siteAuditRuns.auditId, audit.id)).orderBy(desc(siteAuditRuns.id)).limit(12);
        const [latest] = await db.select({ ...RUN_SUMMARY, scores: siteAuditRuns.scores, report: siteAuditRuns.report })
            .from(siteAuditRuns)
            .where(and(eq(siteAuditRuns.auditId, audit.id), eq(siteAuditRuns.status, 'done')))
            .orderBy(desc(siteAuditRuns.id)).limit(1);

        // The score over the last year, oldest first, for the Results tab's line chart — every check
        // that scored ('done') or kept its score ('unchanged'). And the three parts from the check
        // before the latest, so each bar can say whether it went up or down.
        const history = (await db.select({
            id: siteAuditRuns.id, status: siteAuditRuns.status, score: siteAuditRuns.overallScore,
            at: sql<Date>`coalesce(${siteAuditRuns.finishedAt}, ${siteAuditRuns.createdAt})`,
            lenses: sql<Record<string, { score: number | null }> | null>`${siteAuditRuns.scores} -> 'lenses'`,
        }).from(siteAuditRuns).where(and(
            eq(siteAuditRuns.auditId, audit.id),
            inArray(siteAuditRuns.status, ['done', 'unchanged']),
            sql`${siteAuditRuns.overallScore} IS NOT NULL`,
            sql`${siteAuditRuns.createdAt} > now() - interval '366 days'`,
        )).orderBy(asc(siteAuditRuns.id)).limit(400));
        const scored = history.filter((h) => h.status === 'done' && h.lenses);
        const previousLenses = latest && scored.length > 1 && scored[scored.length - 1].id === latest.id
            ? scored[scored.length - 2].lenses : null;
        const scoreHistory = history.map((h) => ({ at: h.at, score: h.score }));
        // Fixes from runs that finished. A run swept as stuck after writing its fixes never showed
        // its report, so its fixes must not appear either.
        // plainLocation: rows saved before 2026-10-18 can carry a field name ("pricingAndGuarantees").
        const fixes = (await db.select({
            id: siteAuditFixes.id, runId: siteAuditFixes.runId, lens: siteAuditFixes.lens, location: siteAuditFixes.location,
            problem: siteAuditFixes.problem, beforeText: siteAuditFixes.beforeText, afterText: siteAuditFixes.afterText,
            whyItMatters: siteAuditFixes.whyItMatters, impact: siteAuditFixes.impact, status: siteAuditFixes.status,
            verifiedRunId: siteAuditFixes.verifiedRunId, createdAt: siteAuditFixes.createdAt, updatedAt: siteAuditFixes.updatedAt,
        }).from(siteAuditFixes)
            .innerJoin(siteAuditRuns, eq(siteAuditRuns.id, siteAuditFixes.runId))
            .where(and(eq(siteAuditFixes.auditId, audit.id), eq(siteAuditRuns.status, 'done')))
            // Every fix, not the latest few: History lists the done and dismissed ones (paged in the tab).
            .orderBy(desc(siteAuditFixes.id)).limit(1000))
            .map((f) => ({ ...f, location: f.location ? plainLocation(f.location) : f.location }));

        // Who can take a hand-off brief: this workspace's working Social / Blog / Campaign assistants.
        // The Website tab opens their chat with the brief typed in — the user sends it.
        const team = await db.select({
            id: aiAssistants.id, name: aiAssistants.name, roleKey: sql<string>`${aiAssistants.configuration} ->> 'type'`,
        }).from(aiAssistants).where(and(
            eq(aiAssistants.organisationId, orgId),
            eq(aiAssistants.isActive, true),
            sql`(${aiAssistants.configuration} ->> 'type') IN (${sql.join(HANDOFF_TARGETS.map((t) => sql`${t}`), sql`, `)})`,
            sql`${aiAssistants.lifecycleStatus} <> 'archived'`,
        ));

        // Accepted a week or more ago and still not on the page — the tab offers to say it elsewhere
        // in the meantime (plan §4.5, "implementation stall").
        const stalledBefore = Date.now() - STALLED_DAYS * 86_400_000;
        const stalled = fixes
            .filter((f) => f.status === 'accepted' && new Date(f.updatedAt).getTime() < stalledBefore)
            .map((f) => f.id);

        // The next weekly check, from the last check that completed or is running.
        const [last] = await db.select({ at: sql<Date | string | null>`max(${siteAuditRuns.createdAt})` }).from(siteAuditRuns)
            .where(and(eq(siteAuditRuns.auditId, audit.id), sql`${siteAuditRuns.status} <> 'failed'`));
        const nextCheck = audit.status === 'paused' ? null
            : nextCheckDate({ checkWeekday: audit.checkWeekday, lastCheckAt: asUtcDate(last?.at ?? null) }, new Date());

        // Target reached: suggest the next page worth working on, from the links on the page itself.
        let nextPages: string[] = [];
        if (audit.status === 'goal_met' && latest) {
            const [pagesRow] = await db.select({ pages: siteAuditRuns.pages }).from(siteAuditRuns).where(eq(siteAuditRuns.id, latest.id)).limit(1);
            const sitePage = (pagesRow?.pages as Record<string, SitePage> | null)?.site;
            if (sitePage) nextPages = pickSecondaryPages(sitePage, 2);
        }

        // History: every check's ideas for the other assistants (the latest check's are also shown on
        // their own until briefed), and what was briefed. The ideas stay in each run's report — the
        // record of what the check said; site_audit_briefs is the record of what the user did.
        const pastIdeas = (await db.select({
            runId: siteAuditRuns.id, at: siteAuditRuns.createdAt,
            handoffs: sql<Handoff[] | null>`${siteAuditRuns.report} -> 'handoffs'`,
        }).from(siteAuditRuns).where(and(
            eq(siteAuditRuns.auditId, audit.id), eq(siteAuditRuns.status, 'done'),
            sql`jsonb_typeof(${siteAuditRuns.report} -> 'handoffs') = 'array'`,
        )).orderBy(desc(siteAuditRuns.id)).limit(500))
            .filter((r) => Array.isArray(r.handoffs) && r.handoffs.length);

        // Read apart from everything else: before db/z-mystery-shopper-briefs.sql is applied the tab
        // still works, it just has no record of briefs (and `briefsAvailable` says so).
        let briefs: Array<typeof siteAuditBriefs.$inferSelect> = [];
        let briefsAvailable = true;
        try {
            briefs = await db.select().from(siteAuditBriefs)
                .where(and(eq(siteAuditBriefs.auditId, audit.id), eq(siteAuditBriefs.organisationId, orgId)))
                .orderBy(desc(siteAuditBriefs.id)).limit(1000);
        } catch (err) {
            if (!isMissingTable(err)) throw err;
            briefsAvailable = false;
        }

        const { lastHashes: _h, ...auditOut } = audit;
        return json(200, {
            audit: auditOut, runs, latest: latest ?? null, fixes, vocab, team, stalled, nextCheck, nextPages,
            pastIdeas, briefs, briefsAvailable, scoreHistory, previousLenses,
        });
    }

    if (action === 'save') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });

        // Free text that goes into every model prompt this assistant makes.
        const words = [body.icp, body.conversionGoal].filter((x) => typeof x === 'string' && x.trim()).join('\n');
        if (words) {
            const blocked = await enforcePromptModeration({ text: words, userId, organisationId: orgId, source: 'site-audits' });
            if (blocked) return blocked;
        }

        const raw: Record<string, unknown> = {};
        for (const k of ['url', 'icp', 'conversionGoal', 'competitorUrls', 'checkWeekday']) {
            if (Object.prototype.hasOwnProperty.call(body, k)) raw[k] = body[k];
        }
        const result = await saveSiteAuditSettings(db, { assistantId: shopper.id, orgId, userId, raw });
        if (!result.ok) return json(400, { error: result.error });
        const saved = result.audit;
        const { lastHashes: _h, ...auditOut } = saved;
        // `started`: this save was the first time the site was known, so the first check began.
        return json(200, { audit: auditOut, started: result.started });
    }

    if (action === 'run') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });
        const audit = await auditFor(shopper.id);
        if (!audit) return json(400, { error: 'Add your website first.' });

        await sweepStuckAuditRuns(db, audit.id);
        const kind = audit.currentScore === null && audit.lastRunId === null ? 'baseline' : 'manual';
        const { runId, alreadyRunning } = await requestAuditRun(db, { auditId: audit.id, organisationId: orgId, kind, userId });
        if (!alreadyRunning && !(await triggerSiteAudit(runId))) {
            await failAuditRun(db, runId, 'The check couldn\'t be started. Nothing was charged — try again.');
            return json(503, { error: 'The check couldn\'t be started. Nothing was charged — try again.', runId });
        }
        return json(202, { runId, alreadyRunning });
    }

    if (action === 'performance') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });
        const audit = await auditFor(shopper.id);
        if (!audit || audit.lastRunId === null) return json(200, { hasData: false });
        const [counts] = await db.select({
            done: sql<number>`count(*) FILTER (WHERE ${siteAuditFixes.status} = 'done')::int`,
            waiting: sql<number>`count(*) FILTER (WHERE ${siteAuditFixes.status} IN ('open', 'accepted'))::int`,
        }).from(siteAuditFixes)
            .innerJoin(siteAuditRuns, eq(siteAuditRuns.id, siteAuditFixes.runId))
            .where(and(eq(siteAuditFixes.auditId, audit.id), eq(siteAuditRuns.status, 'done')));
        // Competitor changes seen in the last 30 days: one line per changed field, per run.
        const [changes] = await db.select({
            n: sql<number>`COALESCE(SUM((SELECT COALESCE(SUM(jsonb_array_length(c->'changes')), 0) FROM jsonb_array_elements(${siteAuditRuns.changes}) c)), 0)::int`,
        }).from(siteAuditRuns).where(and(
            eq(siteAuditRuns.auditId, audit.id),
            eq(siteAuditRuns.status, 'done'),
            sql`${siteAuditRuns.changes} IS NOT NULL AND jsonb_typeof(${siteAuditRuns.changes}) = 'array'`,
            sql`${siteAuditRuns.createdAt} > now() - interval '30 days'`,
        ));
        return json(200, {
            hasData: true,
            metrics: {
                score: audit.currentScore,
                baseline: audit.baselineScore,
                target: audit.targetScore,
                fixesDone: Number(counts?.done ?? 0),
                fixesWaiting: Number(counts?.waiting ?? 0),
                competitorChanges: Number(changes?.n ?? 0),
                competitorCount: Array.isArray(audit.competitorUrls) ? audit.competitorUrls.length : 0,
            },
        });
    }

    if (action === 'calendar') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });
        const from = new Date(String(body.from || ''));
        const to = new Date(String(body.to || ''));
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return json(400, { error: 'from and to required.' });
        const audit = await auditFor(shopper.id);
        if (!audit) return json(200, { items: [] });
        const runs = await db.select({ id: siteAuditRuns.id, status: siteAuditRuns.status, score: siteAuditRuns.overallScore, at: siteAuditRuns.createdAt })
            .from(siteAuditRuns).where(and(
                eq(siteAuditRuns.auditId, audit.id),
                inArray(siteAuditRuns.status, ['done', 'unchanged', 'unreadable', 'failed']),
                sql`${siteAuditRuns.createdAt} >= ${from.toISOString()} AND ${siteAuditRuns.createdAt} < ${to.toISOString()}`,
            )).orderBy(siteAuditRuns.id).limit(200);
        const title = (r: typeof runs[number]) => r.status === 'done' ? `Scored ${r.score ?? '—'}/100`
            : r.status === 'unchanged' ? 'Nothing had changed' : r.status === 'unreadable' ? 'Could not read the page' : 'Did not complete';
        const items: Array<{ id: number | string; at: Date | string; title: string; done: boolean }> =
            runs.map((r) => ({ id: r.id, at: r.at, title: title(r), done: r.status === 'done' || r.status === 'unchanged' }));
        // The next weekly check (dispatch-site-audits.ts), when it falls in the window. Only the next
        // one: a paused audit, or a page change, would make any further dates a promise we can't keep.
        if (audit.status !== 'paused') {
            const [last] = await db.select({ at: sql<Date | string | null>`max(${siteAuditRuns.createdAt})` }).from(siteAuditRuns)
                .where(and(eq(siteAuditRuns.auditId, audit.id), sql`${siteAuditRuns.status} <> 'failed'`));
            const next = nextCheckDate({ checkWeekday: audit.checkWeekday, lastCheckAt: asUtcDate(last?.at ?? null) }, new Date());
            const at = new Date(`${next}T12:00:00Z`);
            if (at >= from && at < to) items.push({ id: `next-${next}`, at, title: 'Weekly check due', done: false });
        }
        return json(200, { items });
    }

    if (action === 'run_status') {
        const runId = Number(body.runId);
        if (!Number.isInteger(runId) || runId <= 0) return json(400, { error: 'runId required.' });
        const [run] = await db.select({ ...RUN_SUMMARY, scores: siteAuditRuns.scores, report: siteAuditRuns.report })
            .from(siteAuditRuns)
            .where(and(eq(siteAuditRuns.id, runId), eq(siteAuditRuns.organisationId, orgId))).limit(1);
        if (!run) return json(404, { error: 'Check not found.' });
        return json(200, { run });
    }

    if (action === 'fix') {
        const fixId = Number(body.fixId);
        const status = String(body.status || '');
        if (!Number.isInteger(fixId) || fixId <= 0) return json(400, { error: 'fixId required.' });
        if (!(USER_FIX_STATUSES as readonly string[]).includes(status)) return json(400, { error: 'Unknown status.' });
        const [updated] = await db.update(siteAuditFixes)
            .set({ status, updatedAt: new Date() })
            .where(and(
                eq(siteAuditFixes.id, fixId),
                eq(siteAuditFixes.organisationId, orgId),
                // A fix a check verified stays done — the page proved it. One the user marked done can be undone.
                sql`(${siteAuditFixes.status} IN ('open', 'accepted', 'dismissed') OR (${siteAuditFixes.status} = 'done' AND ${siteAuditFixes.verifiedRunId} IS NULL))`,
            ))
            .returning({ id: siteAuditFixes.id, status: siteAuditFixes.status, auditId: siteAuditFixes.auditId, afterText: siteAuditFixes.afterText });
        if (!updated) return json(404, { error: 'Fix not found, or a check has already confirmed it.' });

        // Rejecting with a reason teaches the assistant: the reason becomes one of its Rules, which every
        // check reads (loadAssistantRulesBlock → brief.rulesBlock), so it stops the whole kind of
        // suggestion. Rejected fixes themselves are also listed to every later check (site-audit.ts).
        // Best-effort: the rejection stands even if the rule can't be saved.
        let ruleId: number | null = null;
        const reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
        if (status === 'dismissed' && reason) {
            try {
                const [audit] = await db.select({ assistantId: siteAudits.aiAssistantId }).from(siteAudits)
                    .where(and(eq(siteAudits.id, updated.auditId), eq(siteAudits.organisationId, orgId))).limit(1);
                if (audit) {
                    const [rule] = await db.insert(contentRules).values({
                        assistantId: audit.assistantId, workspaceId: orgId,
                        ruleText: `Website suggestions: ${reason}`,
                        note: `Said when rejecting the suggestion "${updated.afterText.slice(0, 200)}"`,
                        createdByUserId: userId, isActive: true, origin: 'rejection_feedback',
                    }).returning({ id: contentRules.id });
                    ruleId = rule?.id ?? null;
                }
            } catch (err) {
                console.error('[site-audits] rejection reason not saved as a rule', err instanceof Error ? err.message : err);
            }
        }
        return json(200, { fix: { id: updated.id, status: updated.status }, ruleId });
    }

    if (action === 'brief') {
        const shopper = await requireShopper(body.assistantId);
        if (!shopper) return json(404, { error: 'Assistant not found.' });
        const audit = await auditFor(shopper.id);
        if (!audit) return json(400, { error: 'Add your website first.' });
        const source = String(body.source || '');
        if (!(BRIEF_SOURCES as readonly string[]).includes(source)) return json(400, { error: 'Unknown brief.' });

        // What was briefed, read from the server's own rows wherever there are some — never the
        // browser's copy of a check's idea or a fix's wording.
        let target = '';
        let title: string | null = null;
        let brief = '';
        let runId: number | null = null;
        let handoffIndex: number | null = null;
        let fixId: number | null = null;
        if (source === 'idea' || source === 'rejected_idea') {
            runId = Number(body.runId);
            handoffIndex = Number(body.handoffIndex);
            if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(handoffIndex) || handoffIndex < 0) return json(400, { error: 'runId and handoffIndex required.' });
            const [run] = await db.select({ report: siteAuditRuns.report }).from(siteAuditRuns)
                .where(and(eq(siteAuditRuns.id, runId), eq(siteAuditRuns.auditId, audit.id), eq(siteAuditRuns.status, 'done'))).limit(1);
            const h = ((run?.report as { handoffs?: Handoff[] } | null)?.handoffs ?? [])[handoffIndex];
            if (!h) return json(404, { error: 'That idea was not found.' });
            target = h.target; title = h.title || null; brief = h.brief;
        } else if (source === 'stalled_fix') {
            fixId = Number(body.fixId);
            if (!Number.isInteger(fixId) || fixId <= 0) return json(400, { error: 'fixId required.' });
            const [fix] = await db.select({ location: siteAuditFixes.location, afterText: siteAuditFixes.afterText }).from(siteAuditFixes)
                .where(and(eq(siteAuditFixes.id, fixId), eq(siteAuditFixes.auditId, audit.id))).limit(1);
            if (!fix) return json(404, { error: 'Fix not found.' });
            target = 'social_media_manager';
            title = `A post with the new wording${fix.location ? ` (${plainLocation(fix.location)})` : ''}`;
            brief = stalledFixBrief(fix.afterText);
        } else {
            target = String(body.target || '');
            brief = String(body.brief || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
            title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
            if (!brief) return json(400, { error: 'brief required.' });
        }
        if (!(HANDOFF_TARGETS as readonly string[]).includes(target)) return json(400, { error: 'Unknown assistant.' });

        // Who it went to: this workspace's working assistant in that role (as the tab's `team` lists).
        const [who] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants).where(and(
            eq(aiAssistants.organisationId, orgId),
            eq(aiAssistants.isActive, true),
            sql`(${aiAssistants.configuration} ->> 'type') = ${target}`,
            sql`${aiAssistants.lifecycleStatus} <> 'archived'`,
        )).orderBy(aiAssistants.id).limit(1);
        // A rejection goes to nobody, so it needs no assistant in that role.
        if (!who && source !== 'rejected_idea') return json(400, { error: 'You don\'t have that assistant yet.' });

        try {
            const [row] = await db.insert(siteAuditBriefs).values({
                auditId: audit.id, organisationId: orgId, source, runId, handoffIndex, fixId,
                targetRole: target, targetAssistantId: who?.id ?? null, targetName: who?.name ?? null, title, brief, briefedBy: userId,
            }).onConflictDoNothing().returning();
            // Already actioned (a second click, or the other surface got there first) — not an error.
            return json(200, { brief: row ?? null, already: !row, assistantId: who?.id ?? null });
        } catch (err) {
            // Before db/z-mystery-shopper-rejected-ideas.sql the table's CHECK refuses the new source.
            if ((err as { code?: string })?.code === '23514' && source === 'rejected_idea') {
                return json(503, { error: 'Rejecting ideas isn\'t switched on yet — it needs a database update.', code: 'REJECT_UNAVAILABLE' });
            }
            if (!isMissingTable(err)) throw err;
            return json(503, { error: 'Briefs can\'t be recorded yet — the chat still opened.', code: 'BRIEFS_UNAVAILABLE' });
        }
    }

    if (action === 'unbrief') {
        const briefId = Number(body.briefId);
        if (!Number.isInteger(briefId) || briefId <= 0) return json(400, { error: 'briefId required.' });
        try {
            const [gone] = await db.delete(siteAuditBriefs)
                .where(and(eq(siteAuditBriefs.id, briefId), eq(siteAuditBriefs.organisationId, orgId)))
                .returning({ id: siteAuditBriefs.id });
            if (!gone) return json(404, { error: 'Brief not found.' });
            return json(200, { ok: true });
        } catch (err) {
            if (!isMissingTable(err)) throw err;
            return json(404, { error: 'Brief not found.' });
        }
    }

    return json(400, { error: 'Unknown action.' });
});
