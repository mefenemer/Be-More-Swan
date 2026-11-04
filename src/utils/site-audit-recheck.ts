// src/utils/site-audit-recheck.ts — the Mystery Shopper and the Website Assistant working as a loop:
// "not done yet" → "Ask <Website Assistant> to make this change" → they approve the change and press
// Publish → the Mystery Shopper is told and checks again → Done, or "not done yet" and round again.
//
// Each trip round is started by a person pressing Publish, so the loop can't run on its own and
// spend tasks. And only a Publish that followed such a request starts a check: an unrelated tweak to
// their site doesn't cost a task. Both assistants must be working ones
// ([[assistants-active-teammates-and-expertise]]): a paused or archived one is never offered or told.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditCheckWork, siteAuditFixes, siteAuditItemChecks, siteAudits, sites } from '../../db/schema';
import { resolveSiteHost } from './site-domains';
import { failAuditRun, requestAuditRun } from './site-audit';
import { isCheckWorkTableMissing } from './site-audit-check-work';
import { postTeamMessage } from './team-messages';
import { triggerSiteAudit } from './trigger-site-audit';

type Db = ReturnType<typeof getDb>;

const working = sql`${aiAssistants.isActive} = true AND ${aiAssistants.lifecycleStatus} <> 'archived'`;

/** The workspace's working Website Assistant, when the page being checked is a site it publishes here. */
export async function websiteHelperFor(db: Db, orgId: number, auditUrl: string): Promise<{ id: number; name: string } | null> {
    try {
        const resolved = await resolveSiteHost(db, new URL(auditUrl).hostname);
        if (!resolved?.slug) return null;
        const [row] = await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(sites)
            .innerJoin(aiAssistants, eq(aiAssistants.id, sites.aiAssistantId))
            .where(and(eq(sites.slug, resolved.slug), eq(sites.organisationId, orgId), eq(sites.status, 'published'), working))
            .limit(1);
        return row ?? null;
    } catch (err) {
        console.error('[site-audit-recheck] could not tell whether the site is hosted here', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * A site was just published. If a change on it was asked of the Website Assistant, tell the Mystery
 * Shopper and start its check. Never throws: the site is live whatever happens here.
 */
export async function recheckAfterPublish(db: Db, orgId: number, site: { slug: string | null; aiAssistantId: number }, userId: number | null): Promise<{ assistantName: string } | null> {
    try {
        if (!site.slug) return null;
        const audits = await db.select({ id: siteAudits.id, url: siteAudits.url, shopperId: aiAssistants.id, shopperName: aiAssistants.name })
            .from(siteAudits).innerJoin(aiAssistants, eq(aiAssistants.id, siteAudits.aiAssistantId))
            .where(and(eq(siteAudits.organisationId, orgId), working));
        for (const audit of audits) {
            const asked = await db.select({ id: siteAuditItemChecks.id, kind: siteAuditItemChecks.itemKind, itemId: siteAuditItemChecks.itemId })
                .from(siteAuditItemChecks)
                .where(and(eq(siteAuditItemChecks.auditId, audit.id), isNotNull(siteAuditItemChecks.websiteAskedAt)));
            if (!asked.length) continue;
            const hosted = await resolveSiteHost(db, new URL(audit.url).hostname).catch(() => null);
            if (hosted?.slug !== site.slug) continue;

            // Only what is still being worked on: one finished meanwhile needs no check.
            const ids = (k: string) => asked.filter((a) => a.kind === k).map((a) => a.itemId);
            const fixes = ids('fix').length ? await db.select({ id: siteAuditFixes.id }).from(siteAuditFixes)
                .where(and(inArray(siteAuditFixes.id, ids('fix')), eq(siteAuditFixes.status, 'accepted'))) : [];
            const checks = ids('check').length ? await db.select({ id: siteAuditCheckWork.id }).from(siteAuditCheckWork)
                .where(and(inArray(siteAuditCheckWork.id, ids('check')), eq(siteAuditCheckWork.status, 'accepted'))) : [];
            const open = asked.filter((a) => (a.kind === 'fix' ? fixes : checks).some((x) => x.id === a.itemId));
            if (!open.length) continue;

            const { runId, alreadyRunning } = await requestAuditRun(db, { auditId: audit.id, organisationId: orgId, kind: 'manual', userId });
            if (!alreadyRunning && !(await triggerSiteAudit(runId))) {
                // Leave the request standing, so the next Publish tries again.
                await failAuditRun(db, runId, 'The check couldn\'t be started. Nothing was charged — try again.');
                return null;
            }
            await db.update(siteAuditItemChecks).set({ runId, websiteAskedAt: null, updatedAt: new Date() })
                .where(inArray(siteAuditItemChecks.id, open.map((a) => a.id)));
            await postTeamMessage(db, {
                organisationId: orgId, fromAssistantId: site.aiAssistantId, toAssistantId: audit.shopperId, kind: 'message',
                body: `I've published the website ${open.length === 1 ? 'change' : 'changes'} you flagged. Please check ${open.length === 1 ? 'it' : 'them'} again.`,
                link: { assistantId: audit.shopperId, tab: 'website', label: `Open ${audit.shopperName}` },
            });
            return { assistantName: audit.shopperName };
        }
        return null;
    } catch (err) {
        if (!isCheckWorkTableMissing(err)) console.error('[site-audit-recheck] recheck after publish failed', err instanceof Error ? err.message : err);
        return null;
    }
}
