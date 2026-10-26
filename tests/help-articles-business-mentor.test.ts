// tests/help-articles-business-mentor.test.ts
// The Business Mentor's four help articles (docs/business-mentor-plan.md §8.3, §8.6) in
// db/help-articles-2026-12zzzzzzzz-business-mentor.sql: safe to paste into a web SQL editor, unpublished
// until the role goes Live (copy never runs ahead of the product), and the figures they state match the code.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const SQL = read('db/help-articles-2026-12zzzzzzzz-business-mentor.sql');
const bodies = [...SQL.matchAll(/\$\$([\s\S]*?)\$\$, (TRUE|FALSE)\)/g)];

check('four article bodies, each dollar-quoted', () => {
    assert.strictEqual(bodies.length, 4, `expected 4 bodies, found ${bodies.length}`);
});

check('safe to paste: no semicolon or doubled apostrophe inside a body', () => {
    for (const [, b] of bodies) {
        assert.ok(!b.includes(';'), 'a semicolon inside a body is where a web SQL editor cuts the file');
        assert.ok(!b.includes("''"), 'apostrophes inside $$ bodies are literal — never doubled');
    }
});

check('inserted unpublished, and a re-run never touches is_published', () => {
    for (const [, , published] of bodies) assert.strictEqual(published, 'FALSE');
    const onConflict = SQL.slice(SQL.indexOf('ON CONFLICT (title) DO UPDATE SET'), SQL.indexOf('COMMIT;'));
    assert.ok(onConflict.length > 0, 'the upsert is there');
    assert.doesNotMatch(onConflict, /is_published/);
});

check('the figures match the code', () => {
    const proposals = read('src/utils/mentor-proposals.ts');
    assert.match(proposals, /WEEKLY_CAP = 3\b/);
    assert.match(proposals, /SNOOZE_DAYS = 14\b/);
    assert.match(SQL, /at most 3 suggestions a week/);
    assert.match(SQL, /for 14 days/);
    assert.match(read('src/utils/mentor-commitments.ts'), /MAX_PER_WEEK = 3\b/);
    assert.match(SQL, /\*\*1 to 3\*\* things/);
    const reasons = read('src/utils/mentor-commitments.ts').match(/MISS_REASONS = \{([\s\S]*?)\}/)![1];
    for (const [, label] of reasons.matchAll(/: '([^']+)'/g)) {
        assert.ok(SQL.includes(label.replace('’', "'")), `miss reason "${label}" is named in the article`);
    }
});

check('the card text it quotes is the card text the app draws', () => {
    const ui = read('src/components/disruptive-ui-registry.js');
    for (const s of ['Report a problem to Be More Swan', 'Message Be More Swan support', 'Help & Support ▸ Report an Issue', 'Send report']) {
        assert.ok(ui.includes(s), `card still says "${s}"`);
        assert.ok(SQL.includes(s), `article says "${s}"`);
    }
});

check('the tabs and buttons it names exist', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    assert.match(reg, /mentorTab: \{\s*label: 'Overview'/);
    assert.match(reg, /mentorPlanTab: \{\s*label: 'Plan'/);
    const plan = read('src/components/assistant-mentor-plan.js');
    for (const s of ['Draft it for me', 'Use this draft', 'Save draft', 'Earlier versions']) assert.ok(plan.includes(s), `Plan tab has "${s}"`);
    assert.ok(read('src/components/assistant-mentor-overview.js').includes('Review my week now'));
});

console.log(`\n${passed} passed`);
