// tests/prompt-audit-craft.test.ts
// Prompt audit, 2026-10-24 (owner: "assistants need to be experts in their role", and "assistants can
// only connect with each other if the user has them active"). Graded 18 live drafts for three
// businesses, before and after: invented customers and results, a sign-off from a person who does not
// exist, "You've got this" on most emails, nine hashtags on LinkedIn, a call to action on 3 posts in 4,
// and a named owner given a pronoun nobody stated. These pin the rules that fixed them.
// Run:  npx tsx tests/prompt-audit-craft.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { platformCraftBlock } from '../src/constants/platform-craft';
import { emailCraftBlock } from '../src/constants/email-craft';
import { CONTENT_QUALITY_STANDARDS } from '../src/constants/content-quality';
import { SOCIAL_POST_SHAPES } from '../src/utils/content-shapes';
import { ACTIVE_TEAMMATES_RULE, NO_TEAMMATES_BLOCK } from '../src/utils/team-activity';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('platform craft: one line per platform, twitter is X, unknown platforms add nothing', () => {
    const b = platformCraftBlock(['instagram', 'linkedin', 'twitter', 'x']);
    assert.ok(b.includes('INSTAGRAM —') && b.includes('LINKEDIN —') && b.includes('X —'));
    assert.strictEqual(b.match(/^- X —/gm)?.length, 1, 'twitter and x are the same platform');
    assert.ok(b.includes('At most 3 hashtags'), 'LinkedIn hashtag ceiling');
    assert.strictEqual(platformCraftBlock([]), '');
    assert.strictEqual(platformCraftBlock(['myspace']), '');
});

check('the social prompt carries the platform craft, before the owner\'s own strategy line', () => {
    const src = read('netlify/functions/process-content-jobs.ts');
    const craft = src.indexOf('platformCraftBlock(targetPlatforms),');
    const strategy = src.indexOf('platformStrategyLine,', craft);
    assert.ok(craft > 0 && strategy > craft, 'owner strategy comes after, so it wins');
});

check('email craft: signs off as the business team unless a real name is given, never invents one', () => {
    assert.ok(emailCraftBlock('Juniper & Co').includes('"— The Juniper & Co team"'));
    assert.ok(emailCraftBlock('').includes('the business’s name'));
    for (const s of ["You've got this", "Here's the thing", 'Never invent a name', 'ONE job and ONE ask', 'no invented results or figures'])
        assert.ok(emailCraftBlock('X').includes(s), s);
});

check('both one-off email prompts carry the email craft', () => {
    const src = read('src/utils/newsletter-generate.ts');
    assert.strictEqual(src.match(/emailCraftBlock\(org\?\.name\)/g)?.length, 2, 'newsletter and welcome sequence');
});

check('social standards: no invented stories, links, pronouns, or health/money outcomes', () => {
    for (const s of ['NO INVENTED STORIES, PEOPLE OR TESTIMONIALS', 'NO INVENTED LINKS OR DETAILS',
        'a name does not tell you someone\'s pronouns', 'CAREFUL WITH HEALTH, MONEY AND LEGAL TOPICS', "You've got this"])
        assert.ok(CONTENT_QUALITY_STANDARDS.includes(s), s);
});

check('story and myth shapes cannot be satisfied by inventing a customer or contradicting the business', () => {
    const shape = (k: string) => SOCIAL_POST_SHAPES.find((s) => s.key === k)!.brief;
    assert.ok(shape('story').includes('never an invented customer'));
    assert.ok(shape('myth').includes('never contradict its own advice'));
});

check('the own-words call to action is for some posts, not every post', () => {
    assert.ok(read('netlify/functions/process-content-jobs.ts').includes('not every post — most should simply give'));
});

check('the post reviewer flags a customer moment told as fact, not a hypothetical one', () => {
    const src = read('src/utils/post-quality-review.ts');
    assert.ok(src.includes('A specific customer, client or patient moment'));
    assert.ok(src.includes('("Picture…") is not.'));
});

check('teammates: only active ones, and a lone assistant is told it has none', () => {
    assert.ok(ACTIVE_TEAMMATES_RULE.includes('[paused]'));
    assert.ok(NO_TEAMMATES_BLOCK.startsWith('<team_activity>') && NO_TEAMMATES_BLOCK.includes('the only assistant'));
    // The two prompts that named the Email Marketing Assistant unconditionally now ask for it to be active.
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('with their Email Marketing Assistant ONLY if <team_activity> lists one that is active'));
    assert.ok(read('src/utils/chat-outreach-offer.ts').includes('only if <team_activity> lists one that is active'));
});

console.log(`\n${passed} passed`);
