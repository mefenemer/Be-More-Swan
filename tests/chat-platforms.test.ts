// tests/chat-platforms.test.ts
// Chats see which connected platforms their assistant posts to — the "Use for this assistant"
// switches in Assistant Profile ▸ Connections — and propose turning them on or off through a card
// that saves exactly as the switch does (update-assistant-context.ts).
//
// WHY THIS EXISTS. "Stop posting to Facebook" could only be done with the switch. These pin the parts
// that would go quietly wrong: the card writes the same three lists the switch writes; it refuses a
// platform that is not connected; it refuses turning the LAST switch off (an empty selection means
// "draft for every platform", not none); the click refuses if the switches moved since the card was
// drawn; and the detail page's own copy is updated so its autosave cannot write the old switches back.
//
// Run:  npx tsx tests/chat-platforms.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildPlatformsBlock, buildPlatformsCard, platformsProposalFromUiElement, refreshPlatformsCards, resolvePlatformsProposal, selectedIds,
    type LiveConnection,
} from '../src/utils/chat-platforms';
import { aiAssistants, systemConnections, workspaceIntegrations } from '../db/schema';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** Rows by table, whatever the query shape. */
function fakeDb(tables: { assistant?: Record<string, unknown> | null; sys?: unknown[]; ws?: unknown[] }) {
    return {
        select: () => {
            let rows: unknown[] = [];
            const chain: any = {
                from: (t: unknown) => {
                    if (t === aiAssistants) rows = tables.assistant ? [tables.assistant] : [];
                    else if (t === systemConnections) rows = tables.sys ?? [];
                    else if (t === workspaceIntegrations) rows = tables.ws ?? [];
                    return chain;
                },
                where: () => chain, leftJoin: () => chain, innerJoin: () => chain, orderBy: () => chain,
                limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}

const LIVE: LiveConnection[] = [{ id: 11, platform: 'instagram' }, { id: 12, platform: 'facebook' }, { id: -3, platform: 'threads' }];
const CTX = { linked_integrations: [11, 12], primary_platforms: ['ig', 'fb'], tone_of_voice: 'warm' };
const CONFIG = { appliedDefaults: { platforms: [11, 12] } };
const propose = (x: Record<string, unknown>) => platformsProposalFromUiElement({ type: 'platforms_proposal', ...x })!;
const SOCIAL_ROW = { role: 'Social Media Manager', roleKey: 'social_media_manager', ctx: CTX, config: CONFIG };

async function main() {
    console.log('\nReading the switches');

    await check('a switch is ON when its id is in either list, as the page draws it', () => {
        assert.deepStrictEqual(selectedIds({ linked_integrations: [12, '11'] }, { appliedDefaults: { platforms: [-3, 0, 'x'] } }), [-3, 11, 12]);
        assert.deepStrictEqual(selectedIds(null, null), []);
    });

    await check('the chat lists live connections only, one per platform, with the workspace-backed ones', async () => {
        const db = fakeDb({
            assistant: SOCIAL_ROW,
            sys: [
                { id: 11, serviceName: 'instagram', status: 'active' },
                { id: 9, serviceName: 'instagram', status: 'disconnected' }, // older row loses, as in integrations.ts
                { id: 12, serviceName: 'facebook', status: 'active' },
                { id: 13, serviceName: 'linkedin', status: 'token_refresh_failed' },
            ],
            ws: [{ id: 3, provider: 'threads', status: 'active' }],
        });
        const block = (await buildPlatformsBlock(db, 1, 7, 5))!;
        assert.ok(block.includes('- Instagram: ON') && block.includes('- Facebook: ON') && block.includes('- Threads: off'), block);
        assert.ok(!block.includes('LinkedIn:'), 'a broken connection has no switch to flip');
        assert.ok(block.includes('"type": "platforms_proposal"'));
    });

    await check('a role with no social connectors gets no block', async () => {
        const db = fakeDb({ assistant: { ...SOCIAL_ROW, role: 'Inbox Manager', roleKey: 'inbox_manager' }, sys: [{ id: 11, serviceName: 'instagram', status: 'active' }] });
        assert.strictEqual(await buildPlatformsBlock(db, 1, 7, 5), null);
    });

    await check('with nothing ticked the block says it drafts for every platform', async () => {
        const db = fakeDb({ assistant: { ...SOCIAL_ROW, ctx: { tone_of_voice: 'warm' }, config: {} }, sys: [{ id: 11, serviceName: 'instagram', status: 'active' }] });
        const block = (await buildPlatformsBlock(db, 1, 7, 5))!;
        assert.ok(block.includes('- Instagram: off') && block.includes('drafts for EVERY connected platform'), block);
    });

    console.log('\nThe card');

    await check('turning one off writes the same three lists the switch writes', () => {
        const card = buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOff: ['Facebook'] }));
        assert.strictEqual(card.blocked, null);
        assert.deepStrictEqual(card.before, [11, 12]);
        assert.deepStrictEqual(card.linked, [11]);
        assert.deepStrictEqual(card.codes, ['ig']);
        assert.deepStrictEqual(card.changes, [{ platform: 'Facebook', on: false }]);
        assert.deepStrictEqual([card.nowOn, card.afterOn], [['Instagram', 'Facebook'], ['Instagram']]);
    });

    await check('turning on a workspace-backed one uses its negative id and short code', () => {
        const card = buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOn: ['threads'] }));
        assert.deepStrictEqual(card.linked, [-3, 11, 12]);
        assert.deepStrictEqual(card.codes, ['ig', 'fb', 'th']);
    });

    await check('an id for a connection that has since gone is kept, as the switch keeps it', () => {
        const card = buildPlatformsCard(5, LIVE, { linked_integrations: [11, 12, 99] }, {}, propose({ turnOff: ['facebook'] }));
        assert.deepStrictEqual(card.linked, [11, 99]);
        assert.deepStrictEqual(card.codes, ['ig'], 'codes cover live connections only');
    });

    await check('not connected, unknown, already so, and the last switch off are all refused', () => {
        assert.match(buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOn: ['linkedin'] })).blocked!, /LinkedIn isn’t connected/);
        assert.match(buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOn: ['myspace'] })).blocked!, /isn’t a platform/);
        assert.match(buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOn: ['instagram'] })).blocked!, /already/);
        assert.match(buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOff: ['instagram', 'facebook'] })).blocked!, /pause the assistant/);
        assert.strictEqual(platformsProposalFromUiElement({ type: 'platforms_proposal' }), null);
    });

    await check('the proposal resolves against this user’s live connections', async () => {
        const db = fakeDb({ assistant: SOCIAL_ROW, sys: [{ id: 11, serviceName: 'instagram', status: 'active' }, { id: 12, serviceName: 'facebook', status: 'active' }] });
        const card = (await resolvePlatformsProposal(db, 1, 7, 5, propose({ turnOff: ['twitter'] })))!;
        assert.match(card.blocked!, /X isn’t connected/);
        assert.strictEqual(await resolvePlatformsProposal(fakeDb({ assistant: null }), 1, 7, 5, propose({ turnOff: ['facebook'] })), null);
    });

    await check('a stored card closes once done, or once the switches moved under it', async () => {
        const stored = { uiElement: buildPlatformsCard(5, LIVE, CTX, CONFIG, propose({ turnOff: ['facebook'] })) };
        const [done] = await refreshPlatformsCards(fakeDb({ assistant: { ctx: { linked_integrations: [11] }, config: { appliedDefaults: { platforms: [11] } } } }), 1, 5, [stored]);
        assert.match((done.uiElement as any).blocked, /Already done/);
        const [moved] = await refreshPlatformsCards(fakeDb({ assistant: { ctx: { linked_integrations: [11, 12, -3] }, config: {} } }), 1, 5, [stored]);
        assert.match((moved.uiElement as any).blocked, /changed since/);
        const [open] = await refreshPlatformsCards(fakeDb({ assistant: { ctx: CTX, config: CONFIG } }), 1, 5, [stored]);
        assert.strictEqual((open.uiElement as any).blocked, null);
    });

    console.log('\nThe click and the page');

    await check('the click re-reads, refuses on a moved switch, and saves as the switch does', () => {
        const src = read('src/components/chat-session.js');
        const at = src.indexOf('async function onPlatformsChange');
        assert.ok(at > -1);
        const fn = src.slice(at, src.indexOf('async function onLeadAction', at));
        assert.ok(fn.includes('get-assistant-context') && fn.includes('The switches have changed since'));
        assert.ok(/primary_platforms: codes, linked_integrations: linked \}, appliedDefaults: \{ platforms: linked \}/.test(fn), 'same three lists as _intToggleUseForAssistant');
        assert.ok(src.includes("addEventListener('platforms:change', onPlatformsChange)") && src.includes("removeEventListener('platforms:change', onPlatformsChange)"));
    });

    await check('the switch and the card both tell the detail page, which updates its autosave copy', () => {
        const integrations = read('integrations.js');
        const toggle = integrations.slice(integrations.indexOf('window._intToggleUseForAssistant = async function'), integrations.indexOf('// ── Load & render platform cards'));
        assert.ok(toggle.includes("new CustomEvent('assistant:platformsChanged'"), 'the switch must announce its save');
        assert.ok(integrations.includes("document.addEventListener('assistant:platformsChanged'"), 'the switches repaint on a chat change');
        const assistants = read('assistants.js');
        const at = assistants.indexOf("document.addEventListener('assistant:platformsChanged'");
        assert.ok(at > -1);
        const handler = assistants.slice(at, assistants.indexOf('});', at));
        assert.ok(handler.includes('linked_integrations') && handler.includes('appliedDefaults'), 'both the context and the configuration copy');
    });

    await check('the page refuses the last switch too, before it saves anything', () => {
        const integrations = read('integrations.js');
        const toggle = integrations.slice(integrations.indexOf('window._intToggleUseForAssistant = async function'), integrations.indexOf('// ── Load & render platform cards'));
        const guard = toggle.indexOf('liveOn.length === 1');
        assert.ok(guard > -1, 'the switch must refuse turning the last live platform off');
        assert.ok(guard < toggle.indexOf('update-assistant-context'), 'refused before the save');
        assert.ok(toggle.slice(guard, toggle.indexOf('update-assistant-context')).includes('pause the assistant'));
    });

    await check('the card is registered and the orchestrator offers it', () => {
        assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('platforms_proposal', renderPlatformsProposalCard)"));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('buildPlatformsBlock(db, orgId, userId, session.aiAssistantId)') && orch.includes('resolvePlatformsProposal('));
        assert.ok(read('src/utils/chat-card-refresh.ts').includes('refreshPlatformsCards('));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
