// One note per chat, and none beside the user's own report (prod 2026-11-26, workspace 43, chat 206): the Social Media
// Assistant raised feature request #67 and issues #93, #94, #96 on four replies of ONE chat about a text box outline,
// beside the user's own report #95. Each reply reworded the area, so the area merge never matched.
// This replays that chat against a stateful fake database. Run: npx tsx tests/assistant-notes-once-per-chat.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkUserReportToNotes, NOTE_MARKER, recordAssistantNote } from '../src/utils/assistant-notes';
import { PLATFORM_NOTE_PROMPT } from '../src/constants/assistant-shared-prompts';

type Row = Record<string, any>;
function stateDb() {
    const issues: Row[] = [];
    const features: Row[] = [];
    const markers: Array<{ chat: number; content: string; m: any }> = [];
    const messages: Array<{ issue: number; body: string }> = [];
    const sessions = [{ id: 206, org: 43, user: 44 }];
    let nextIssue = 93, nextFeature = 67;
    const db = { execute: async (q: any) => {
        const text = (q.queryChunks ?? []).map((c: any) => (Array.isArray(c?.value) ? c.value.join('') : '?')).join('');
        const v = (q.queryChunks ?? []).filter((c: any) => !Array.isArray(c?.value)).map((c: any) => c?.value ?? c);
        if (text.includes('information_schema')) return [{ x: 1 }];
        if (text.includes('FROM chat_messages')) return markers.filter((m) => m.chat === v[0]).map((m) => ({ m: m.m }));
        if (text.includes('INSERT INTO chat_messages')) { markers.push({ chat: v[0], content: v[1], m: JSON.parse(v[2]) }); return []; }
        if (text.includes('FROM chat_sessions')) return sessions.filter((s) => s.id === v[0] && s.org === v[1] && s.user === v[2]);
        if (text.includes('AS n')) return [{ n: issues.length + features.length }];
        if (text.includes('SELECT id FROM issue_reports')) return issues.filter((i) => i.fp === v[0] && i.status !== 'closed').map((i) => ({ id: i.id }));
        if (text.includes('UPDATE issue_reports SET occurrences')) { issues.find((i) => i.id === v[0])!.occurrences++; return []; }
        if (text.includes('INSERT INTO issue_reports')) { const id = nextIssue++; issues.push({ id, fp: v[5], area: v[4], status: 'reported', occurrences: 1 }); return [{ id }]; }
        if (text.includes("SET status = 'closed'")) { const i = issues.find((x) => x.id === v[0] && x.status === 'reported' && x.occurrences <= 1); if (i) i.status = 'closed'; return i ? [{ id: i.id }] : []; }
        if (text.includes('INSERT INTO issue_report_messages')) { messages.push({ issue: v[0], body: v[1] }); return []; }
        if (text.includes('UPDATE issue_reports SET updated_at')) return [];
        if (text.includes('SELECT id, description FROM feature_requests')) return features.filter((f) => f.title.toLowerCase() === v[0] && f.status === 'pending_review').map((f) => ({ id: f.id, description: f.description }));
        if (text.includes('INSERT INTO feature_requests')) { const id = nextFeature++; features.push({ id, title: v[1], description: v[2], status: 'pending_review' }); return [{ id }]; }
        if (text.includes("SET status = 'duplicate'")) { const f = features.find((x) => x.id === v[2] && x.status === 'pending_review'); if (f) { f.status = 'duplicate'; f.issue_id = v[0]; f.merged_into_id = v[1]; } return []; }
        if (text.includes('UPDATE feature_requests SET description')) return [];
        throw new Error(`unexpected SQL: ${text}`);
    } } as any;
    return { db, issues, features, markers, messages };
}

(async () => {
    const s = stateDb();
    const note = (kind: 'bug' | 'gap', area: string, text: string, chatSessionId: number | null = 206) =>
        recordAssistantNote(s.db, { note: { kind, area, text }, organisationId: 43, assistantId: 15, role: 'social_media_manager', chatSessionId });

    // Reply 1 (03:49:02): "I can't change a text box's outline colour from this chat" → a gap. Sent: the chat's first note.
    await note('gap', 'text box styling', 'A user asked the chat to change a text box outline colour.');
    assert.equal(s.features.length, 1);
    assert.ok(s.markers[0].content.startsWith(NOTE_MARKER));
    // Reply 2 (03:49:18): "nothing happened" → a bug, in other words. Same chat: dropped (this was #93).
    await note('bug', 'post editor text boxes', 'Changing a text box outline colour did nothing.');
    // Reply 4 (03:50:35, after the user's report): again, in other words (this was #96).
    await note('bug', 'post editor text outline', 'The outline colour had no effect.');
    assert.equal(s.issues.length, 0, `one chat raised ${s.issues.length} more issue(s)`);

    // The user sends their own report (#95) from the card: the chat's gap note becomes its duplicate.
    await linkUserReportToNotes(s.db, { chatSessionId: 206, organisationId: 43, userId: 44, report: { table: 'issue_reports', id: 95 } });
    assert.equal(s.features[0].status, 'duplicate');
    assert.equal(s.features[0].issue_id, 95);
    assert.equal(s.markers.at(-1)!.m.by, 'user');
    await note('gap', 'chat styling', 'Anything else.');
    assert.equal(s.features.length + s.issues.length, 1, 'nothing more after the user reported it');

    // A bug note the chat raised alone is closed as a duplicate; one other chats raised too stays open.
    const t = stateDb();
    await recordAssistantNote(t.db, { note: { kind: 'bug', area: 'outline colour', text: 'Did nothing.' }, organisationId: 43, assistantId: 15, role: 'social_media_manager', chatSessionId: 206 });
    await linkUserReportToNotes(t.db, { chatSessionId: 206, organisationId: 43, userId: 44, report: { table: 'issue_reports', id: 95 } });
    assert.equal(t.issues[0].status, 'closed');
    assert.match(t.messages[0].body, /Duplicate of issue #95/);
    const u = stateDb();
    await recordAssistantNote(u.db, { note: { kind: 'bug', area: 'outline colour', text: 'Did nothing.' }, organisationId: 43, assistantId: 15, role: 'social_media_manager', chatSessionId: 206 });
    u.issues[0].occurrences = 3;
    await linkUserReportToNotes(u.db, { chatSessionId: 206, organisationId: 43, userId: 44, report: { table: 'issue_reports', id: 95 } });
    assert.equal(u.issues[0].status, 'reported');
    assert.match(u.messages[0].body, /Left open/);

    // Someone else's chat, or another workspace's: nothing is touched.
    const w = stateDb();
    await recordAssistantNote(w.db, { note: { kind: 'bug', area: 'outline colour', text: 'x' }, organisationId: 43, assistantId: 15, role: 'social_media_manager', chatSessionId: 206 });
    await linkUserReportToNotes(w.db, { chatSessionId: 206, organisationId: 43, userId: 99, report: { table: 'issue_reports', id: 95 } });
    await linkUserReportToNotes(w.db, { chatSessionId: 206, organisationId: 7, userId: 44, report: { table: 'issue_reports', id: 95 } });
    await linkUserReportToNotes(w.db, { chatSessionId: 'x', organisationId: 43, userId: 44, report: { table: 'issue_reports', id: 95 } });
    assert.equal(w.issues[0].status, 'reported');
    assert.equal(w.markers.length, 1);

    // No chat id (a caller outside chat): the old behaviour, one row per note.
    const x = stateDb();
    await recordAssistantNote(x.db, { note: { kind: 'bug', area: 'a b', text: 'x' }, organisationId: 43, assistantId: 15, role: 'r', chatSessionId: null });
    assert.equal(x.issues.length, 1);
    assert.equal(x.markers.length, 0);

    // Wiring: no note beside the user's own report card; the card's send carries the chat id; both endpoints link.
    const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
    assert.match(orch, /if \(assistantNote && \(uiElement as \{ type\?: unknown \} \| null\)\?\.type !== 'mentor_support_request'\) \{\n\s+await recordAssistantNote\(db, \{[^}]*chatSessionId: session\.id \}\)/);
    assert.ok(orch.indexOf('await recordAssistantNote(db') > orch.indexOf('if (supportCard) uiElement = supportCard;'), 'recorded after the card is final');
    assert.ok(readFileSync('src/components/chat-session.js', 'utf8').includes('A.support({ ...d, chatSessionId })'));
    const apply = readFileSync('src/components/mentor-apply.js', 'utf8');
    assert.equal(apply.match(/, chatSessionId \}\);/g)?.length, 2, 'issue + feature posts carry the chat id');
    assert.ok(readFileSync('netlify/functions/issue-reports.ts', 'utf8').includes("report: { table: 'issue_reports', id: created.id }"));
    assert.ok(readFileSync('netlify/functions/feature-requests.ts', 'utf8').includes("report: { table: 'feature_requests', id: created.id }"));
    assert.match(PLATFORM_NOTE_PROMPT, /One at most per conversation/);
    assert.match(PLATFORM_NOTE_PROMPT, /No note on a reply that carries the mentor_support_request card/);

    console.log('assistant-notes-once-per-chat: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
