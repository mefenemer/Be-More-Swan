// tests/requested-by-knowledge-resize.test.ts
// Three changes from one request (owner, 2026-10-23):
//   1. "Requested by [assistant]" — a second pill beside "Created by" on every card whose work
//      another assistant asked for (src/utils/requested-by.ts).
//   2. Brand Knowledge actually reaching drafts: blueprints recompile when a Business Information
//      document changes, and the chat reads the same documents (src/utils/business-knowledge.ts).
//   3. "Make it shorter / longer" for blog articles (Blog Studio + chat) and for saved social posts
//      from chat (src/utils/blog-resize.ts, chat-post-action.ts, chat-blog-action.ts).
// No network.
//
// Run:  npx tsx tests/requested-by-knowledge-resize.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectMedia, restoreMedia, wordCount, resizeDirective } from '../src/utils/blog-resize';
import { decodeInteractiveBrief, encodeInteractiveBrief } from '../src/utils/blog-interactive-brief';
import { businessKnowledgePromptBlock } from '../src/utils/business-knowledge';
import { postActionFromUiElement } from '../src/utils/chat-post-action';
import { blogActionFromUiElement } from '../src/utils/chat-blog-action';
import { requesterNamesForOrders, requesterNamesForJobIds, requesterNamesForBlogPosts } from '../src/utils/requested-by';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

async function main() {
    console.log('\nRequested by');
    await check('the lookups answer an empty page without touching the database', async () => {
        const noDb = new Proxy({}, { get() { throw new Error('db touched'); } }) as never;
        assert.strictEqual((await requesterNamesForOrders(noDb, 1, [])).size, 0);
        assert.strictEqual((await requesterNamesForJobIds(noDb, 1, [null, ''])).size, 0);
        assert.strictEqual((await requesterNamesForBlogPosts(noDb, 1, [])).size, 0);
    });
    await check('job lookups cover Campaign Assistant orders AND Orchestrations hand-offs', () => {
        const src = read('src/utils/requested-by.ts');
        assert.ok(src.includes('.innerJoin(aiAssistants, eq(aiAssistants.id, campaigns.aiAssistantId))'));
        assert.ok(src.includes('.from(orchestrationRuns)'));
    });
    await check('every list that feeds a card sends requestedBy', () => {
        assert.ok(read('netlify/functions/get-social-drafts.ts').includes('requestedBy: (d.jobId ? orderRequesters.get(d.jobId) : undefined) ?? handoffFrom.get(d.id) ?? null'));
        assert.ok(read('netlify/functions/blog-posts.ts').includes('requestedBy: requesters.get(p.id) ?? null'));
        const nl = read('netlify/functions/newsletter-issues.ts');
        assert.strictEqual((nl.match(/requestedBy: campaignOrderId != null/g) || []).length, 2, 'the Review feed and the full list');
        assert.ok(read('netlify/functions/scheduled-posts.ts').includes('requestedBy: (jobId ? requesters.get(jobId) : undefined) ?? null'));
        assert.ok(read('src/utils/visual-briefs.ts').includes('requestedBy: (b.campaignId ? campaignRequester.get(b.campaignId) : undefined)'));
    });
    await check('every card draws the second pill', () => {
        const ws = read('workspace.html');
        assert.ok(ws.includes('function rqRequestedPill(name, extraCls)'));
        assert.ok(ws.includes("rqRequestedPill((group.find(g => g.requestedBy) || {}).requestedBy)"), 'social card');
        assert.ok(ws.includes('rqRequestedPill(post.requestedBy)'), 'Review page blog card');
        assert.ok(ws.includes('rqRequestedPill(issue.requestedBy)'), 'Review page email card');
        const js = read('assistants.js');
        assert.ok(js.includes('function _rqOriginPills(createdBy, requestedBy)'));
        assert.ok(js.includes('_rqOriginPills(p.writtenByAssistant ?'), 'Blogs tab card');
        assert.ok(js.includes('_rqOriginPills((issue.generationReason || issue.isAutonomous) ?'), 'Emails tab card');
        assert.ok(read('src/components/assistant-briefs.js').includes('window.rqRequestedPill(b.requestedBy)'), 'design brief card');
        assert.ok(read('calendar.js').includes('Requested by ${_escHtml('), 'calendar list');
    });
    await check('a hand-off draft now says "Created by" — who asked is the second pill', () => {
        assert.ok(read('workspace.html').includes("case 'orchestration': return P(draft.requestedBy ? `Created by ${who}` : 'Team hand-off',"));
    });

    console.log('\nBrand Knowledge');
    await check('the knowledge block is null with nothing to honour, and lists documents and links', () => {
        assert.strictEqual(businessKnowledgePromptBlock({ documents: [], links: [] }), null);
        const b = businessKnowledgePromptBlock({ documents: [{ name: 'Brand guide', text: 'Never say cheap.' }], links: [{ name: 'Site', url: 'https://x.test' }] })!;
        assert.match(b, /^BUSINESS KNOWLEDGE — The business knowledge below is provided by the business owner and is AUTHORITATIVE/);
        assert.ok(b.includes('[Brand guide]\nNever say cheap.'));
        assert.ok(b.includes('Reference links:\n- Site: https://x.test'));
    });
    await check('the blueprint, the blog drafter and the chat share one loader and renderer', () => {
        assert.ok(read('src/utils/blueprint.ts').includes('const knowledge = await loadBusinessKnowledge(db, asst.organisationId);'));
        assert.ok(read('src/utils/blog-generate.ts').includes('businessKnowledgePromptBlock(sections['));
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes('const knowledgeBlock = await loadBusinessKnowledgeBlock(db, orgId);'));
        assert.ok(o.includes('[rolePrompt, rulesBlock, productsBlock, knowledgeBlock,'));
    });
    await check('a document added, finished, failed or removed recompiles the org\'s blueprints', () => {
        assert.ok(read('netlify/functions/delete-workspace-asset.ts').includes("recompileOrgBlueprints(db, asset.organisationId, 'business_knowledge_removed')"));
        const bg = read('netlify/functions/process-asset-background.ts');
        assert.ok(bg.includes("'business_knowledge_ready'") && bg.includes("'business_knowledge_failed'"));
        assert.ok(read('netlify/functions/add-text-assets.ts').includes("recompileOrgBlueprints(db, orgId, 'business_knowledge_rules')"));
    });

    console.log('\nShorter / longer');
    await check('pictures survive a rewrite: placeholders in, real lines back, dropped ones re-attached', () => {
        const body = '# Title\n\nIntro.\n\n:::media{asset=12 type=image}\n\nMore.\n\n:::media{asset=13 type=image alt="x"}\n';
        const { text, media } = protectMedia(body);
        assert.deepStrictEqual(media, [':::media{asset=12 type=image}', ':::media{asset=13 type=image alt="x"}']);
        assert.ok(!text.includes(':::media') && text.includes('[[PICTURE 1]]') && text.includes('[[PICTURE 2]]'));
        const back = restoreMedia('# Title\n\nShort.\n\n[[PICTURE 2]]\n\n[[PICTURE 9]]', media);
        assert.ok(back.includes(':::media{asset=13 type=image alt="x"}'));
        assert.ok(back.trimEnd().endsWith(':::media{asset=12 type=image}'), 'the dropped picture goes at the end');
        assert.ok(!back.includes('[[PICTURE'), 'an invented placeholder is never published');
    });
    await check('word counts match Blog Studio, and longer forbids invented facts', () => {
        assert.strictEqual(wordCount('# A title\n\nOne two three.'), 5);
        assert.match(resizeDirective('longer', 800), /Do NOT invent facts/);
        assert.match(resizeDirective('shorter', 800), /Add nothing new/);
    });
    await check('a resize brief needs no topic; anything else still does', () => {
        const r = decodeInteractiveBrief(encodeInteractiveBrief({ topic: '', resize: 'shorter' }));
        assert.strictEqual(r?.resize, 'shorter');
        assert.strictEqual(decodeInteractiveBrief(encodeInteractiveBrief({ topic: '' })), null);
        assert.strictEqual(decodeInteractiveBrief(JSON.stringify({ v: 1, topic: 'x', resize: 'huge' }))?.resize, undefined);
    });
    await check('the endpoint meters it as a helper and refuses a live article', () => {
        const g = read('netlify/functions/generate-blog.ts');
        assert.ok(g.includes("meterInteraction(db, organisationId, 'helpers')"));
        assert.ok(g.includes("resize && (post.status === 'published' || post.status === 'publishing')"));
        const w = read('netlify/functions/process-blog-jobs.ts');
        assert.ok(w.includes('if (!resize && job.trigger_type !== \'admin_test\' && !(await hasTaskCapacity('), 'no task check for a helper');
        assert.ok(w.indexOf('if (interactive && resize)') < w.indexOf('await generateBlogBody('), 'resize never drafts a new article');
    });
    await check('Blog Studio has both buttons, through the same queue', () => {
        const bs = read('src/components/blog-studio-modal.js');
        assert.ok(bs.includes('id="bs-resize-shorter"') && bs.includes('id="bs-resize-longer"'));
        assert.ok(bs.includes("JSON.stringify({ blogPostId: state.postId, resize: direction })"));
        assert.ok(bs.indexOf('flushDraft().then(function () {\n      return api(\'generate-blog\'') > 0, 'what is on screen is saved first');
    });
    await check('chat can propose shorter / longer for a saved post and a saved article', () => {
        assert.deepStrictEqual(postActionFromUiElement({ type: 'post_action_proposal', action: 'shorter', postId: 4 }), { action: 'shorter', postId: 4, reason: null, when: null });
        assert.deepStrictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'longer', postId: 9 }), { action: 'longer', postId: 9, reason: null, when: null });
        const cs = read('src/components/chat-session.js');
        assert.ok(cs.includes("postActionCall('rewrite-post-text', { postId: id, action: d.action })"), 'social: the editor\'s rewrite');
        assert.ok(cs.includes("postActionCall('generate-blog', { blogPostId: d.postId, resize: d.action })"), 'blog: Blog Studio\'s job');
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("shorter: { head: 'Make this post shorter'") && reg.includes("shorter: { head: 'Make this article shorter'"));
    });
}

main().then(() => console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`));
