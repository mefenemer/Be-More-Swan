// src/utils/lead-watch-effects.ts
// What a Watch list signal does beyond being saved (src/utils/lead-watch.ts): the revenue ledger, the
// follow-up halt for a company closing, and the once-a-day note. Kept apart from lead-watch.ts so that
// module's pure parts can be tested without the ledger and the outreach code.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, sequenceEnrolments } from '../../db/schema';
import { haltEnrolment } from './outreach-sequences';
import { recordEvent } from './revenue-ledger';
import { getBlueprintVersion } from './blueprint-version';
import { getIcpSnapshot } from './icp-snapshot';
import { createNotification } from './notify';
import { postTeamMessage } from './team-messages';
import { rollUpText, setDefaultSignalHooks, type RollUpGroup, type SignalHooks } from './lead-watch';

type Db = ReturnType<typeof getDb>;

/** Tab key of the Watch list on the Lead Generator (assistant-dashboard-registry.js watchListTab). */
export const WATCH_TAB = 'watchlist';

/** Stops every active follow-up on a lead whose company is closing. Returns how many stopped. */
export async function haltForCompanyClosing(db: Db, assistantRecordId: number): Promise<number> {
    const rows = await db.select({
        id: sequenceEnrolments.id,
        organisationId: sequenceEnrolments.organisationId,
        aiAssistantId: sequenceEnrolments.aiAssistantId,
        assistantRecordId: sequenceEnrolments.assistantRecordId,
        discoveredLeadId: sequenceEnrolments.discoveredLeadId,
        lastStepSent: sequenceEnrolments.lastStepSent,
    }).from(sequenceEnrolments)
        .where(and(eq(sequenceEnrolments.assistantRecordId, assistantRecordId), eq(sequenceEnrolments.state, 'active')));
    let halted = 0;
    for (const r of rows) {
        // 'company_closed' needs db/sequence-halt-company-closed.sql. Until the owner has run it the
        // CHECK constraint refuses the row and haltEnrolment returns false: stop it as 'manual' with
        // the reason in the detail, so the cadence never keeps sending.
        if (await haltEnrolment(db, r, 'company_closed', 'Companies House shows the company closing')
            || await haltEnrolment(db, r, 'manual', 'Companies House shows the company closing (Watch list)')) halted++;
    }
    return halted;
}

export const watchSignalHooks: SignalHooks = {
    async afterInsert(db, row, sig) {
        if (sig.direction === 'neutral' && !row.assistant_record_id) return;
        await recordEvent(db, 'signal_captured', {
            organisationId: row.organisation_id,
            aiAssistantId: row.ai_assistant_id,
            assistantRecordId: row.assistant_record_id ?? undefined,
            actor: 'system',
            blueprintVersion: await getBlueprintVersion(db, row.ai_assistant_id),
            icpSnapshot: await getIcpSnapshot(db, { discoveredLeadId: null, aiAssistantId: row.ai_assistant_id }),
            payload: { source: 'watch', kind: sig.kind, direction: sig.direction, text: sig.text, url: sig.url, companyNumber: row.ch_number, occurredOn: sig.occurredOn },
        });
        if (sig.kind === 'company_closing' && row.assistant_record_id) {
            await haltForCompanyClosing(db, row.assistant_record_id);
        }
    },
};

setDefaultSignalHooks(watchSignalHooks);

/** The daily note: one Team Chat message and one Inbox notification per assistant. */
export async function notifyRollUp(db: Db, g: RollUpGroup): Promise<void> {
    const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name })
        .from(aiAssistants).where(eq(aiAssistants.id, g.assistantId)).limit(1);
    const { title, body } = rollUpText(g);
    await postTeamMessage(db, {
        organisationId: g.organisationId,
        fromAssistantId: g.assistantId,
        toUser: true,
        kind: 'message',
        body: `${title}. ${body}`,
        link: { assistantId: g.assistantId, tab: WATCH_TAB, label: 'Open the Watch list' },
    });
    if (owner?.userId) {
        await createNotification(db, 'watch_list_news', {
            userId: owner.userId,
            assistantId: g.assistantId,
            context: { assistant: { name: owner.name || 'Your Lead Generator' }, watch: { title, body } },
            metadata: { assistantId: g.assistantId, positive: g.positive, negative: g.negative },
        });
    }
}
