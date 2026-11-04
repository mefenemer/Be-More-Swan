// src/utils/site-audit-snapshot.ts — what the Mystery Shopper's CHAT knows about its own checks,
// read per turn (chat-orchestrator.ts route `usesSiteAuditSnapshot`).
//
// Without this the chat can only guess: "what's my score?" gets an invented number, and "I've made
// the headline change" has no fix id to point a card at. Everything here comes from the same rows
// the Website tab shows, so the two cannot disagree. Ids are printed so a card can name them; the
// prompt forbids any id that is not listed.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditBriefs, siteAuditCheckWork, siteAuditFixes, siteAuditItemChecks, siteAuditRuns, siteAudits } from '../../db/schema';
import { itemVerdict } from './site-audit-check-work';
import { websiteHelperFor } from './site-audit-recheck';
import { WEEKDAYS } from './site-audit-setup';
import { asUtcDate, nextCheckDate } from './site-audit-schedule';
import { HANDOFF_TARGETS, type Handoff } from './site-audit-prompts';
import { LENS_LABEL, type CheckOutcome, type Lens, type LensScore } from './site-score';

type Db = ReturnType<typeof getDb>;

const clip = (s: string | null | undefined, n: number) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

const STATUS_WORDS: Record<string, string> = {
    queued: 'is waiting to start', running: 'is running now', done: 'finished', unchanged: 'found nothing had changed',
    unreadable: 'could not read the page (it shows almost no text without JavaScript)', failed: 'did not complete',
};

export async function buildSiteAuditSnapshot(db: Db, orgId: number, assistantId: number): Promise<string> {
    const [audit] = await db.select().from(siteAudits)
        .where(and(eq(siteAudits.aiAssistantId, assistantId), eq(siteAudits.organisationId, orgId))).limit(1);
    if (!audit) {
        return 'YOUR WEBSITE CHECKS RIGHT NOW: no website has been saved yet. Ask for their website address (and, if they like, who it is for and up to three competitors) and propose a site_audit_settings card. Nothing can be checked until it is saved.';
    }

    const competitors = Array.isArray(audit.competitorUrls) ? (audit.competitorUrls as string[]) : [];
    const lines: string[] = [
        'YOUR WEBSITE CHECKS RIGHT NOW (read from the Website tab this turn — use only these facts and numbers):',
        `Site: ${audit.url}`,
        `Ideal customer: ${audit.icp || '(not given)'}`,
        `What visitors should do: ${audit.conversionGoal || '(not given)'}`,
        `Competitors: ${competitors.length ? competitors.join(', ') : '(none)'}`,
        `Weekly check day: ${WEEKDAYS[audit.checkWeekday] ?? 'Monday'}`,
    ];
    if (audit.status === 'goal_met') lines.push(`The page has reached its target (${audit.targetScore}). It is still checked weekly; the Website tab offers the next page to work on.`);

    const runs = await db.select({
        id: siteAuditRuns.id, kind: siteAuditRuns.kind, status: siteAuditRuns.status, overallScore: siteAuditRuns.overallScore,
        error: siteAuditRuns.error, createdAt: siteAuditRuns.createdAt, scores: siteAuditRuns.scores, report: siteAuditRuns.report,
    }).from(siteAuditRuns).where(eq(siteAuditRuns.auditId, audit.id)).orderBy(desc(siteAuditRuns.id)).limit(5);

    const lastCheck = runs.find((r) => r.status !== 'failed');
    if (audit.status !== 'paused') {
        const next = nextCheckDate({ checkWeekday: audit.checkWeekday, lastCheckAt: asUtcDate(lastCheck?.createdAt ?? null) }, new Date());
        lines.push(`Next weekly check: ${new Date(`${next}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}.`);
    }

    // What has been briefed to the other assistants (the Website tab's History). Read apart: before
    // db/z-mystery-shopper-briefs.sql is applied there is simply no record.
    let briefed: Array<{ source: string; runId: number | null; handoffIndex: number | null; targetName: string | null; targetRole: string; title: string | null; brief: string; createdAt: Date }> = [];
    try {
        briefed = await db.select({
            source: siteAuditBriefs.source, runId: siteAuditBriefs.runId, handoffIndex: siteAuditBriefs.handoffIndex,
            targetName: siteAuditBriefs.targetName, targetRole: siteAuditBriefs.targetRole, title: siteAuditBriefs.title,
            brief: siteAuditBriefs.brief, createdAt: siteAuditBriefs.createdAt,
        }).from(siteAuditBriefs).where(and(eq(siteAuditBriefs.auditId, audit.id), eq(siteAuditBriefs.organisationId, orgId)))
            .orderBy(desc(siteAuditBriefs.id)).limit(10);
    } catch { /* table not there yet */ }

    const latestDone = runs.find((r) => r.status === 'done');
    if (latestDone) {
        const lenses = ((latestDone.scores as { lenses?: Record<Lens, LensScore> } | null)?.lenses) ?? null;
        const lensText = lenses
            ? (Object.keys(LENS_LABEL) as Lens[]).map((l) => `${LENS_LABEL[l]} ${lenses[l]?.score ?? 'not scored'}`).join(' · ')
            : '';
        lines.push(`Latest score: ${latestDone.overallScore ?? 'not scored'}/100 on ${day(latestDone.createdAt)}`
            + `${audit.baselineScore !== null ? ` (first check: ${audit.baselineScore})` : ''}; target ${audit.targetScore}.`
            + (lensText ? ` ${lensText}.` : ''));
        const report = latestDone.report as { summary?: string; competitorChanges?: Array<{ url: string; changes: string[] }>; handoffs?: Handoff[] } | null;
        // Briefed or rejected — either way it is no longer waiting.
        const waitingIdeas = (report?.handoffs ?? []).filter((_, i) => !briefed.some((b) => (b.source === 'idea' || b.source === 'rejected_idea') && b.runId === latestDone.id && b.handoffIndex === i));
        if (waitingIdeas.length) {
            lines.push('Ideas that check had for other assistants, not yet briefed (the "Ideas for your other assistants" section of the Website tab):');
            for (const h of waitingIdeas) lines.push(`- for the ${h.target}: ${clip(h.title, 80)} — ${clip(h.brief, 240)}`);
        }
        if (report?.summary) lines.push(`What that check said: ${clip(report.summary, 400)}`);
        const changes = (report?.competitorChanges ?? []).filter((c) => c.changes?.length);
        if (changes.length) {
            lines.push('Competitor changes it noticed:');
            for (const c of changes) lines.push(`- ${c.url}: ${c.changes.slice(0, 3).map((x) => clip(x, 160)).join('; ')}`);
        }
    } else {
        lines.push('No check has produced a score yet.');
    }

    // "Why your score isn't higher" and what they've said about each line, with the ids a
    // site_audit_check_update card names. Read apart: before db/z-mystery-shopper-check-work.sql the
    // tab has no such button, so the chat isn't told about one.
    try {
        const work = await db.select({
            checkId: siteAuditCheckWork.checkId, label: siteAuditCheckWork.label, status: siteAuditCheckWork.status,
            verifiedRunId: siteAuditCheckWork.verifiedRunId, updatedAt: siteAuditCheckWork.updatedAt,
        }).from(siteAuditCheckWork).where(and(
            eq(siteAuditCheckWork.auditId, audit.id), eq(siteAuditCheckWork.organisationId, orgId), eq(siteAuditCheckWork.pageUrl, audit.url),
        )).limit(100);
        const failed = (((latestDone?.scores as { outcomes?: CheckOutcome[] } | null)?.outcomes) ?? [])
            .filter((o) => o.result === 'fail').sort((a, b) => b.weight - a.weight).slice(0, 10);
        if (failed.length) {
            lines.push('"Why your score isn\'t higher", from the latest check (checkId — what is missing — what they said):');
            for (const o of failed) {
                const w = work.find((x) => x.checkId === o.id && x.verifiedRunId === null);
                lines.push(`- ${o.id} — ${clip(o.label, 160)} — ${w ? (w.status === 'accepted' ? `they said they will work on it (${day(w.updatedAt)})` : `they marked it done (${day(w.updatedAt)}), but this check still found it`) : 'not taken on'}`);
            }
        }
        const passed = work.filter((w) => w.verifiedRunId !== null && !failed.some((o) => o.id === w.checkId));
        if (passed.length) lines.push(`Score checks they worked on that the page now passes (Done tab): ${passed.slice(0, 8).map((w) => clip(w.label, 80)).join('; ')}.`);
    } catch { /* table not there yet */ }

    const newest = runs[0];
    if (newest && newest !== latestDone) {
        lines.push(`Most recent check (${day(newest.createdAt)}) ${STATUS_WORDS[newest.status] ?? newest.status}${newest.error ? `: ${clip(newest.error, 200)}` : '.'}`);
    }

    const fixes = await db.select({
        id: siteAuditFixes.id, location: siteAuditFixes.location, before: siteAuditFixes.beforeText, after: siteAuditFixes.afterText,
        status: siteAuditFixes.status, verifiedRunId: siteAuditFixes.verifiedRunId, updatedAt: siteAuditFixes.updatedAt,
    }).from(siteAuditFixes)
        .innerJoin(siteAuditRuns, eq(siteAuditRuns.id, siteAuditFixes.runId))
        .where(and(eq(siteAuditFixes.auditId, audit.id), eq(siteAuditRuns.status, 'done')))
        .orderBy(desc(siteAuditFixes.id)).limit(60);
    const waiting = fixes.filter((f) => f.status === 'open' || f.status === 'accepted');
    const done = fixes.filter((f) => f.status === 'done');
    const dismissed = fixes.filter((f) => f.status === 'dismissed');
    if (waiting.length) {
        lines.push('Suggested fixes waiting (fixId — where — now → suggested — status):');
        for (const f of waiting) {
            const stalled = f.status === 'accepted' && Date.now() - new Date(f.updatedAt).getTime() > 7 * 86_400_000;
            lines.push(`- ${f.id} — ${f.location || 'Page'} — "${clip(f.before, 120)}" → "${clip(f.after, 160)}" — ${f.status === 'accepted' ? `they said they will make it${stalled ? ' (over a week ago, and it is not on the site yet)' : ''}` : 'not decided'}`);
        }
    } else {
        lines.push('No suggested fixes are waiting.');
    }
    // What has changed — the Website tab's "History". Lets the chat answer "what have we changed?".
    if (done.length) {
        lines.push('Fixes that are done (Done tab):');
        for (const f of done.slice(0, 8)) lines.push(`- ${f.id} — ${f.location || 'Page'} — was "${clip(f.before, 100)}", now "${clip(f.after, 140)}" (${f.verifiedRunId !== null ? 'a check confirmed it' : 'they marked it done; no check has confirmed it yet'} ${day(f.updatedAt)})`);
    }
    if (dismissed.length) lines.push(`Fixes they rejected ("Reject", in the Archived tab — "Bring back" or a site_audit_fix_update "open" restores one). Never suggest these again: ${dismissed.slice(0, 8).map((f) => `${f.id} (${f.location || 'Page'})`).join(', ')}.`);
    const sent = briefed.filter((b) => b.source !== 'rejected_idea');
    const turnedDown = briefed.filter((b) => b.source === 'rejected_idea');
    if (sent.length) {
        lines.push('Briefs already sent to their other assistants (In progress, then Done) — do not suggest these again:');
        for (const b of sent) lines.push(`- ${day(b.createdAt)} to ${b.targetName || b.targetRole}: ${clip(b.title || b.brief, 120)}`);
    }
    if (turnedDown.length) {
        lines.push('Ideas for other assistants they rejected (Archived) — never suggest these, or anything like them, again:');
        for (const b of turnedDown) lines.push(`- ${day(b.createdAt)}, for the ${b.targetRole}: ${clip(b.title || b.brief, 120)}`);
    }

    // In progress, for "is it done?": each with the ids a card names, and what its check found.
    try {
        const work = await db.select({ id: siteAuditCheckWork.id, label: siteAuditCheckWork.label }).from(siteAuditCheckWork).where(and(
            eq(siteAuditCheckWork.auditId, audit.id), eq(siteAuditCheckWork.pageUrl, audit.url), eq(siteAuditCheckWork.status, 'accepted'),
        )).limit(30);
        const asks = await db.select({ kind: siteAuditItemChecks.itemKind, itemId: siteAuditItemChecks.itemId, askedAt: siteAuditItemChecks.websiteAskedAt, runStatus: siteAuditRuns.status })
            .from(siteAuditItemChecks).leftJoin(siteAuditRuns, eq(siteAuditRuns.id, siteAuditItemChecks.runId))
            .where(eq(siteAuditItemChecks.auditId, audit.id)).limit(500);
        const FOUND = { checking: 'being checked now', not_checked: 'the check could not read the page, so not confirmed', incomplete: 'NOT done at the last check', nothing_changed: 'NOT done at the last check (nothing on the page had changed)' } as const;
        const found = (kind: string, id: number) => {
            const a = asks.find((x) => x.kind === kind && x.itemId === id);
            const v = itemVerdict(a?.runStatus);
            return `${v ? FOUND[v] : 'not asked to be checked yet'}${a?.askedAt ? '; they asked their Website Assistant to make it, not yet published' : ''}`;
        };
        const accepted = waiting.filter((f) => f.status === 'accepted');
        if (accepted.length || work.length) {
            lines.push('In progress (kind, id — what it is — what the check they asked for found):');
            for (const f of accepted) lines.push(`- fix, ${f.id} — "${clip(f.before, 80)}" → "${clip(f.after, 100)}" — ${found('fix', f.id)}`);
            for (const w of work) lines.push(`- check, ${w.id} — ${clip(w.label, 120)} — ${found('check', w.id)}`);
            const helper = await websiteHelperFor(db, orgId, audit.url);
            lines.push(helper
                ? `Their site is hosted here, so ${helper.name} (their Website Assistant) can make these changes.`
                : 'Their site is not hosted by a working Website Assistant here, so they must make these changes wherever it is built.');
        }
    } catch { /* tables not there yet */ }

    // Who a hand-off can go to. A target role nobody has hired cannot take one.
    const team = await db.select({ name: aiAssistants.name, roleKey: sql<string>`${aiAssistants.configuration} ->> 'type'` })
        .from(aiAssistants).where(and(
            eq(aiAssistants.organisationId, orgId), eq(aiAssistants.isActive, true),
            sql`(${aiAssistants.configuration} ->> 'type') IN (${sql.join(HANDOFF_TARGETS.map((t) => sql`${t}`), sql`, `)})`,
            sql`${aiAssistants.lifecycleStatus} <> 'archived'`,
        ));
    lines.push(team.length
        ? `Their other assistants who can take a hand-off: ${team.map((t) => `${t.name} (${t.roleKey})`).join(', ')}.`
        : 'They have no Social Media, Blog Writing or Campaign Assistant, so no hand-off is possible.');
    return lines.join('\n');
}
