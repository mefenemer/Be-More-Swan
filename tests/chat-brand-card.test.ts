// tests/chat-brand-card.test.ts
// The chat route's branded-text-card seam.
//
// PROD report: a user asked their social assistant for the wording of a colour-block image to
// attach to the caption it had just written. It replied that it does not generate visuals, that
// asking them to pick brand colours during setup had been "misleading" because it cannot use them,
// and that "a visual asset tool or designer" elsewhere in the workspace would be the one to do it.
//
// All of it was untrue. Branded text cards are exactly that image — src/lib/brand-card.ts renders
// one line of type in the org's own brand kit — the colours are what it is drawn in, there is no
// other tool or designer, and the SCHEDULED drafter had been asking the model for a `cardHeadline`
// and attaching a card to every post all along. Only the chat path skipped media, so the model had
// nothing telling it otherwise and improvised.
//
// Two things must therefore stay true, and they are what this file locks:
//   1. a chat draft from an assistant with brand_card enabled comes out WITH a card attached, and
//   2. the role prompt states that plainly, so the model never has to guess again.
//
// Run:  npx tsx tests/chat-brand-card.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalizeMediaSources } from '../src/utils/media-sources';
import { landmark } from './landmark';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const chat = read('../netlify/functions/chat-orchestrator.ts');
const registry = read('../src/components/disruptive-ui-registry.js');
const onboarding = read('../onboarding-social-media.html');

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── The user's own journey: Visual Strategy → media sources → the chat gate ───
// The complaint begins in onboarding, so the test does too. Every wizard branch that promises
// typography must produce a list the chat gate recognises, or the setup answer is decorative again.

check('the "Branded Text Cards" visual strategy reaches the chat gate', () => {
    // Verbatim from the wizard's mapping (onboarding-social-media.html).
    assert.ok(onboarding.includes("if (v.includes('Branded Text Cards')) return ['brand_card', 'stock', 'manual'];"),
        'the wizard no longer maps Branded Text Cards onto brand_card — update this test WITH the gate');
    assert.ok(normalizeMediaSources(['brand_card', 'stock', 'manual']).includes('brand_card'));
});

check('the default matrix also gets cards, and the photo/AI answers do not', () => {
    // A user who never touched the setting still gets typography — DEFAULT_ORDER includes it.
    assert.ok(normalizeMediaSources(null).includes('brand_card'));
    assert.ok(normalizeMediaSources(['manual', 'stock', 'brand_card', 'ai']).includes('brand_card'));
    // Someone who explicitly asked for photographs must NOT start getting text cards in chat.
    assert.equal(normalizeMediaSources(['stock', 'manual']).includes('brand_card'), false);
    assert.equal(normalizeMediaSources(['ai', 'stock', 'manual']).includes('brand_card'), false);
    assert.equal(normalizeMediaSources(['manual']).includes('brand_card'), false);
});

// ── The wiring ────────────────────────────────────────────────────────────────

check('the assistant\'s media sources are read on the chat turn', () => {
    assert.ok(chat.includes('mediaSources: aiAssistants.mediaSources'),
        'chat-orchestrator no longer selects mediaSources — the card gate cannot be evaluated');
});

check('the card is gated on brand_card, not attached unconditionally', () => {
    assert.ok(/normalizeMediaSources\(mediaSources\)\.includes\('brand_card'\)/.test(chat),
        'the brand_card gate is gone — a stock/AI assistant would start emitting text cards');
});

check('the model\'s cardHeadline is parsed off the draft and passed to the renderer', () => {
    assert.ok(/cardHeadline/.test(chat));
    assert.ok(/headline: draft\.cardHeadline/.test(chat),
        'the headline the model wrote is no longer what the card is drawn with');
    assert.ok(chat.includes('headlineFromCaption(captionForHeadline)'),
        'a draft with no cardHeadline must still fall back to the caption, as the scheduled drafter does');
    // The RAW caption, never the one written to the post: the disclosure footer belongs on the
    // post, not set as display type across a brand card.
    assert.ok(chat.includes('captionForHeadline: draft.caption'),
        'the headline fallback must read the raw caption, not captionWithFooter');
});

check('the shared card is shaped for the platform that requires an image', () => {
    // Instagram cannot publish without one and crops to 4:5. A 16:9 card — X's ratio, and easily
    // first in the platforms array — reaches Instagram as a letterboxed strip.
    assert.ok(/posts\.find\(p => platformFormat\(p\.platform\)\.mediaMandatory\)/.test(chat),
        'the group\'s card ratio is back to "whichever platform was listed first"');
});

check('the card is attached to EVERY row in the cross-post group', () => {
    // One picture per post, not per platform tab: the review editor collapses a crosspost_group_id
    // into a single card, so a picture on one row and not the others publishes three bare posts.
    assert.ok(/for \(const postId of postIds\)/.test(chat), 'the junction rows are no longer written per post');
    assert.ok(/inArray\(scheduledPosts\.id, postIds\)/.test(chat), 'contentAssetIds is no longer synced across the group');
});

check('attaching a card clears the Instagram media-missing flag', () => {
    // The flag exists because chat had no picture to attach. With one attached it is simply false,
    // and leaving it set would send the user to the Review Queue to fix a post that is complete.
    assert.ok(/mediaMissing: false/.test(chat), 'a post that now HAS a picture would still be flagged as missing one');
    assert.ok(/postFormat: 'image'/.test(chat), 'a post with a picture must not stay postFormat text');
});

check('a failed card costs the picture and nothing else', () => {
    // The draft is saved and linked before the card is attempted. If that order inverts, a render
    // failure takes the user's post with it — strictly worse than the bug being fixed.
    const persistIdx = chat.indexOf('.returning({ id: scheduledPosts.id })');
    const cardIdx = landmark(chat, 'attachBrandCardToDrafts(db, {');
    assert.ok(persistIdx > 0 && cardIdx > persistIdx, 'the card is now rendered before the post is saved');
    assert.ok(/catch \(cardErr\)/.test(chat), 'the card render is no longer wrapped in its own guard');
});

check('the card renders in the STORED kit — no website extraction inside the turn', () => {
    // resolveBrandKitForOrg derives a kit from the org's website when none is stored: an 8s page
    // fetch, a 5s stylesheet fetch and an LLM call to choose the accent. Right in the background
    // drafter, ruinous in a turn the user is waiting on — it can eat the budget and take the reply
    // with it. The daily drafter stays the thing that fills an empty kit in.
    assert.ok(chat.includes('normalizeBrandKit(org?.brandKit)'),
        'the chat card no longer reads the stored kit directly');
    assert.equal(/resolveBrandKitForOrg\(/.test(chat), false,
        'a website extraction can now run inside a chat turn — it can cost the whole function budget');
});

check('brand-card is loaded on demand, never at module scope', () => {
    // It pulls in satori, the resvg native binding and ~250KB of base64 fonts at import time. Chat
    // is the most latency-sensitive endpoint in the app and most turns make no card at all.
    assert.ok(/await Promise\.all\(\[\s*import\('\.\.\/\.\.\/src\/lib\/brand-card'\)/.test(chat)
        || /import\('\.\.\/\.\.\/src\/lib\/brand-card'\)/.test(chat),
        'the dynamic import of brand-card is gone');
    assert.equal(/^import .*from '\.\.\/\.\.\/src\/lib\/(brand-card|media-persist|brand-extract-fetch)'/m.test(chat), false,
        'brand-card and friends are now STATIC imports — every chat turn pays their cold start');
});

check('drafting into an open post makes no card', () => {
    // Nothing is persisted on that path, so there is no post to attach one to and no promise to make.
    assert.ok(chat.includes('That button carries the CAPTION only, so no branded card is made here'),
        'the draft-target override no longer rules out a card');
});

// ── What the assistant is allowed to say ──────────────────────────────────────

check('the role prompt states the card capability', () => {
    assert.ok(chat.includes('BRAND CARDS — you CAN give this business a picture'),
        'the social role prompt no longer tells the model it can produce a picture');
    assert.ok(/colour-block image/.test(chat), 'the user\'s own words for the thing are gone from the prompt');
});

check('the three false statements from the incident are ruled out explicitly', () => {
    for (const rule of [
        'Never say you cannot make visuals',
        'never call the brand colours unused or pointless',
        'never suggest that some other tool, designer or assistant handles it',
    ]) {
        assert.ok(chat.includes(rule), `the prompt no longer forbids: ${rule}`);
    }
});

check('the no-cards case is also answered, rather than left to improvisation', () => {
    // The silence is what caused the incident. An assistant configured for photographs must still
    // have a true sentence to say, or it will invent one the way this one did.
    assert.ok(chat.includes('PICTURES — you write words, not images'),
        'an assistant without brand_card has nothing truthful to say about pictures again');
    assert.ok(/never invent another tool, designer or assistant/.test(chat));
});

// ── What the user sees back ───────────────────────────────────────────────────

check('the chat card shows the wording, but only when a card was really made', () => {
    assert.ok(registry.includes('On the branded card'), 'the drafted headline is invisible in the chat again');
    assert.ok(/ui\.forPostId == null && typeof ui\.cardHeadline === 'string'/.test(registry),
        'the headline would now show on the draft-into-open-post path, where no card exists');
});

console.log(`\n${passed} checks passed.`);
