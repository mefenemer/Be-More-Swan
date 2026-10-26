// tests/mentor-phase-4.test.ts
// Business Mentor Phase 4 (docs/business-mentor-plan.md §6): content checks in the weekly review, and
// automatic incident reports.
//
//   - Incidents: deterministic call sites only; one row per kind + error class + role per UK day; a
//     per-workspace daily cap; the error, role and ids only (emails, links and quoted text scrubbed);
//     no reporter, so nobody is notified and no user's list shows it; suspected ones are never in a
//     bulk "Pass all to Developer"; the new columns are never declared to Drizzle (an INSERT would name them).
//   - Content checks: a chosen call to action that can't be used, an offer nobody promotes, a goal whose
//     platform isn't connected — in code, free, even in a "not enough data" week; Brand Knowledge
//     contradictions only on the paid review, judged by the model.
//
// Run:  npx tsx tests/mentor-phase-4.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describeIncident, errorClass, fingerprintOf, INCIDENT_KINDS, MAX_NEW_PER_ORG_PER_DAY, recordPlatformIncident, scrub, ukDay,
} from '../src/utils/platform-incident';
import { contentFindings, contentFindingsText, renderContentChecksForMentor, type ContentCheckInputs } from '../src/utils/mentor-content-checks';
import { notEnoughDataReview } from '../src/utils/mentor-review';
import { notifyIssueUser } from '../src/utils/issue-reports';
import type { MentorSnapshotData } from '../src/utils/mentor-snapshot';

let passed = 0, total = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    total++;
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    })());
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

console.log('platform incidents');

test('error class: a Postgres code, an Error subclass, or the message shape without the varying parts', () => {
    assert.equal(errorClass(Object.assign(new Error('column "x" does not exist'), { code: '42703' })), '42703');
    assert.equal(errorClass(new TypeError('Cannot read properties of undefined')), 'TypeError');
    assert.equal(errorClass(new Error('job 123 failed after 3 attempts')), errorClass(new Error('job 98 failed after 2 attempts')));
    assert.equal(errorClass('Could not ground a topic for this slot.'), 'could not ground a topic for this slot');
    assert.equal(errorClass(null), 'unknown');
});

test('scrub: no emails, links or quoted text; cut at a word', () => {
    const s = scrub('Send to jo@example.com failed at https://x.test/a?b=1 with "Hello Jo, our summer offer…"');
    assert.ok(!s.includes('jo@example.com') && !s.includes('x.test') && !s.includes('summer offer'), s);
    assert.ok(s.includes('[email]') && s.includes('[url]') && s.includes('[text]'));
    const long = scrub('word '.repeat(100), 50);
    assert.ok(long.length <= 50 && long.endsWith('…'));
});

test('fingerprint: same kind + class + role is one incident; any difference is another', () => {
    assert.equal(fingerprintOf('chat_turn', 'TypeError', 'blog_writer'), fingerprintOf('chat_turn', 'TypeError', 'blog_writer'));
    assert.notEqual(fingerprintOf('chat_turn', 'TypeError', 'blog_writer'), fingerprintOf('chat_turn', 'TypeError', 'social_media_manager'));
    assert.notEqual(fingerprintOf('chat_turn', 'TypeError', null), fingerprintOf('blog_post_job', 'TypeError', null));
});

test('UK day and the queue description', () => {
    assert.equal(ukDay(new Date('2026-07-01T23:30:00Z')), '2026-07-02'); // BST: already the 2nd in London
    assert.equal(ukDay(new Date('2026-12-01T23:30:00Z')), '2026-12-01');
    assert.equal(describeIncident('mentor_review', 'TypeError', 'business_mentor'), 'Automatic: Business Mentor weekly review failed (business_mentor) — TypeError');
});

/** A db that records the SQL it was given; `count` is today's rows for the workspace. */
function fakeDb(count: number, fail?: { code: string }) {
    const calls: string[] = [];
    const db = {
        execute: async (q: any) => {
            const text = (q.queryChunks ?? []).map((c: any) => (Array.isArray(c?.value) ? c.value.join('') : '')).join('?');
            calls.push(text);
            if (fail) throw Object.assign(new Error('boom'), fail);
            if (text.includes('count(*)')) return [{ n: count }];
            if (text.includes('ai_assistants')) return [{ role: 'blog_writer' }];
            return [];
        },
    };
    return { db, calls };
}

test('record: inserts a system row with no user, de-duplicated on the fingerprint and day', async () => {
    const { db, calls } = fakeDb(0);
    await recordPlatformIncident(db, { kind: 'blog_post_job', error: 'Could not ground a topic', organisationId: 5, assistantId: 9, ids: { jobId: 'j1', attempt: 3 } });
    const insert = calls.find((c) => c.includes('INSERT INTO issue_reports'));
    assert.ok(insert, 'inserted');
    assert.match(insert!, /NULL, 'system'/);
    assert.match(insert!, /ON CONFLICT \(fingerprint, fingerprint_day\)/);
    assert.match(insert!, /occurrences = issue_reports\.occurrences \+ 1/);
    assert.ok(calls.some((c) => c.includes('ai_assistants')), 'role looked up from the assistant');
});

test(`record: past ${MAX_NEW_PER_ORG_PER_DAY} a day for a workspace, only an existing incident is counted`, async () => {
    const { db, calls } = fakeDb(MAX_NEW_PER_ORG_PER_DAY);
    await recordPlatformIncident(db, { kind: 'chat_turn', error: new TypeError('x'), organisationId: 5, role: 'blog_writer' });
    assert.ok(!calls.some((c) => c.includes('INSERT')), 'no new row');
    assert.ok(calls.some((c) => c.startsWith('\n                UPDATE issue_reports SET occurrences')), 'bumped');
});

test('record: never throws, including before the SQL is applied', async () => {
    for (const code of ['42703', '42P10', '23502', 'XX000']) {
        const { db } = fakeDb(0, { code });
        await recordPlatformIncident(db, { kind: 'chat_request', error: new Error('x') });
    }
});

test('every incident kind is labelled, and every call site is deterministic', () => {
    for (const [k, label] of Object.entries(INCIDENT_KINDS)) assert.ok(label.length > 3, k);
    const sites: Array<[string, string]> = [
        ['netlify/functions/process-content-jobs.ts', "kind: 'social_post_job'"],
        ['netlify/functions/process-content-jobs.ts', "kind: 'social_post_job_upstream'"],
        ['netlify/functions/process-blog-jobs.ts', "kind: 'blog_post_job'"],
        ['netlify/functions/chat-orchestrator.ts', "kind: 'chat_turn'"],
        ['netlify/functions/chat-orchestrator.ts', "kind: 'chat_request'"],
        ['netlify/functions/mentor.ts', "kind: 'mentor_action'"],
        ['src/utils/mentor-jobs.ts', "kind: 'mentor_job'"],
        ['src/utils/mentor-review.ts', "kind: 'mentor_review'"],
    ];
    for (const [file, marker] of sites) assert.ok(read(file).includes(marker), `${file} records ${marker}`);
    for (const k of Object.keys(INCIDENT_KINDS)) assert.ok(sites.some(([, m]) => m === `kind: '${k}'`), `${k} has a call site`);
});

test('a blog job stopped on purpose (task cap, assistant gone) is not an incident', () => {
    const src = read('netlify/functions/process-blog-jobs.ts');
    const at = src.indexOf("kind: 'blog_post_job'");
    assert.ok(at > 0);
    assert.ok(src.slice(at - 300, at).includes('if (!opts.terminal)'), 'guarded by !opts.terminal');
});

test('the new columns are not declared to Drizzle (an INSERT would name them before the SQL exists)', () => {
    const schema = read('db/schema.ts');
    const table = schema.slice(schema.indexOf('export const issueReports = pgTable'), schema.indexOf('export const issueReportMessages'));
    for (const col of ['"source"', '"fingerprint"', '"occurrences"', '"incident_context"', '"last_seen_at"']) assert.ok(!table.includes(col), col);
    assert.ok(!/userId: integer\("user_id"\)\s*\.notNull\(\)/.test(table), 'user_id is nullable');
    const sql = read('db/z-platform-incidents.sql');
    assert.match(sql, /ALTER COLUMN user_id DROP NOT NULL/);
    assert.match(sql, /CHECK \(source <> 'user' OR user_id IS NOT NULL\)/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS issue_reports_fingerprint_day_uq/);
    assert.ok(!/\bDROP CONSTRAINT\b/.test(sql), 'no DROP-then-ADD (a re-run must not fail)');
});

test('nobody is told about an automatic incident', async () => {
    await notifyIssueUser({} as any, { userId: null, issueId: 1, status: 'backlog' }); // would throw on the fake db if it tried
});

test('users never see one; Support inbox and "Pass all" leave them out', () => {
    assert.match(read('netlify/functions/issue-reports.ts'), /\.where\(eq\(issueReports\.userId, userId\)\)/);
    const inbox = read('src/utils/support-inbox.ts');
    assert.match(inbox, /\n\s+JOIN users u ON u\.id = i\.user_id/);
    assert.match(inbox, /An automatic report has no customer to answer/);
    const admin = read('netlify/functions/admin-issue-reports.ts');
    assert.equal((admin.match(/\.\.\.\(await notSuspected\(db\)\)/g) ?? []).length, 2, 'both bulk hand-offs filter suspected');
    const html = read('admin.html');
    assert.equal((html.match(/i\.source !== 'suspected'/g) ?? []).length, 2, 'both bulk buttons count without suspected');
    assert.ok(html.includes('_irSourceChip(i)') && html.includes('${_irIncidentBlock(i)}'));
});

console.log('content checks');

const offer = 'A 14-day free trial for new customers.';
const base: ContentCheckInputs = { ctas: [], offer: null, goals: [], services: [], knowledge: [], hasApprovedPlan: false };

test('a chosen call to action that cannot be used says why and where', () => {
    const f = contentFindings({ ...base, ctas: [{ name: 'Felix', chosen: 'gift', resolved: { kind: 'own', unusable: 'None of your sign-up forms sends a free download yet.' } }] });
    assert.equal(f.length, 1);
    assert.match(f[0].text, /Felix is set to invite people to a free download from a sign-up form, but none of your sign-up forms sends a free download yet\. Until/);
    assert.match(f[0].where, /Calls to action/);
    const intro = contentFindings({ ...base, ctas: [{ name: 'Bea', chosen: 'intro_offer', resolved: { kind: 'own', unusable: 'Your free trial or introductory offer isn\'t recorded yet — add it above.' } }] });
    assert.match(intro[0].text, /isn't recorded yet\. Until/);
    assert.ok(!intro[0].text.includes('add it above'), 'no "above" — there is no above in a review');
});

test('an offer that no content assistant promotes', () => {
    const own = { name: 'Felix', chosen: 'own' as const, resolved: { kind: 'own' as const } };
    assert.equal(contentFindings({ ...base, offer, ctas: [own] }).length, 1);
    assert.equal(contentFindings({ ...base, offer, ctas: [own, { name: 'Bea', chosen: 'intro_offer', resolved: { kind: 'intro_offer', summary: offer, url: null } }] }).length, 0);
    assert.equal(contentFindings({ ...base, offer, ctas: [] }).length, 0, 'no content assistant → nothing to say');
});

test('a goal whose platform is not connected; connected or internal goals pass', () => {
    const goals = [{ assistant: 'Felix', label: 'Instagram followers', metricKey: 'instagram_followers' }];
    const f = contentFindings({ ...base, goals });
    assert.equal(f.length, 1);
    assert.match(f[0].text, /Felix's goal "Instagram followers" can't be measured: Instagram isn't connected\./);
    assert.equal(contentFindings({ ...base, goals, services: ['instagram'] }).length, 0);
    assert.equal(contentFindings({ ...base, goals: [{ assistant: 'X', label: 'Y', metricKey: 'not_a_metric' }] }).length, 0);
});

test('a thin week still says what code found — and nothing when there is nothing', () => {
    const data = { goals: [], team: [] } as unknown as MentorSnapshotData;
    const thin = notEnoughDataReview({ data, figures: [], commitments: [], customers: null, content: { ...base, goals: [{ assistant: 'Felix', label: 'Reach', metricKey: 'instagram_reach' }] } });
    const s = thin.sections.find((x) => x.title === 'Worth fixing in your set-up');
    assert.ok(s && /Instagram isn't connected/.test(s.text) && /Fix it on Connections/.test(s.text));
    const none = notEnoughDataReview({ data, figures: [], commitments: [], customers: null, content: base });
    assert.ok(!none.sections.some((x) => x.title === 'Worth fixing in your set-up'));
    assert.equal(contentFindingsText([]), null);
});

test('Brand Knowledge goes to the model only with something to compare it against', () => {
    const k = [{ name: 'Pricing sheet', excerpt: '7-day trial' }];
    assert.ok(!renderContentChecksForMentor({ ...base, knowledge: k }).join('\n').includes('Pricing sheet'), 'no offer and no plan → nothing to compare');
    const withOffer = renderContentChecksForMentor({ ...base, knowledge: k, offer }).join('\n');
    assert.match(withOffer, /ONLY if one clearly contradicts it/);
    assert.ok(withOffer.includes('"Pricing sheet": 7-day trial') && withOffer.includes(`Recorded offer: ${offer}`));
    assert.ok(renderContentChecksForMentor({ ...base, knowledge: k, hasApprovedPlan: true }).join('\n').includes('the approved plan'));
    assert.deepEqual(renderContentChecksForMentor(null), []);
});

test('the paid review is given the checks; findings are words, never edits', () => {
    const src = read('src/utils/mentor-review.ts');
    assert.ok(src.includes("renderContentChecksForMentor(inputs.content ?? null).join('\\n')"));
    assert.match(read('src/utils/mentor-content-checks.ts'), /never claim you changed anything/);
});

Promise.all(pending).then(() => {
    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
});
