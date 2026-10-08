// tests/campaign-tickets.test.ts
// §9.5, the automatic half: a person's task filed in Jira/Asana, finished when its ticket closes.
//
// WHY THIS EXISTS. "The Orders hub must issue tasks to human team members via Jira or Asana, just as
// it does to AI agents." A campaign waiting on Legal should stop waiting when Legal closes their
// ticket — not when someone remembers to press Mark done. What is pinned:
//   • "COULD NOT TELL" IS NEVER "DONE". A deleted ticket, a revoked token or a network error returns
//     null, and null leaves the task open. Reading it as done would start the work waiting behind it.
//   • Jira is judged by status CATEGORY, not status name — workflows call it Done, Closed, Resolved…
//   • A blocked task's ticket is not read: a ticket closed early must not leapfrog earlier work.
//   • One ticket per task, and filing failing never fails the task.
//   • The remembered project is MERGED into integration metadata, never replacing it.
//   • One copy of each provider's request: the Meeting Note Taker uses the same module.
//
// Run:  npx tsx tests/campaign-tickets.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiraIssue, isTicketDone, listJiraProjects, parseDueDate } from '../src/utils/pm-tickets';
import { normalisePlanOrders } from '../src/utils/campaign-plan';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
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
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone.`);
    const b = text.indexOf(end, a + start.length);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone.`);
    return text.slice(a, b);
}

/** Replace global fetch with a canned responder for the duration of one check. */
async function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>) {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tickets = code(read('src/utils/campaign-tickets.ts'));

async function main() {
    console.log('\n──── is the ticket done? ────');

    await check('Jira is judged by status CATEGORY — any workflow\'s "done" counts', async () => {
        await withFetch(() => jsonRes(200, { fields: { status: { name: 'Resolved', statusCategory: { key: 'done' } } } }), async () => {
            assert.strictEqual(await isTicketDone('jira', 't', 'cloud', 'LEG-12'), true);
        });
        await withFetch(() => jsonRes(200, { fields: { status: { name: 'Done-ish', statusCategory: { key: 'indeterminate' } } } }), async () => {
            assert.strictEqual(await isTicketDone('jira', 't', 'cloud', 'LEG-12'), false,
                'A status NAMED like done but in the in-progress category is not done.');
        });
    });

    await check('Asana is judged by `completed`', async () => {
        await withFetch(() => jsonRes(200, { data: { completed: true } }), async () => {
            assert.strictEqual(await isTicketDone('asana', 't', null, '123'), true);
        });
        await withFetch(() => jsonRes(200, { data: { completed: false } }), async () => {
            assert.strictEqual(await isTicketDone('asana', 't', null, '123'), false);
        });
    });

    await check('"could not tell" is null — never done', async () => {
        await withFetch(() => jsonRes(404, { errorMessages: ['Issue does not exist'] }), async () => {
            assert.strictEqual(await isTicketDone('jira', 't', 'cloud', 'GONE-1'), null, 'A deleted ticket is not a finished task.');
        });
        await withFetch(() => { throw new Error('network down'); }, async () => {
            assert.strictEqual(await isTicketDone('asana', 't', null, '1'), null);
        });
        await withFetch(() => jsonRes(200, { fields: {} }), async () => {
            assert.strictEqual(await isTicketDone('jira', 't', 'cloud', 'X-1'), null, 'No status category means we could not tell.');
        });
        assert.strictEqual(await isTicketDone('jira', 't', null, 'X-1'), null, 'No Jira site, no answer.');
    });

    await check('a null never settles a task, and every check is stamped', () => {
        const fn = span(tickets, 'export async function checkTaskTickets', '\n}\n', 'checkTaskTickets');
        assert.match(fn, /if \(done === true\) \{/, 'Only an explicit true may settle.');
        assert.match(fn, /'\{ticket,checkedAt\}'/);
        assert.match(fn, /inArray\(campaignOrders\.status, \['issued'\]\)/,
            'A blocked task\'s ticket must not be read — closing it early must not leapfrog earlier work.');
    });

    console.log('\n──── filing ────');

    await check('a Jira issue is created in the chosen project, with a browse link', async () => {
        let sent: Record<string, any> = {};
        await withFetch((url, init) => {
            assert.match(url, /\/ex\/jira\/cloud-1\/rest\/api\/3\/issue$/);
            sent = JSON.parse(String(init?.body));
            return jsonRes(201, { key: 'LEG-7' });
        }, async () => {
            const ref = await createJiraIssue('t', 'cloud-1', 'https://acme.atlassian.net/', { projectKey: 'LEG' },
                { summary: 'Check the claims', lines: ['For: Legal'], dueDate: '2026-10-20' });
            assert.deepStrictEqual(ref, { id: 'LEG-7', url: 'https://acme.atlassian.net/browse/LEG-7' });
        });
        assert.strictEqual(sent.fields.project.key, 'LEG');
        assert.strictEqual(sent.fields.duedate, '2026-10-20');
    });

    await check('a provider rejection surfaces in the provider\'s own words', async () => {
        await withFetch(() => jsonRes(400, { errors: { project: 'Specify a valid project ID or key' } }), async () => {
            await assert.rejects(
                createJiraIssue('t', 'c', '', { projectKey: 'NOPE' }, { summary: 'x', lines: [] }),
                /Specify a valid project ID or key/,
            );
        });
    });

    await check('projects list for the picker', async () => {
        await withFetch(() => jsonRes(200, { values: [{ key: 'LEG', name: 'Legal' }, { name: 'no key' }] }), async () => {
            assert.deepStrictEqual(await listJiraProjects('t', 'c'), [{ id: 'LEG', name: 'Legal' }]);
        });
    });

    await check('a free-text due date is never guessed into a date', () => {
        assert.strictEqual(parseDueDate('2026-10-20T09:00:00Z'), '2026-10-20');
        assert.strictEqual(parseDueDate('by Friday'), null);
        assert.strictEqual(parseDueDate(null), null);
    });

    await check('one ticket per task, org-scoped, for a person\'s task only', () => {
        const fn = span(tickets, 'export async function fileTaskTicket', '\n}\n', 'fileTaskTicket');
        assert.match(fn, /eq\(campaignOrders\.organisationId, input\.organisationId\)/);
        assert.match(fn, /order\.action !== 'request_human_task'/);
        assert.match(fn, /if \(brief\.ticket\) throw/, 'Two tickets for one job is two people doing it.');
        assert.match(fn, /IntegrationError[\s\S]{0,120}needs reconnecting/);
    });

    await check('the remembered project is MERGED into integration metadata', () => {
        const fn = span(tickets, 'export async function fileTaskTicket', '\n}\n', 'fileTaskTicket');
        assert.match(fn, /coalesce\(\$\{workspaceIntegrations\.metadata\}, '\{\}'::jsonb\)\s*\|\| jsonb_build_object\('campaignTaskProject'/,
            'Other features keep things in that metadata — replacing it would wipe them.');
    });

    await check('a plan can ask for a task to be filed, and failing to file never fails the task', () => {
        const [t] = normalisePlanOrders([{ action: 'request_human_task', assignee: 'Legal', task: 'Check', fileIn: 'jira' }]);
        assert.strictEqual(t.brief.fileIn, 'jira');
        const [junk] = normalisePlanOrders([{ action: 'request_human_task', assignee: 'Legal', task: 'Check', fileIn: 'trello' }]);
        assert.ok(!('fileIn' in junk.brief));
        const orders = code(read('src/utils/campaign-orders.ts'));
        const fn = span(orders, 'async function fileIfAsked', '\n}\n', 'fileIfAsked');
        assert.match(fn, /catch \(err\)[\s\S]{0,300}ticketError/, 'A failure is recorded on the brief, not thrown.');
    });

    console.log('\n──── closing releases the work ────');

    await check('the reconciler reads tickets hourly and settles through the one settlement path', () => {
        const rec = code(read('src/utils/campaign-reconciler.ts'));
        assert.match(rec, /checkTaskTickets\(db, \(orderId, summary\) => settleOrderNow\(db, orderId, \{ kind: 'delivered', summary \}\)\)/,
            'Delivered — which is what releases the work waiting on the task (unblockChain).');
    });

    await check('the Meeting Note Taker files through the same module', () => {
        const sync = code(read('netlify/functions/sync-action.ts'));
        assert.match(sync, /from '\.\.\/\.\.\/src\/utils\/pm-tickets'/);
        assert.ok(!/api\.atlassian\.com\/ex\/jira\/\$\{cloudId\}\/rest\/api\/3\/issue`/.test(sync),
            'One copy of each provider\'s request — sync-action must not keep its own.');
    });

    console.log('\n──── both surfaces ────');

    await check('the Campaigns tab files a task, links its ticket, and Add work can file on creation', () => {
        const tab = code(read('src/components/assistant-campaigns.js'));
        assert.match(tab, /function ticketLine/);
        assert.match(tab, /action: 'file_ticket'/);
        assert.match(tab, /closing that ticket marks this done/);
        assert.match(tab, /brief\.fileIn = fileIn/);
        assert.match(tab, /\/integrations\.html/, 'An unconnected tool says where to connect it.');
    });

    await check('the chat knows tasks can be filed and close themselves', () => {
        const orch = code(read('netlify/functions/chat-orchestrator.ts'));
        assert.match(orch, /"fileIn": "jira" \| "asana"/);
        assert.match(orch, /marks the task done within the hour/);
        const plan = code(read('src/utils/campaign-plan.ts'));
        assert.match(plan, /it is marked done automatically when that ticket closes/);
    });
}

main().then(() => console.log(`\n${passed} checks passed.`));
