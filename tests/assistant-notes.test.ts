// Assistants report bugs and feature gaps unprompted (owner, 2026-11-07). The user never sees the note, and
// nothing of theirs should reach our queues. Run: npx tsx tests/assistant-notes.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { PLATFORM_NOTE_PROMPT } from '../src/constants/assistant-shared-prompts';
import { cleanNoteText, extractAssistantNote, MAX_NOTES_PER_ORG_PER_DAY, normaliseArea, noteFingerprint, recordAssistantNote, withNoticedCount } from '../src/utils/assistant-notes';

const NOTE = '<<platform_note|gap|calendar export|A user asked to export the calendar.>>';

function fakeDb(opts: { count?: number; openBug?: boolean; openGap?: string | null; ready?: boolean; fail?: boolean } = {}) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { execute: async (q: any) => {
        const text = (q.queryChunks ?? []).map((c: any) => (Array.isArray(c?.value) ? c.value.join('') : '?')).join('');
        const values = (q.queryChunks ?? []).filter((c: any) => !Array.isArray(c?.value)).map((c: any) => c?.value ?? c);
        calls.push({ text, values });
        if (opts.fail) throw new Error('boom');
        if (text.includes('information_schema')) return opts.ready === false ? [] : [{ '?column?': 1 }];
        if (text.includes('AS n')) return [{ n: opts.count ?? 0 }];
        if (text.includes('SELECT id FROM issue_reports')) return opts.openBug ? [{ id: 7 }] : [];
        if (text.includes('SELECT id, description FROM feature_requests')) return opts.openGap !== undefined && opts.openGap !== null ? [{ id: 8, description: opts.openGap }] : [];
        return [];
    } } as any;
    return { db, calls };
}
const has = (calls: Array<{ text: string }>, s: string) => calls.some((c) => c.text.includes(s));

(async () => {
    // Taken out, whatever shape the reply is, and the rest still parses for every route.
    assert.deepEqual(extractAssistantNote(`Not just yet.\n${NOTE}`), { text: 'Not just yet.', note: { kind: 'gap', area: 'calendar export', text: 'A user asked to export the calendar.' } });
    assert.equal(extractAssistantNote('Nothing to see.').note, null);
    assert.equal(extractAssistantNote('Plain << words >> stay.').text, 'Plain << words >> stay.');
    // A malformed one is still hidden, and records nothing.
    const bad = extractAssistantNote('Hello.\n<<platform_note|oops|x');
    assert.equal(bad.text, 'Hello.');
    assert.equal(bad.note, null);
    for (const role of Object.keys(ASSISTANT_BUILD)) {
        for (const raw of [
            `${JSON.stringify({ reply: 'Not just yet.', uiElement: null })}\n${NOTE}`,
            JSON.stringify({ reply: `Not just yet. ${NOTE}`, uiElement: null }),
        ]) {
            const { text, note } = extractAssistantNote(raw);
            assert.ok(note, role);
            const parsed = ROUTES[role].parseResponse(text);
            assert.ok(!parsed.content.includes('platform_note'), `${role} showed the note`);
            assert.ok(parsed.content.includes('Not just yet.'), `${role} lost the reply: ${parsed.content}`);
        }
    }

    // What we can recognise doesn't reach the queue.
    const dirty = cleanNoteText('Love Cat Ltd (sam@lovecat.co.uk, 07700 900123) said "our summer sale" at https://x.co for £1,200.', ['Love Cat Ltd']);
    for (const leak of ['Love Cat', 'sam@', '07700', 'summer sale', 'x.co', '1,200']) assert.ok(!dirty.includes(leak), `${leak} in: ${dirty}`);
    assert.equal(normaliseArea(' Flyer  Printing! '), 'flyer printing');
    assert.equal(normaliseArea('Love Cat', ['Love Cat']), '');

    // A bug: the Suspected queue, no user, no session.
    let f = fakeDb();
    await recordAssistantNote(f.db, { note: { kind: 'bug', area: 'Calendar', text: 'The month view was blank.' }, organisationId: 5, assistantId: 9, role: 'brand_designer' });
    const insert = f.calls.find((c) => c.text.includes('INSERT INTO issue_reports'));
    assert.ok(insert);
    assert.match(insert!.text, /NULL, 'suspected'/);
    assert.ok(!JSON.stringify(insert!.values).includes('session'), 'no chat session id');

    // The same bug again: counted, not another row. Over the limit: no new row.
    f = fakeDb({ openBug: true });
    await recordAssistantNote(f.db, { note: { kind: 'bug', area: 'Calendar', text: 'Blank.' }, organisationId: 5, assistantId: 9, role: 'brand_designer' });
    assert.ok(has(f.calls, 'occurrences = occurrences + 1') && !has(f.calls, 'INSERT'));
    f = fakeDb({ count: MAX_NOTES_PER_ORG_PER_DAY });
    await recordAssistantNote(f.db, { note: { kind: 'bug', area: 'Calendar', text: 'Blank.' }, organisationId: 5, assistantId: 9, role: 'brand_designer' });
    assert.ok(!has(f.calls, 'INSERT'));

    // A gap: Feature Requests, pending review (not public), with no user to notify.
    f = fakeDb();
    await recordAssistantNote(f.db, { note: { kind: 'gap', area: 'Calendar export', text: 'A user asked to export.' }, organisationId: 5, assistantId: 9, role: 'blog_writer' });
    const gap = f.calls.find((c) => c.text.includes('INSERT INTO feature_requests'));
    assert.ok(gap);
    assert.match(gap!.text, /'pending_review', 'manual'/);
    assert.ok(!gap!.text.includes('submitted_by'), 'no submitter');
    f = fakeDb({ openGap: 'Noticed by an assistant: x' });
    await recordAssistantNote(f.db, { note: { kind: 'gap', area: 'Calendar export', text: 'x' }, organisationId: 5, assistantId: 9, role: 'blog_writer' });
    assert.ok(has(f.calls, 'UPDATE feature_requests') && !has(f.calls, 'INSERT'));
    assert.equal(withNoticedCount('Noticed: x', 'x'), 'Noticed: x\n\nNoticed by assistants 2 times.');
    assert.equal(withNoticedCount('Noticed: x\n\nNoticed by assistants 2 times.', 'x'), 'Noticed: x\n\nNoticed by assistants 3 times.');

    // Never costs the user their reply, and nothing happens before the incident SQL is applied.
    await recordAssistantNote(fakeDb({ fail: true }).db, { note: { kind: 'gap', area: 'x y', text: 'z' }, organisationId: 5, assistantId: 9, role: null });
    assert.notEqual(noteFingerprint('bug', 'a', 'x'), noteFingerprint('gap', 'a', 'x'));

    // Every route is told; it is stripped before parsing; the bulk hand-off still skips Suspected.
    const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
    assert.ok(orch.includes('OUTSIDE_PRODUCTS_RULE, PLATFORM_NOTE_PROMPT]'));
    assert.ok(orch.indexOf('extractAssistantNote(replyText(response.content))') < orch.indexOf('route.parseResponse(raw)'));
    assert.ok(readFileSync('netlify/functions/admin-issue-reports.ts', 'utf8').includes("source <> 'suspected'"));
    assert.match(PLATFORM_NOTE_PROMPT, /NEVER put in it: any name, email/);
    console.log('assistant-notes: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
