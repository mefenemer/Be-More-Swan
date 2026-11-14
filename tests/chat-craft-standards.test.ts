// tests/chat-craft-standards.test.ts
// Owner, 2026-11-14 ("fix the email, social and blog craft gaps"): Admin ▸ Assistants ▸ Chat capabilities showed
// that the Social, Email Marketing and Blog chats wrote posts, emails and article parts WITHOUT the craft standard
// their background drafters use (platform-craft.ts, email-craft.ts, blog-craft.ts): a chat draft could be weaker
// than an autopilot one. Each chat prompt now carries the same standard.
// Run:  npx tsx tests/chat-craft-standards.test.ts

import assert from 'node:assert';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { platformCraftBlock } from '../src/constants/platform-craft';
import { emailCraftBlock } from '../src/constants/email-craft';
import { BLOG_CRAFT } from '../src/constants/blog-craft';
import { resolveTaskCosts } from '../src/utils/task-costs';
import { chatGapsFor } from '../src/utils/assistant-chat-capabilities';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const rc = (onboardingContext: Record<string, unknown> = {}, name = 'Juniper & Co') => ({
    assistantName: 'A', jobRole: null, baseSystemPrompt: null, onboardingContext,
    business: { name, industry: null, description: null }, taskCosts: resolveTaskCosts([]),
    contentSnapshot: '[snapshot]', audienceSnapshot: '[snapshot]', inspoBlock: 'INSPO-MARKER',
}) as Parameters<(typeof ROUTES)[string]['buildRolePrompt']>[0];
const before = (p: string, a: string, b: string) => { const i = p.indexOf(a), j = p.indexOf(b); assert.ok(i >= 0 && j >= 0 && i < j, `"${a.slice(0, 30)}" should come before "${b.slice(0, 30)}"`); };

console.log('Chat craft standards: Social, Email Marketing and Blog chats write to the drafters\' standard');

check('Social chat: platform craft for the configured platforms only', () => {
    const p = ROUTES.social_media_manager.buildRolePrompt(rc({ primary_platforms: ['linkedin'] }));
    assert.ok(p.includes(platformCraftBlock(['linkedin'])), 'LinkedIn craft missing');
    assert.ok(p.includes('LINKEDIN — only the first two lines') && !p.includes('INSTAGRAM — only about the first 125 characters'));
});

check('Social chat: every platform when none is configured; before Inspo and the JSON contract', () => {
    const p = ROUTES.social_media_manager.buildRolePrompt(rc());
    for (const x of ['INSTAGRAM —', 'LINKEDIN —', 'FACEBOOK —', 'X — one idea', 'THREADS —']) assert.ok(p.includes(x), x);
    before(p, 'PLATFORM CRAFT —', 'INSPO-MARKER');
    before(p, 'PLATFORM CRAFT —', 'Return STRICT JSON');
});

check('Email Marketing chat: email craft, signed off as the business (never an invented name)', () => {
    const p = ROUTES.newsletter_editor.buildRolePrompt(rc({}, 'Juniper & Co'));
    assert.ok(p.includes(emailCraftBlock('Juniper & Co')) && p.includes('"— The Juniper & Co team"'));
    before(p, 'EMAIL CRAFT —', 'INSPO-MARKER');
    before(p, 'EMAIL CRAFT —', 'Return STRICT JSON');
});

check('Blog chat: blog craft for what it writes itself (block edits, titles, briefs)', () => {
    const p = ROUTES.blog_writer.buildRolePrompt(rc());
    assert.ok(p.includes(BLOG_CRAFT) && p.includes('Whenever you write or change any part of an article here'));
    before(p, 'BLOG CRAFT —', 'INSPO-MARKER');
    before(p, 'BLOG CRAFT —', 'Return STRICT JSON');
});

check('Chat capabilities: the three craft gaps are closed', () => {
    for (const r of ['social_media_manager', 'newsletter_editor', 'blog_writer'])
        assert.ok(!chatGapsFor(r, 'live').some((g) => g.key === 'craft_not_in_chat'), `${r} still has a craft gap`);
});

console.log(`\n${passed} passed`);
