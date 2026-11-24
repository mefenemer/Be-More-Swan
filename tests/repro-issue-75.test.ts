// tests/repro-issue-75.test.ts
// Fix pipeline #75 (owner, 2026-11-17): "I do not want Be More Swan's email to be used by other people. If they do not
// connect Outlook or Gmail, then they cannot use email." The sending route went in PR #695; the card's words did not:
// integration_scenarios.description for email_meeting_followup still read "…or from Be More Swan when no inbox is
// connected" on both databases (2026-11-24). The SQL here makes the live row say what the seed and the code do.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const sql = readFileSync(join(root, 'db/z-followup-card-own-mailbox-copy.sql'), 'utf8').replace(/--.*$/gm, '');
const seed = readFileSync(join(root, 'db/seed-catalog.ts'), 'utf8');
const m = /scenarioKey: 'email_meeting_followup'[\s\S]*?description: '([^']+)'/.exec(seed);
assert.ok(m, 'the seed has the card');
const words = m![1];
assert.ok(!/Be More Swan/.test(words) && /own connected Gmail or Outlook/.test(words), 'the seed says own mailbox only');
assert.ok(sql.includes(`SET description = '${words}'`), 'the SQL writes exactly the seed\'s words');
assert.ok(/WHERE scenario_key = 'email_meeting_followup'/.test(sql), 'to that one card');
assert.ok(!/DELETE|DROP|TRUNCATE|INSERT/i.test(sql), 'and nothing else');

// And nothing can send it from Be More Swan's address.
const send = readFileSync(join(root, 'src/utils/meeting-followup-send.ts'), 'utf8');
assert.ok(send.includes('NoMailboxError') && !/resend/i.test(send), 'own mailbox or nothing');

console.log('repro-issue-75: the follow-up card says own mailbox only ✓');
