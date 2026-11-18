// Decision 9 (docs/meeting-note-taker-finish-plan.md): the Minute Taker is renamed "Note Taker" before go-live,
// so the launch copy uses the final name. Run: npx tsx tests/note-taker-rename.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const read = (f: string) => readFileSync(f, 'utf8');

// 1. Every place the name is shown or seeded.
assert.ok(read('src/public/role-labels.js').includes("meeting_note_taker: 'Note Taker'"));
const seed = JSON.parse(read('seed/data/master_assistants.json')) as { roleKey: string; name: string }[];
assert.equal(seed.find((r) => r.roleKey === 'meeting_note_taker')?.name, 'Note Taker');
assert.ok(read('db/seed-catalog.ts').includes("name: 'Note Taker',"));
assert.ok(read('connections.html').includes('<h3>Note Taker</h3>') && read('connections.html').includes('</span>Note Taker</a>'));
assert.ok(read('faq.html').includes('with the Note Taker — Slack, Notion, Jira and Asana.'));
assert.ok(read('src/public/assistant-onboarding-schemas.js').includes('How your Note Taker works'));

// 2. The database: master_assistants.name only, keyed on role_key, re-runnable; the old rename can't revert it.
const sqlText = read('db/z-note-taker-rename.sql');
assert.match(sqlText, /UPDATE master_assistants\s+SET name = 'Note Taker', updated_at = now\(\)\s+WHERE role_key = 'meeting_note_taker'\s+AND name IS DISTINCT FROM 'Note Taker';/);
assert.ok(!/UPDATE ai_assistants/i.test(sqlText), "the user's own assistant names are never touched");
assert.ok(read('db/assistant-role-titles-rename.sql').includes("('meeting_note_taker',        'Note Taker'),"), 'a re-run of the old rename keeps the new name');

// 3. Nothing a customer reads still says "Minute Taker" (comments recording past runs are history, not copy).
const shown = execSync(`git grep -l -i "minute taker" -- '*.html' 'src/public' 'seed' 'db/seed-catalog.ts' 'src/components' || true`, { encoding: 'utf8' }).trim();
assert.equal(shown, '', `still says "Minute Taker": ${shown}`);
console.log('note-taker-rename: all checks passed');
