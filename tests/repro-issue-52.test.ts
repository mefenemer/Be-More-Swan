// tests/repro-issue-52.test.ts
// Issue #52 (prod): "Business plan sections missing after saving one section". Workspace 40 had NO saved
// business plan; the Plan tab showed every section pre-filled from Business Information (prefillStrategy).
// A Business Mentor chat card saved just "problem": saveStrategyDraft created the first draft from that one
// section, so the pre-filled customer / offer / pricing / channels disappeared. (The Plan tab's own Save
// already merges the pre-fill; the chat card's save did not.) Runs the REAL saveStrategyDraft on a fake DB.
import assert from 'node:assert';
import { saveStrategyDraft } from '../src/utils/strategy-documents';

const inserted: any[] = [];
const chain = (rows: any[]) => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) });
const tx: any = {
    execute: async () => [],
    select: () => chain([]),                                  // no draft, nothing approved: a first save
    insert: () => ({ values: (v: any) => { inserted.push(v); return { returning: async () => [{ id: 1, createdAt: new Date(), updatedAt: new Date(), ...v }] }; } }),
    update: () => { throw new Error('no draft exists, nothing to update'); },
};
const db: any = { transaction: (fn: any) => fn(tx) };

// What the Plan tab was showing, from Business Information.
const prefill = { sections: { customer: 'Women 40+ changing their health', offer: 'Nurse coaching sessions', pricing: '£90 a session', channels: 'Instagram and referrals' } };

(async () => {
    // The chat card's save: only the section the owner asked for, as mentor.ts strategy_save receives it.
    const r = await saveStrategyDraft(db, 40, 41, 'business_plan', { sections: { problem: 'Burnout after decades in nursing.' } }, { startFrom: prefill } as any);
    assert.ok(r.ok, 'saved');
    const body = inserted[0]?.body;
    assert.strictEqual(body.sections.problem, 'Burnout after decades in nursing.', 'the asked-for section is saved');
    for (const k of ['customer', 'offer', 'pricing', 'channels']) {
        assert.strictEqual(body.sections[k], (prefill.sections as any)[k], `the pre-filled "${k}" the page showed is kept, not emptied`);
    }
    console.log('repro-issue-52: passed');
})().catch((e) => { console.error(e); process.exit(1); });
