// tests/blog-keywords-chat.test.ts
// The Blog Writer chat can change keywords — one article's (blog_action_proposal "keywords") or one
// keyword on every article (blog_keyword_proposal) — by a card the user confirms, through the same
// endpoints as Blog Studio's keyword box (save-blog-draft) and Blog setup ▸ Keywords (blog-keywords).
//
// WHY THIS EXISTS. A customer's blog moved from employee wellness to women approaching retirement
// (2026-11-14) and nothing — GUI or chat — could change its keywords. These pin that the chat SEES
// the keywords, that every card is rebuilt from the database (never the model's counts), and that a
// click goes through the GUI's endpoints.
//
// Run:  npx tsx tests/blog-keywords-chat.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blogActionFromUiElement, refreshBlogActionCards, resolveBlogActionProposal } from '../src/utils/chat-blog-action';
import {
    BLOG_KEYWORD_PROPOSAL_TYPE, blogKeywordCardFrom, blogKeywordFromUiElement, renderBlogKeywordsForChat,
} from '../src/utils/chat-blog-keywords';
import { blogKeywordsExtra } from '../src/utils/content-snapshot';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

function fakeDb(...answers: unknown[][]) {
    const queue = [...answers];
    return {
        select: () => {
            const rows = queue.shift() ?? [];
            const chain: any = {
                from: () => chain, where: () => chain, limit: () => Promise.resolve(rows),
                then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej),
            };
            return chain;
        },
    } as any;
}
const neverParse = async () => { throw new Error('the parser must not be called'); };
const article = (status: string, tags: unknown = ['employee wellness', 'burnout']) =>
    ({ id: 7, status, title: 'Planning a happy retirement', publishDate: null, bodyMarkdown: 'x', tags });
const ROWS = [
    { keyword: 'employee wellness', articles: 6, published: 4 },
    { keyword: 'retirement', articles: 2, published: 1 },
];

(async () => {
    console.log('\nOne article: blog_action_proposal "keywords"');

    await check('the proposal is cleaned like every keyword writer, capped at 3; none at all is not a proposal', () => {
        const req = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'keywords', postId: '#7', keywords: [' Retirement ', 'MONEY', 'retirement', 'wellbeing', 'extra'] });
        assert.deepStrictEqual(req?.keywords, ['retirement', 'money', 'wellbeing']);
        assert.strictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'keywords', postId: 7, keywords: ['  '] }), null);
        assert.strictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'keywords', postId: 7 }), null);
        // Other actions keep their shape: no keywords key.
        assert.ok(!('keywords' in (blogActionFromUiElement({ type: 'blog_action_proposal', action: 'approve', postId: 7 }) as object)));
    });

    await check('the card shows the keywords the article has NOW, read from the row, beside the new ones', async () => {
        const req = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'keywords', postId: 7, keywords: ['retirement'] })!;
        const card = await resolveBlogActionProposal(fakeDb([article('published')]), 1, 2, req, null, neverParse);
        assert.deepStrictEqual(card?.currentKeywords, ['employee wellness', 'burnout']);
        assert.deepStrictEqual(card?.keywords, ['retirement']);
        assert.strictEqual(card?.blocked, null, 'a live article can have its keywords changed');
    });

    await check('blocked while publishing or archived, and when nothing would change', async () => {
        const req = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'keywords', postId: 7, keywords: ['burnout', 'employee wellness'] })!;
        for (const s of ['publishing', 'archived']) {
            const c = await resolveBlogActionProposal(fakeDb([article(s, [])]), 1, 2, req, null, neverParse);
            assert.ok(c?.blocked && /publishing|archived/.test(c.blocked), s);
        }
        const same = await resolveBlogActionProposal(fakeDb([article('draft')]), 1, 2, req, null, neverParse);
        assert.match(same?.blocked ?? '', /already has exactly these keywords/);
    });

    await check('a stored card settles once the article carries those keywords', async () => {
        const ui = { type: 'blog_action_proposal', action: 'keywords', postId: 7, keywords: ['retirement'] };
        const [after] = await refreshBlogActionCards(fakeDb([{ id: 7, status: 'draft', tags: ['retirement'] }]), 1, 2, [{ uiElement: ui }]);
        assert.strictEqual((after.uiElement as any).settled, true);
        const [before] = await refreshBlogActionCards(fakeDb([{ id: 7, status: 'draft', tags: ['burnout'] }]), 1, 2, [{ uiElement: ui }]);
        assert.ok(!(before.uiElement as any).settled);
    });

    console.log('\nEvery article: blog_keyword_proposal');

    await check('parsing: rename needs a different new keyword; remove needs only the old one', () => {
        assert.deepStrictEqual(blogKeywordFromUiElement({ type: BLOG_KEYWORD_PROPOSAL_TYPE, op: 'rename', from: 'Employee Wellness', to: ' Retirement ' }),
            { op: 'rename', from: 'employee wellness', to: 'retirement' });
        assert.strictEqual(blogKeywordFromUiElement({ type: BLOG_KEYWORD_PROPOSAL_TYPE, op: 'rename', from: 'a', to: 'A' }), null);
        assert.strictEqual(blogKeywordFromUiElement({ type: BLOG_KEYWORD_PROPOSAL_TYPE, op: 'rename', from: 'a' }), null);
        assert.deepStrictEqual(blogKeywordFromUiElement({ type: BLOG_KEYWORD_PROPOSAL_TYPE, op: 'remove', from: 'burnout', to: 'x' }), { op: 'remove', from: 'burnout', to: null });
        assert.strictEqual(blogKeywordFromUiElement({ type: BLOG_KEYWORD_PROPOSAL_TYPE, op: 'delete', from: 'x' }), null);
    });

    await check('counts come from the blog; renaming onto a keyword in use is a merge', () => {
        const merge = blogKeywordCardFrom({ op: 'rename', from: 'employee wellness', to: 'retirement' }, ROWS);
        assert.deepStrictEqual([merge.merge, merge.articles, merge.published, merge.blocked], [true, 6, 4, null]);
        const rename = blogKeywordCardFrom({ op: 'rename', from: 'employee wellness', to: 'later life' }, ROWS);
        assert.strictEqual(rename.merge, false);
    });

    await check('a keyword no article uses is blocked, naming the ones that are used', () => {
        const c = blogKeywordCardFrom({ op: 'remove', from: 'stress', to: null }, ROWS);
        assert.match(c.blocked ?? '', /No article uses the keyword “stress”.*“employee wellness”, “retirement”/);
        assert.match(blogKeywordCardFrom({ op: 'remove', from: 'x', to: null }, []).blocked ?? '', /no keywords yet/);
    });

    console.log('\nThe chat sees keywords and is told about them');

    await check('each article line carries its keywords, and the blog-wide list carries counts', () => {
        assert.strictEqual(blogKeywordsExtra(['retirement', 'money']), 'keywords: retirement, money');
        assert.strictEqual(blogKeywordsExtra(null), 'no keywords');
        const line = renderBlogKeywordsForChat(ROWS);
        assert.match(line, /"employee wellness" \(6 articles, 4 live\)/);
        assert.match(renderBlogKeywordsForChat([]), /none yet/);
        const snap = read('src/utils/content-snapshot.ts');
        assert.ok(snap.includes('extra: blogKeywordsExtra(r.tags)') && snap.includes('renderBlogKeywordsForChat'));
    });

    await check('the blog prompt names both places and both cards, and says "keywords" not "tags"', () => {
        const chat = read('netlify/functions/chat-orchestrator.ts');
        const i = chat.indexOf('KEYWORDS — each article has up to 3 keywords');
        assert.ok(i > 0, 'KEYWORDS paragraph');
        const para = chat.slice(i, chat.indexOf('\n', i));
        for (const s of ['never "tags"', 'Keywords, SEO & social preview', 'Blog setup', 'action "keywords"', '"blog_keyword_proposal"', 'Topics & themes']) assert.ok(para.includes(s), s);
        assert.ok(chat.includes('| "pictures" | "keywords",'), 'the action is in the JSON shape');
        assert.ok(chat.includes('blogKeywordFromUiElement(uiElement)') && chat.includes('resolveBlogKeywordProposal(db, orgId, blogKeywordReq)'));
        assert.ok(chat.includes('(!!blogKeyword && uiElement === blogKeyword)'), 'the reply beside the card never claims it is done');
    });

    console.log('\nA click goes through the GUI\'s endpoints');

    await check('the article card → save-blog-draft { tags }; the blog-wide card → blog-keywords', () => {
        const cs = read('src/components/chat-session.js');
        const kw = cs.slice(cs.indexOf("} else if (d.action === 'keywords') {"), cs.indexOf("throw new Error('Unknown action.');", cs.indexOf("} else if (d.action === 'keywords') {")));
        assert.ok(kw.includes("postActionCall('save-blog-draft', { id: d.postId, tags:"), 'save-blog-draft');
        const wide = cs.slice(cs.indexOf('async function onBlogKeywords(e)'), cs.indexOf('// Email action cards → newsletter-issues'));
        assert.ok(wide.includes("postActionCall('blog-keywords'") && wide.includes("action: 'remove', keyword: d.from") && wide.includes("action: 'rename', from: d.from, to: d.to"));
        assert.ok(cs.includes("container.addEventListener('blog:keywords', onBlogKeywords);") && cs.includes("container.removeEventListener('blog:keywords', onBlogKeywords);"));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('blog_keyword_proposal', renderBlogKeywordProposalCard);"));
        assert.ok(reg.includes("keywords: { head: 'Change this article’s keywords'"));
        assert.ok(reg.includes("new CustomEvent('blog:keywords'"));
        const refresh = read('src/utils/chat-card-refresh.ts');
        assert.ok(refresh.includes('refreshBlogKeywordCards(db, organisationId, out)'));
    });

    console.log(`\n${passed}/${total} checks passed\n`);
    if (passed !== total) process.exitCode = 1;
})();
