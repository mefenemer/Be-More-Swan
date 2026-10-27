// tests/blog-batch-and-bubbles.test.ts
// Owner's list, 2026-10-27: the Blog Writer drafting several articles at once, assistant pop-up
// bubbles (+ the Business Mentor's suggestions and their Team Chat copy), "Mark as done" on Needs
// you, and the Lead Generator tab rename / divider / Awaiting-reply pointer.
//
// Run:  npx tsx tests/blog-batch-and-bubbles.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blogBatchFromUiElement, MAX_BATCH_ARTICLES } from '../src/utils/blog-chat-batch';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

check('a batch card keeps every distinct title, with its brief, and says how many it left out', () => {
    const card = blogBatchFromUiElement({ type: 'blog_batch_proposal', topics: [
        { title: ' Hire the Outcome ', brief: 'why roles beat tools' }, { title: 'hire the outcome' }, 'Plain English',
        { title: '' },
    ] });
    assert.deepStrictEqual(card?.topics, [{ title: 'Hire the Outcome', brief: 'why roles beat tools' }, { title: 'Plain English', brief: null }]);
    const many = blogBatchFromUiElement({ type: 'blog_batch_proposal', topics: Array.from({ length: MAX_BATCH_ARTICLES + 2 }, (_, i) => `T${i}`) });
    assert.strictEqual(many?.topics.length, MAX_BATCH_ARTICLES);
    assert.strictEqual(many?.more, 2);
    assert.strictEqual(blogBatchFromUiElement({ type: 'blog_post_draft', topics: ['x'] }), null);
});

check('the batch queues through the interactive worker path, hidden while it is written', () => {
    const gen = read('netlify/functions/generate-blog.ts');
    const branch = gen.slice(gen.indexOf('if (Array.isArray(body.batch))'), gen.indexOf('const id = Number(body.blogPostId)'));
    assert.match(branch, /status: 'pending_approval'/);
    assert.match(branch, /jobId,\n/, 'stamped with its job, so notStillGenerating() hides it until the body lands');
    assert.match(branch, /resultBlogPostId: post\.id/, 'pre-set, so the worker drafts into it and never ideates');
});

check('the blog chat is told to propose a batch, never to refuse or write several in one reply', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.match(o, /emit a blog_batch_proposal \(shape below\) with ONE topic per article/);
    assert.ok(!/If they ask for several, write the FIRST one properly and offer the next\./.test(o));
    assert.match(read('src/utils/chat-card-refresh.ts'), /refreshBlogBatchCards/);
    assert.match(read('src/components/chat-session.js'), /addEventListener\('blog:batch', onBlogBatch\)/);
});

check('bubbles: page nudges, Mentor suggestions copied to Team Chat once a day, notifications too', () => {
    const fn = read('netlify/functions/assistant-nudges.ts');
    assert.match(fn, /eq\(mentorProposals\.targetAssistantId, assistant\.id\)/);
    assert.match(fn, /gt\(teamMessages\.createdAt, since\)/, 'deduped per day');
    assert.match(fn, /kind: 'message'/);
    assert.match(read('src/components/assistant-bubbles.js'), /const SHOW_MS = 5000;/);
    assert.match(read('notifications.js'), /AssistantBubbles\?\.onNotificationsRose/);
    assert.match(read('workspace.html'), /assistant-bubbles\.js/);
});

check('"while you work" bubbles reach Team Chat too; a chat button starts the chat on the reminder, unsent', () => {
    const fn = read('netlify/functions/assistant-nudges.ts');
    assert.match(fn, /const spotted = body\.spotted === true;/);
    assert.match(fn, /if \(!spotted\) try \{/, 'Mentor suggestions only on page open');
    assert.match(fn, /\.\.\.\(n\.view \? \{ view: n\.view \} : \{\}\)/);
    const b = read('src/components/assistant-bubbles.js');
    assert.match(b, /function say\(key, b\) \{[\s\S]{0,400}fetch\('\/\.netlify\/functions\/assistant-nudges'[\s\S]{0,200}spotted: true/);
    assert.match(b, /openAssistantChat\?\.\(\{ assistantId, \.\.\.\(text \? \{ draft: chatDraft\(text\) \} : \{\}\) \}\)/, 'draft, never send');
    assert.doesNotMatch(b, /openAssistantChat\?\.\(\{[^}]*send:/);
    assert.match(read('src/components/team-feed.js'), /if \(l\.view\) \{ window\.loadView\?\.\(l\.view\); return; \}/);
    assert.match(read('assistants.js'), /say\('outreach-no-postal', \{[\s\S]{0,400}view: 'assets',/);
});

check('Needs you items can be marked done without running their action', () => {
    const n = read('notifications.js');
    assert.match(n, /class="action-done/);
    assert.match(n, /querySelector\('\.action-done'\)[\s\S]{0,120}setResolved\(notif\.id\)/);
    assert.match(n, /pop-done[\s\S]{0,400}patch\(n\.id, \{ resolved: true \}\)/);
});

check('Lead Generator: All leads, a divider before supporting tabs, and Conversations folded into a staged Outreach', () => {
    const registry = read('src/components/assistant-dashboard-registry.js');
    assert.match(registry, /label: 'All leads'/);
    assert.match(read('assistant-detail.html'), /id="maintab-support-divider"/);
    const js = read('assistants.js');
    assert.match(js, /supportDivider\.classList\.toggle\('hidden', !goalsAnchor\)/);
    // Was: the Awaiting reply column pointed at the Conversations tab. Both are now stages of one
    // Outreach tab (docs/lead-outreach-restructure-plan.md), with Results straight after it.
    assert.match(registry, /staged: true/);
    assert.match(registry, /resultsTabAfter: 'review-queue'/);
    assert.ok(!js.includes('maintab-btn-conversations'), 'nothing should point at the retired Conversations tab button');
    assert.ok(!read('index.html').includes('Autonomous Digital Workforce'));
});

// ── Later the same day: AI images, the preview, the AI notice, the QR card ──
check('every AI image is asked for no text, and typed requests are turned into a scene first', () => {
    const gw = read('src/lib/fal-gateway.ts');
    assert.match(gw, /prompt: opts\.allowText \? opts\.prompt : `\$\{opts\.prompt\.trim\(\)\}\\n\\n\$\{NO_TEXT_RULE\}`/);
    assert.match(read('netlify/functions/generate-ai-image.ts'), /prompts: await visualisePrompts\(prompt, 4/);
    assert.match(read('src/lib/image-prompt.ts'), /return request;/, 'fails open to the person\'s own words');
});

check('all three pickers offer a large preview whose button runs the picker\'s own choose', () => {
    assert.match(read('src/components/media-picker.js'), /ImageLightbox\.open\([\s\S]{0,200}picks\[i\]\.click\(\)/);
    assert.match(read('my-content.js'), /window\._mcZoomAI = function/);
    assert.match(read('src/components/blog-studio-modal.js'), /ImageLightbox\.open\(/);
    for (const page of ['workspace.html', 'assistant-chat.html', 'blog-studio.html']) assert.match(read(page), /image-lightbox\.js/, page);
});

check('emails follow the workspace\'s AI-notice wording, so the assistant is only named if chosen', () => {
    const f = read('src/utils/ai-email-footer.ts');
    assert.match(f, /workspaceText\?\.trim\(\) \? workspaceText\.trim\(\) : DEFAULT_FOOTER_TEXT/);
    assert.match(f, /split\('\{assistant\}'\)\.join\(assistantName\)/);
    assert.match(read('netlify/functions/send-outbound-email.ts'), /injectAiFooter\(bodyText, assistant\.name, customDisclosureText, false, workspaceText\)/);
    assert.match(read('user-settings.html'), /name="ai-notice-mode" value="plain"/);
});

check('the QR business card: name, purpose, email, website links, company details, not indexed', () => {
    const c = read('card.html');
    assert.match(c, /noindex/);
    assert.match(c, /mailto:hello@bemoreswan\.com/);
    assert.match(c, /href="https:\/\/bemoreswan\.com\/"/);
    assert.match(c, /company number 17378263/);
    // Option A wording (owner, 2026-10-27): the growing team, approval, brand rules, time and cost.
    assert.match(c, /A growing team of AI assistants for your business/);
    assert.match(c, /You check and approve the work; they take the hours\./);
    assert.match(c, /<meta name="description" content="Be More Swan: a growing team of pre-trained AI assistants/);
    assert.doesNotMatch(c, /Your AI team for the busywork/);
    assert.match(read('be-more-swan.vcf'), /EMAIL;TYPE=WORK:hello@bemoreswan\.com/);
});

console.log(`\n${passed} checks passed.`);
