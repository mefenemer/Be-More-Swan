// tests/chat-schedule.test.ts
// The Social Media and Blog Writer chats see their posting schedule and propose changing how often,
// which days, what times and which timezone through a card — saved through update-assistant-context.ts,
// the endpoint the Posting Schedule card autosaves through.
//
// WHY THIS EXISTS. "Post on Tuesdays and Thursdays at 8am instead" could only be done on the page.
// That endpoint REPLACES the whole setup context, so these pin the dangerous part: the card carries
// ONLY the keys that change, and the click reads the context at the moment of the click and merges
// just those keys — never a copy from when the card was drawn. And the page's own copy of the context
// is updated, so its next autosave cannot write the old schedule back.
//
// Run:  npx tsx tests/chat-schedule.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    hasPostingSchedule, refreshScheduleCards, resolveScheduleProposal, scheduleProposalFromUiElement, schedulePromptBlock,
} from '../src/utils/chat-schedule';
import { SETTINGS_BY_ROLE } from '../src/utils/chat-assistant-settings';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
            return chain;
        },
    } as any;
}
const CTX = { posting_frequency: '3 times a week', posting_days: ['mon', 'wed', 'fri'], posting_times: ['09:00'], posting_timezone: 'Europe/London', tone_of_voice: 'warm' };
const propose = (x: Record<string, unknown>) => scheduleProposalFromUiElement({ type: 'schedule_proposal', ...x })!;

async function main() {
    console.log('\nNormalised with the Posting Schedule card\'s vocabulary');

    await check('days in week order, times as HH:MM, a frequency label, a real timezone', () => {
        const r = propose({ days: ['Thursday', 'tue', 'tue'], times: ['8:00', '17:30'], frequency: '2x_week', timezone: 'America/New_York' });
        assert.deepStrictEqual(r.days, ['tue', 'thu']);
        assert.deepStrictEqual(r.times, ['08:00', '17:30']);
        assert.strictEqual(r.frequency, '2 times a week');
        assert.strictEqual(r.timezone, 'America/New_York');
        assert.deepStrictEqual(r.invalid, []);
    });
    await check('nonsense is collected as a reason, not saved', () => {
        const r = propose({ days: ['someday'], times: ['noonish'], timezone: 'Mars/Olympus', frequency: 'hourly' });
        assert.strictEqual(r.invalid.length, 4);
        assert.strictEqual(scheduleProposalFromUiElement({ type: 'schedule_proposal' }), null);
    });

    console.log('\nThe card carries only what changes');

    await check('only changed keys go in `set`; now and after are both described', async () => {
        const card = await resolveScheduleProposal(fakeDb([{ ctx: CTX }]), 1, 5, 'social_media_manager', propose({ days: ['tue', 'thu'], times: ['09:00'] }));
        assert.deepStrictEqual(card?.set, { posting_days: ['tue', 'thu'] }, 'the unchanged time is not sent');
        assert.match(card?.current ?? '', /Mon, Wed, Fri · at 09:00/);
        assert.match(card?.proposed ?? '', /Tue, Thu · at 09:00/);
        assert.strictEqual(card?.blocked, null);
    });
    await check('no change, a role without the card, or invalid parts are refused', async () => {
        const same = await resolveScheduleProposal(fakeDb([{ ctx: CTX }]), 1, 5, 'social_media_manager', propose({ timezone: 'Europe/London' }));
        assert.match(same?.blocked ?? '', /already says exactly that/);
        const email = await resolveScheduleProposal(fakeDb([{ ctx: CTX }]), 1, 5, 'newsletter_editor', propose({ days: ['tue'] }));
        assert.match(email?.blocked ?? '', /doesn’t have a posting schedule/);
        const bad = await resolveScheduleProposal(fakeDb([{ ctx: CTX }]), 1, 5, 'blog_writer', propose({ timezone: 'Mars/Olympus' }));
        assert.match(bad?.blocked ?? '', /isn’t a timezone/);
        assert.strictEqual(await resolveScheduleProposal(fakeDb([]), 1, 5, 'blog_writer', propose({ days: ['tue'] })), null);
    });
    await check('the roles are the ones whose page shows the Posting Schedule card', () => {
        for (const [role, settings] of Object.entries(SETTINGS_BY_ROLE)) assert.strictEqual(hasPostingSchedule(role), settings.includes('draft_horizon'), role);
        assert.strictEqual(schedulePromptBlock('crm_enricher', CTX), null);
        assert.match(schedulePromptBlock('blog_writer', CTX) ?? '', /When and how I work ▸ Posting Schedule\), right now: 3 times a week · Mon, Wed, Fri · at 09:00/);
    });
    await check('a stored card closes once the schedule holds it', async () => {
        const stored = { uiElement: { type: 'schedule_proposal', assistantId: 5, set: { posting_days: ['tue', 'thu'] }, blocked: null } };
        const [done] = await refreshScheduleCards(fakeDb([{ ctx: { ...CTX, posting_days: ['thu', 'tue'] } }]), 1, 5, [stored]);
        assert.strictEqual((done.uiElement as any).settled, true);
        const [open] = await refreshScheduleCards(fakeDb([{ ctx: CTX }]), 1, 5, [stored]);
        assert.strictEqual(open, stored);
    });

    console.log('\nThe click, and the page behind it');

    await check('the click reads the context NOW, merges only `set`, and PUTs it to update-assistant-context', () => {
        const src = read('src/components/chat-session.js');
        const body = src.slice(src.indexOf('async function onScheduleChange'), src.indexOf('async function onLeadAction'));
        assert.ok(body.includes('await fetch(`/.netlify/functions/get-assistant-context?id=${id}`'));
        assert.ok(body.includes('const newContext = { ...(data.context || {}), ...(d.set || {}) };'));
        assert.ok(body.includes("fetch('/.netlify/functions/update-assistant-context', {\n          method: 'PUT'"));
        assert.ok(!body.includes('newConfiguration'), 'configuration is left alone');
        assert.ok(src.includes("container.addEventListener('schedule:change', onScheduleChange)"));
    });
    await check('the page updates its own copy of the context before repainting', () => {
        const a = read('assistants.js');
        const l = a.slice(a.indexOf("document.addEventListener('assistant:scheduleChanged'"));
        assert.ok(l.indexOf('data.context = { ...(data.context || {}), ...(e.detail?.set || {}) };') < l.indexOf('_paintPostingSchedule(data.context, data);'));
        assert.ok(a.includes('    _paintPostingSchedule(ctx, data);\n'), '_detailHydrate paints through the same function');
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('schedule_proposal', renderScheduleProposalCard)"));
        assert.ok(read('src/utils/chat-card-refresh.ts').includes('refreshScheduleCards(db, organisationId, aiAssistantId, out)'));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
