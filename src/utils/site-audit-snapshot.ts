// src/utils/site-audit-snapshot.ts — what the Mystery Shopper's CHAT knows about its own checks,
// read per turn (chat-orchestrator.ts route `usesSiteAuditSnapshot`).
//
// Without this the chat can only guess: "what's my score?" gets an invented number, and "I've made
// the headline change" has no fix id to point a card at. Everything here comes from the same rows
// the Website tab shows, so the two cannot disagree. Ids are printed so a card can name them; the
// prompt forbids any id that is not listed.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditFixes, siteAuditRuns, siteAudits } from '../../db/schema';
import { WEEKDAYS } from './site-audit-setup';
import { asUtcDate, nextCheckDate } from './site-audit-schedule';
import { HANDOFF_TARGETS, type Handoff } from './site-audit-prompts';
import { LENS_LABEL, type Lens, type LensScore } from './site-score';

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
        if (report?.handoffs?.length) {
            lines.push('Ideas that check had for other assistants (the "Ideas for your other assistants" section of the Website tab):');
            for (const h of report.handoffs) lines.push(`- for the ${h.target}: ${clip(h.title, 80)} — ${clip(h.brief, 240)}`);
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

    const newest = runs[0];
    if (newest && newest !== latestDone) {
        lines.push(`Most recent check (${day(newest.createdAt)}) ${STATUS_WORDS[newest.status] ?? newest.status}${newest.error ? `: ${clip(newest.error, 200)}` : '.'}`);
    }

    const fixes = await db.select({
        id: siteAuditFixes.id, location: siteAuditFixes.location, before: siteAuditFixes.beforeText, after: siteAuditFixes.afterText,
        status: siteAuditFixes.status, updatedAt: siteAuditFixes.updatedAt,
    }).from(siteAuditFixes)
        .innerJoin(siteAuditRuns, eq(siteAuditRuns.id, siteAuditFixes.runId))
        .where(and(eq(siteAuditFixes.auditId, audit.id), eq(siteAuditRuns.status, 'done')))
        .orderBy(desc(siteAuditFixes.id)).limit(20);
    const waiting = fixes.filter((f) => f.status === 'open' || f.status === 'accepted');
    const done = fixes.filter((f) => f.status === 'done');
    if (waiting.length) {
        lines.push('Suggested fixes waiting (fixId — where — now → suggested — status):');
        for (const f of waiting) {
            const stalled = f.status === 'accepted' && Date.now() - new Date(f.updatedAt).getTime() > 7 * 86_400_000;
            lines.push(`- ${f.id} — ${f.location || 'Page'} — "${clip(f.before, 120)}" → "${clip(f.after, 160)}" — ${f.status === 'accepted' ? `they said they will make it${stalled ? ' (over a week ago, and it is not on the site yet)' : ''}` : 'not decided'}`);
        }
    } else {
        lines.push('No suggested fixes are waiting.');
    }
    if (done.length) lines.push(`Fixes a later check confirmed are live: ${done.slice(0, 5).map((f) => `${f.id} (${f.location || 'Page'})`).join(', ')}.`);

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
