// tests/chat-library.test.ts
// The Support Agent's chat adds Knowledge Base articles, and the Social Media / Blog Writer chats add
// Inspo, through confirm cards that POST to the tabs' own endpoints (kb-articles.ts, inspo-items.ts).
//
// WHY THIS EXISTS. Both chats used their library but could not add to it, nor say what was in it.
// These pin: the card is checked by the endpoint's OWN rules (library-rules.ts, imported by both), so
// it never offers a button the endpoint refuses; the roles match the tabs in the dashboard registry;
// the click sends what the tab's Save sends; and the tab reloads when the chat adds something.
//
// Run:  npx tsx tests/chat-library.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    INSPO_ROLES, KB_ROLES, buildLibraryBlock, buildLibraryCard, libraryProposalFromUiElement, refreshLibraryCards,
} from '../src/utils/chat-library';
import { INSPO_MAX_ITEMS, KB_MAX_ARTICLES, KB_MAX_CONTENT_CHARS } from '../src/utils/library-rules';
import { inspoItems, kbArticles } from '../db/schema';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/** Rows by table; a select of count(*) gets [{ n }]. */
function fakeDb(tables: { kb?: Array<Record<string, unknown>>; inspo?: Array<Record<string, unknown>> }) {
    return {
        select: (cols: Record<string, unknown>) => {
            let rows: unknown[] = [];
            const chain: any = {
                from: (t: unknown) => {
                    const all = t === kbArticles ? tables.kb ?? [] : t === inspoItems ? tables.inspo ?? [] : [];
                    rows = 'n' in cols ? [{ n: all.length }] : all;
                    return chain;
                },
                where: () => chain, orderBy: () => chain, limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}

const kb = (x: Record<string, unknown>) => libraryProposalFromUiElement({ type: 'kb_article_proposal', ...x })!;
const inspo = (x: Record<string, unknown>) => libraryProposalFromUiElement({ type: 'inspo_proposal', ...x })!;

async function main() {
    console.log('\nWhich chats');

    await check('the role lists match the tabs in the dashboard registry', () => {
        const reg = read('src/components/assistant-dashboard-registry.js');
        const ownerOf = (marker: string) => {
            const roles: string[] = [];
            let at = reg.indexOf(marker);
            while (at > -1) {
                const before = reg.slice(0, at);
                const keys = [...before.matchAll(/^ {4}([a-z0-9_]+): \{/gm)];
                roles.push(keys[keys.length - 1][1]);
                at = reg.indexOf(marker, at + 1);
            }
            return roles.sort();
        };
        assert.deepStrictEqual(ownerOf('      kbTab: {'), [...KB_ROLES].sort());
        assert.deepStrictEqual(ownerOf('      inspoTab: {'), [...INSPO_ROLES].sort());
    });

    await check('the Support Agent sees its articles; Social sees its Inspo; others see neither', async () => {
        const db = fakeDb({ kb: [{ title: 'Refund policy' }, { title: 'Opening hours' }], inspo: [{ title: 'That launch thread' }] });
        const support = (await buildLibraryBlock(db, 1, 5, 'tier1_support_agent'))!;
        assert.ok(support.includes('2 articles') && support.includes('- "Refund policy"') && support.includes('"kb_article_proposal"'), support);
        assert.ok(support.includes('add none of your own'), 'the article must be the user’s facts');
        const social = (await buildLibraryBlock(db, 1, 5, 'social_media_manager'))!;
        assert.ok(social.includes('1 item') && social.includes('- "That launch thread"') && social.includes('never write an example yourself'), social);
        assert.strictEqual(await buildLibraryBlock(db, 1, 5, 'newsletter_editor'), null);
    });

    console.log('\nKnowledge Base card');

    await check('an article shows exactly what will be saved', () => {
        const card = buildLibraryCard(5, 'tier1_support_agent', kb({ title: ' Refund policy ', content: 'Refunds within 30 days with a receipt.' }), 3);
        assert.deepStrictEqual([card.blocked, (card as any).title, (card as any).content], [null, 'Refund policy', 'Refunds within 30 days with a receipt.']);
    });

    await check('the endpoint’s refusals are the card’s refusals', () => {
        assert.match(buildLibraryCard(5, 'tier1_support_agent', kb({ title: '', content: 'x' }), 0).blocked!, /title/);
        assert.match(buildLibraryCard(5, 'tier1_support_agent', kb({ title: 'T', content: '' }), 0).blocked!, /content/);
        assert.match(buildLibraryCard(5, 'tier1_support_agent', kb({ title: 'T', content: 'x'.repeat(KB_MAX_CONTENT_CHARS + 1) }), 0).blocked!, /too long/);
        assert.match(buildLibraryCard(5, 'tier1_support_agent', kb({ title: 'T', content: 'x' }), KB_MAX_ARTICLES).blocked!, /full/);
        assert.match(buildLibraryCard(5, 'social_media_manager', kb({ title: 'T', content: 'x' }), 0).blocked!, /doesn’t have a Knowledge Base/);
    });

    console.log('\nInspo card');

    await check('a pasted note keeps its text and gets the tab’s own title', () => {
        const card = buildLibraryCard(5, 'blog_writer', inspo({ kind: 'text', body: 'Short sentences.\nNo jargon.', note: 'how plain it is' }), 0) as any;
        assert.deepStrictEqual([card.blocked, card.kind, card.title, card.body, card.note], [null, 'text', 'Short sentences.', 'Short sentences.\nNo jargon.', 'how plain it is']);
    });

    await check('a link is checked by the endpoint’s own rule and titled by its host', () => {
        const ok = buildLibraryCard(5, 'social_media_manager', inspo({ url: 'https://example.com/post' }), 0) as any;
        assert.deepStrictEqual([ok.blocked, ok.kind, ok.url, ok.title], [null, 'url', 'https://example.com/post', 'example.com']);
        assert.match(buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'url', url: 'https://docs.google.com/document/d/1' }), 0).blocked!, /Google Docs/);
        assert.match(buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'url', url: 'ftp://x' }), 0).blocked!, /http and https/);
    });

    await check('empty, full, and the wrong role are refused', () => {
        assert.match(buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'text', body: '' }), 0).blocked!, /no text/);
        assert.match(buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'text', body: 'x' }), INSPO_MAX_ITEMS).blocked!, /full/);
        assert.match(buildLibraryCard(5, 'tier1_support_agent', inspo({ kind: 'text', body: 'x' }), 0).blocked!, /doesn’t have an Inspo/);
    });

    await check('a stored card closes once its article, text or link is already there', async () => {
        const db = fakeDb({ kb: [{ title: 'Refund Policy' }], inspo: [{ body: 'Short sentences.', sourceUrl: null }, { body: null, sourceUrl: 'https://example.com/post' }] });
        const msgs = [
            { uiElement: buildLibraryCard(5, 'tier1_support_agent', kb({ title: 'refund policy', content: 'x' }), 0) },
            { uiElement: buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'text', body: 'Short sentences.' }), 0) },
            { uiElement: buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'url', url: 'https://example.com/post' }), 0) },
            { uiElement: buildLibraryCard(5, 'social_media_manager', inspo({ kind: 'text', body: 'Something new' }), 0) },
        ];
        const out = await refreshLibraryCards(db, 1, 5, msgs);
        assert.deepStrictEqual(out.map((m) => (m.uiElement as any).blocked), ['Already added.', 'Already added.', 'Already added.', null]);
    });

    console.log('\nWiring');

    await check('both endpoints take their limits and the link check from library-rules.ts', () => {
        const kbSrc = read('netlify/functions/kb-articles.ts');
        const inspoSrc = read('netlify/functions/inspo-items.ts');
        assert.ok(kbSrc.includes("from '../../src/utils/library-rules'") && kbSrc.includes('const MAX_CONTENT_CHARS = KB_MAX_CONTENT_CHARS;'));
        assert.ok(inspoSrc.includes("from '../../src/utils/library-rules'") && !inspoSrc.includes('function validateInspoUrl('), 'one copy of the link check');
    });

    await check('the click sends what the tab’s Save sends, and the tabs reload', () => {
        const src = read('src/components/chat-session.js');
        const at = src.indexOf('async function onLibraryAdd');
        const fn = src.slice(at, src.indexOf('async function onLeadAction', at));
        assert.ok(fn.includes("{ assistantId: id, title: d.title, content: d.content, source: 'manual' }"));
        assert.ok(fn.includes("kind: 'url', sourceUrl: d.url") && fn.includes("kind: 'text', body: d.body"));
        assert.ok(src.includes("addEventListener('library:add', onLibraryAdd)") && src.includes("removeEventListener('library:add', onLibraryAdd)"));
        for (const tab of ['src/components/assistant-knowledge-base.js', 'src/components/assistant-inspo.js']) {
            assert.ok(read(tab).includes("addEventListener('assistant:libraryChanged'"), `${tab} must reload on a chat add`);
        }
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('kb_article_proposal', renderLibraryProposalCard)") && reg.includes("register('inspo_proposal', renderLibraryProposalCard)"));
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('resolveLibraryProposal(') && read('src/utils/chat-card-refresh.ts').includes('refreshLibraryCards('));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
