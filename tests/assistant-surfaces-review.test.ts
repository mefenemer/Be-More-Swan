// tests/assistant-surfaces-review.test.ts
// The per-assistant review of 2026-10-09: Calendar, Activity, Profile and Set-up, made relevant to
// each role. Each check names what was wrong on prod (or in code) and pins the fix.
//
// Run:  npx tsx tests/assistant-surfaces-review.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordCalendarDate } from '../src/utils/record-calendar-dates';
import { ROLE_ACTIVITY_ROLES, ROLE_RECORD_TYPES } from '../src/utils/role-activity';
import { RULE_READING_ROLES } from '../src/utils/assistant-rules-prompt';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';
import { isDraftDayForSend } from '../netlify/functions/draft-newsletter-issues';
import { GOAL_METRICS } from '../src/config/goal-metrics';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
function code(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const fakeWindow: { AssistantDashboardRegistry?: { REGISTRY: Record<string, any> }; AssistantOnboardingSchemas?: Record<string, any[]> } = {};
new Function('window', read('src/components/assistant-dashboard-registry.js'))(fakeWindow);
new Function('window', read('src/public/assistant-onboarding-schemas.js'))(fakeWindow);
const REG = fakeWindow.AssistantDashboardRegistry!.REGISTRY;
const SCHEMAS = fakeWindow.AssistantOnboardingSchemas!;

console.log('\n──── Calendar ────');

check('invoices sit on their due date — stated, or exactly derived; never guessed', () => {
    const created = new Date('2026-10-09T10:00:00Z');
    const stated = recordCalendarDate('invoice', { invoices: [{ dueDate: '2026-09-30', daysPastDue: 9 }] }, created)!;
    assert.strictEqual(stated.at.toISOString().slice(0, 10), '2026-09-30');
    assert.strictEqual(stated.derived, false);
    const derived = recordCalendarDate('invoice', { invoices: [{ daysPastDue: 9 }] }, created)!;
    assert.strictEqual(derived.at.toISOString().slice(0, 10), '2026-09-30');
    assert.strictEqual(derived.derived, true, 'the chip must say it was worked out');
    assert.strictEqual(recordCalendarDate('invoice', { invoices: [{ clientName: 'x' }] }, created), null, 'no due date and no days-past-due → no date, not today');
});

check('meetings sit on their own date, or on the notes day labelled as such; tickets have no calendar date', () => {
    const created = new Date('2026-10-09T10:00:00Z');
    assert.deepStrictEqual(recordCalendarDate('meeting', { date: '2026-10-07' }, created)?.kind, 'meeting');
    assert.deepStrictEqual(recordCalendarDate('meeting', {}, created)?.kind, 'notes_taken');
    assert.strictEqual(recordCalendarDate('ticket', {}, created), null);
});

check('the AR Clerk, Minute Taker and Brand Designer calendars draw their own items', () => {
    assert.strictEqual(REG.accounts_receivable_clerk.calendarItems, 'records');
    assert.strictEqual(REG.meeting_note_taker.calendarItems, 'records');
    assert.strictEqual(REG.brand_designer.calendarItems, 'briefs');
    const cal = code(read('calendar.js'));
    assert.match(cal, /assistant-records\?dated=1/);
    assert.match(cal, /action: 'calendar'/);
    for (const v of ['month', 'week']) assert.ok(cal.includes('_datedItemsOnDate(') , v);
    assert.match(code(read('src/components/assistant-calendar.js')), /datedItems: \(window\.AssistantDashboardRegistry\?\.get\(state\.roleKey\) \|\| \{\}\)\.calendarItems/);
    const api = code(read('netlify/functions/assistant-records.ts'));
    assert.match(api, /if \(event\.queryStringParameters\?\.dated\) \{\s*if \(!\(await ownsAssistant\(assistantId\)\)\)/, 'org-scoped');
});

check('a non-publishing assistant no longer fetches posts, blogs and emails it cannot own', () => {
    const cal = code(read('calendar.js'));
    assert.match(cal, /const skipPublishing = _lockedAssistant && !_publishesContent;/);
    assert.match(cal, /skipPublishing \? none\('posts'\) : fetch\(`\/\.netlify\/functions\/scheduled-posts/);
    assert.ok(!/Approve a draft in the Review Queue to put it on the calendar\.' : 'No posts in this filter/.test(cal), 'the empty month is worded per role');
});

console.log('\n──── Activity ────');

check('every non-social role has its own work in the feed (prod showed only "Terms accepted")', () => {
    for (const r of ['newsletter_editor', 'blog_writer', 'campaign_orchestrator', 'brand_designer', 'accounts_receivable_clerk', 'tier1_support_agent', 'crm_enricher', 'meeting_note_taker']) {
        assert.ok(ROLE_ACTIVITY_ROLES.has(r), `${r} has no activity source`);
    }
    for (const [role, type] of Object.entries(ROLE_RECORD_TYPES)) {
        assert.strictEqual(REG[role].hubTab?.recordType, type, `${role}'s activity reads ${type}, its Data Hub shows ${REG[role].hubTab?.recordType}`);
    }
    const feed = code(read('netlify/functions/get-assistant-activity.ts'));
    assert.match(feed, /items\.push\(\.\.\.await roleActivityItems\(db,/);
    assert.match(feed, /\} catch \(err\) \{\s*console\.error\('\[get-assistant-activity\] role activity failed/, 'one source failing must not empty the tab');
    assert.match(feed, /const noun = isBlog \? 'blog post' : 'post';/, 'the Blog Writer\'s drafts are blog posts');
});

check('activity text is escaped — lead names and record titles are model/web text', () => {
    assert.match(read('assistants.js'), /<p class="text-sm text-gray-700">\$\{_escapeHtml\(log\.description \|\| log\.actionType\)\}<\/p>/);
});

console.log('\n──── Profile ────');

check('the records assistants\' cards count real records, not unmeasured "Time Saved" on the social endpoint', () => {
    for (const r of ['accounts_receivable_clerk', 'tier1_support_agent', 'crm_enricher', 'meeting_note_taker']) {
        assert.strictEqual(REG[r].metricsSource, 'records', r);
        assert.strictEqual(REG[r].kpis.length, 4);
        assert.ok(!REG[r].kpis.some((k: { title: string }) => /Time Saved|Cash Recovered|Accuracy|Resolution Time/.test(k.title)), `${r} still claims an unmeasured figure`);
        assert.strictEqual(REG[r].metricKeys.length, 4);
    }
    assert.match(code(read('netlify/functions/assistant-records.ts')), /if \(event\.queryStringParameters\?\.metrics\) \{\s*if \(!\(await ownsAssistant\(assistantId\)\)\)/);
    assert.match(code(read('assistants.js')), /if \(source === 'records'\) \{[\s\S]{0,80}_loadRecordsMetrics\(assistantId, roleKey\)/);
});

check('every Rules tab tells the truth about what reads its rules', () => {
    assert.strictEqual(REG.newsletter_editor.rulesScope, 'brief', 'its drafting reads blueprint §4 — the tab said "won\'t change what it does"');
    assert.strictEqual(REG.brand_designer.rulesScope, 'designer');
    assert.strictEqual(REG.campaign_orchestrator.rulesScope, 'chat');
    assert.strictEqual(REG.crm_enricher.rulesScope, 'chat');
    assert.strictEqual(REG.lead_qualifier.rulesScope, 'outreach');
    for (const r of ['brand_designer', 'campaign_orchestrator', 'crm_enricher', 'lead_qualifier']) assert.ok(RULE_READING_ROLES.has(r), `${r}'s tab says rules reach its chat`);
    assert.match(code(read('src/utils/visual-briefs.ts')), /loadAssistantRulesBlock\(db, \{ assistantId: brief\.aiAssistantId/, 'the designer\'s art direction reads them');
    assert.match(code(read('netlify/functions/process-discovery-jobs.ts')), /scoreCandidates\(toScore, icp, sender, rulesBlock\)/, 'outreach drafting reads them');
    assert.match(read('src/lib/discovery-scoring.ts'), /They never change a score\./);
});

check('AI disclosure follows what the role produces, not the catalogue category "Marketing & Sales"', () => {
    const a = code(read('assistants.js'));
    assert.match(a, /if \(reg\) return \(reg\.modules \|\| \{\}\)\.hasPostingSchedule !== false \|\| !!reg\.briefsTab;/);
    assert.ok(!/\/social\|media\|content\|community\|marketing\|post\//.test(a), 'the /marketing/ match put the Campaign Assistant in the publishing branch');
});

check('the Email Marketing profile drops social controls its engine ignores, and blog connections', () => {
    assert.strictEqual(REG.newsletter_editor.modules.hasScheduleCard, false);
    assert.strictEqual(REG.newsletter_editor.modules.hasContentAutomation, false, 'goal seeking could set its EMAIL cadence to twice a day');
    assert.deepStrictEqual(ROLE_CONNECTIONS.newsletter_editor, ['email']);
    assert.match(code(read('assistants.js')), /mods\.hasPostingSchedule !== false && mods\.hasScheduleCard !== false/);
});

check('one control per setting: cadence lives in the schedule card where there is one', () => {
    assert.match(code(read('assistants.js')), /\(f\.key === 'posting_frequency' \|\| f\.key === 'draft_horizon_days'\)/);
});

console.log('\n──── Set-up ────');

check('EVERY set-up question is read by something — an answer nothing reads is a setting that does nothing', () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) { if (e.name !== 'generated') walk(p); continue; }
            if (/\.(ts|js)$/.test(e.name) && !p.endsWith('assistant-onboarding-schemas.js')) sources.push(code(read(p)));
        }
    };
    walk('src'); walk('netlify/functions');
    const all = sources.join('\n');
    const dead: string[] = [];
    for (const [role, steps] of Object.entries(SCHEMAS)) {
        for (const st of steps) for (const f of st.fields || []) {
            if (!all.includes(`'${f.key}'`) && !all.includes(`"${f.key}"`) && !all.includes(`.${f.key}`)) dead.push(`${role}.${f.key}`);
        }
    }
    assert.deepStrictEqual(dead, [], `Asked at hire, read by nothing: ${dead.join(', ')}`);
});

check('no set-up option promises automation that does not exist', () => {
    const txt = read('src/public/assistant-onboarding-schemas.js');
    for (const bad of ["'auto_join'", "'auto_send'", "'send_automatically'", "'real_time'", "'scheduled_sweep'", "value: 'monday'", "'reallocate_freely'"]) {
        assert.ok(!txt.includes(bad), `${bad} is offered again — nothing does it`);
    }
});

check('Blog Topics leads the blog ideation brief; the email send day times the draft', () => {
    assert.match(code(read('src/utils/blog-topic-ideation.ts')), /setupTopics \? `Topics they want this blog to cover/);
    const thu = new Date('2026-10-08T06:20:00Z');   // a Thursday
    assert.strictEqual(isDraftDayForSend(thu, 'Saturday'), true, 'two days ahead');
    assert.strictEqual(isDraftDayForSend(thu, 'Friday'), true, 'one day ahead');
    assert.strictEqual(isDraftDayForSend(thu, 'Monday'), false);
    assert.strictEqual(isDraftDayForSend(thu, null), true, 'no send day = any day, as before');
});

check('every live role has a welcome message and a goal it can be measured by', () => {
    const welcome = read('src/components/assistant-welcome-messages.js');
    for (const r of Object.keys(REG)) {
        if (r !== 'social_media_manager') assert.ok(new RegExp(`\\b${r}: \\{`).test(welcome), `${r} has no welcome message`);
        assert.ok(GOAL_METRICS.some((m: { roles?: string[] }) => (m.roles || []).includes(r)) || r === 'social_media_manager', `${r} has no goal metric`);
    }
    assert.match(code(read('netlify/functions/poll-goal-telemetry.ts')), /case 'pictures_approved':/);
});

console.log(`\n${passed} checks passed.`);
