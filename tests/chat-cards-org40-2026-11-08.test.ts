// tests/chat-cards-org40-2026-11-08.test.ts
// Four issue reports from one evening's chats (prod 2026-11-07/08, org 40), each a card that never
// reached the user. The inputs are taken from those turns.
//
// Run:  npx tsx tests/chat-cards-org40-2026-11-08.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { splitProseAndCard } from '../src/utils/model-json';
import { missingCardReply, NO_CARD_NOTE } from '../src/utils/confirm-card-reply';
import { applySiteOperation, normaliseSiteDefinition, type SiteOperation } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

console.log('Prose, then a bare card (issue #27)');
check('the card is taken out and the prose kept', () => {
    const raw = 'I\'ve put together a landing page.\n\n- **Questions**, with one gap in [square brackets].\n\nThe card below shows the changes. Nothing changes until you approve it.\n\n{"type":"site_changes","summary":"Adds a page.","ops":[{"op":"add_page","title":"Retirement Coaching","slug":"retirement-coaching"}]}';
    const r = splitProseAndCard(raw);
    assert.ok(r, 'split');
    assert.strictEqual(r!.card.type, 'site_changes');
    assert.ok(r!.prose.endsWith('Nothing changes until you approve it.'));
    assert.ok(!r!.prose.includes('{'));
});
check('a fenced trailing card splits too', () => {
    const r = splitProseAndCard('Here it is.\n\n```json\n{"type":"site_words","pageId":"p1","quote":"all sessions are online"}\n```');
    assert.strictEqual(r?.card.type, 'site_words');
    assert.strictEqual(r?.prose, 'Here it is.');
});
check('plain prose, a whole envelope, and prose after the object are left alone', () => {
    assert.strictEqual(splitProseAndCard('Just words.'), null);
    assert.strictEqual(splitProseAndCard('{"reply":"hi","uiElement":{"type":"x"}}'), null);
    assert.strictEqual(splitProseAndCard('Words {"type":"x"} and more words'), null);
    assert.strictEqual(splitProseAndCard('Words {"kind":"x"}'), null);
});
check('every structured route uses it', () => {
    const src = readFileSync(path.join(process.cwd(), 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    const fn = src.slice(src.indexOf('function parseStructuredReply('), src.indexOf('function parseStructuredReply(') + 2500);
    assert.ok(fn.includes('splitProseAndCard(raw)'));
});

console.log('A reply that points at a card that is not there (issue #26)');
check('"confirm on the card below" with no card gets the note', () => {
    const c = 'I\'ve condensed this pillar into a rule under 300 characters. Nothing is saved until you confirm on the card below.';
    assert.ok(missingCardReply(c, false).endsWith(NO_CARD_NOTE));
    assert.strictEqual(missingCardReply(c, true), c);
});
check('"Here it is now… confirm on it" with no card gets the note', () => {
    const c = 'Sorry, it didn\'t come through last time. Here it is now, and nothing is saved until you confirm on it.';
    assert.ok(missingCardReply(c, false).endsWith(NO_CARD_NOTE));
});
check('the check runs on every route, not only the Mentor', () => {
    const src = readFileSync(path.join(process.cwd(), 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    const at = src.indexOf('const fixed = missingCardReply(content, !!uiElement);');
    assert.ok(at > 0);
    assert.ok(!src.slice(at - 400, at).includes('if (route === ROUTES.business_mentor)'));
});

console.log('The canned picture refusal beside a site_changes card (issue #29)');
check('the Website route points at the card it has instead', () => {
    const src = readFileSync(path.join(process.cwd(), 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    const at = src.indexOf("if (assistantRow.roleKey === 'website_assistant') {\n            const cardType");
    assert.ok(at > 0, 'guard reads the card type');
    assert.ok(src.slice(at, at + 500).includes("cardType !== 'site_picture'"));
});

console.log('A page added in the same card, named by its address (issue #28)');
check('add_page then add_section/update_page by slug lands on the new page', () => {
    const def = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [] }] }).definition;
    const ops: SiteOperation[] = [
        { op: 'add_page', title: 'Retirement Coaching', slug: 'retirement-coaching' },
        { op: 'update_page', pageId: 'retirement-coaching', hideFromMenu: true },
        { op: 'add_section', pageId: 'retirement-coaching', section: { type: 'cta', props: { heading: 'Put yourself at the top of the list', body: 'Start with 90 minutes.', button: { label: 'Book', href: 'mailto:a@b.co' } } } } as unknown as SiteOperation,
    ];
    let d = def;
    for (const op of ops) {
        const r = applySiteOperation(d, op);
        assert.ok(r.ok, r.ok ? '' : (r as { error: string }).error);
        d = (r as { definition: typeof d }).definition;
    }
    const page = d.pages.find((p) => p.slug === 'retirement-coaching')!;
    assert.ok(page.id && page.id !== 'retirement-coaching', 'page has a real id');
    assert.strictEqual(page.hideFromMenu, true);
    assert.strictEqual(page.sections.length, 1);
});
check('a made-up id that is no page and no address is still refused', () => {
    const def = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [] }] }).definition;
    const r = applySiteOperation(def, { op: 'remove_page', pageId: 'nowhere' });
    assert.strictEqual(r.ok, false);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
