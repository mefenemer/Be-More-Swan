// tests/mentor-sees-everything.test.ts
// The Mentor sees every set-up answer IN FULL (owner, 2026-11-02): it refused to add a content pillar for
// Love Cat Studio because it was shown only the first 100 characters, and the card replaces the whole
// answer — so it handed the owner text to copy and paste. Also: answers changed elsewhere are shown
// read-only, and saved Business Information (target audience, brand) is shown, not only the gaps.
//
// Run:  npx tsx tests/mentor-sees-everything.test.ts

import assert from 'node:assert';
import { renderExcludedSetupAnswers, renderSetupFields } from '../src/utils/setup-field';
import { mentorSetupFieldPromptLine } from '../src/utils/chat-setup-field';
import { brandLines, renderMentorSnapshot, type MentorSnapshotData } from '../src/utils/mentor-snapshot';
import { readFileSync } from 'node:fs';
import { TAKE_ME_THERE_PLACES, buildTakeMeThereCard } from '../src/config/take-me-there';
import { mentorCardsPromptBlock } from '../src/utils/mentor-cards';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const pillars = 'Behind the scenes in the studio · Customer stories and the cats we meet · Tips for nervous cats · Our handmade collars and how they are made · Local events in Hove and Brighton · Meet the team';

check('a long answer is shown whole — never cut at 100 characters', () => {
    const lines = renderSetupFields('social_media_manager', { content_pillars: pillars });
    const line = lines.find((l) => l.includes('content_pillars'));
    assert.ok(line, 'content_pillars is listed');
    assert.ok(line!.includes(JSON.stringify(pillars)), 'the whole answer is in the line');
    assert.ok(!line!.includes('…'), 'nothing is elided');
});

check('answers changed elsewhere are shown read-only, with where; blanks are left out', () => {
    const lines = renderExcludedSetupAnswers('social_media_manager', { posting_frequency: '3 per week', cta: '', primary_platforms: ['instagram', 'facebook'] });
    assert.ok(lines.some((l) => l.includes('posting_frequency') && l.includes('read-only here') && l.includes('3 per week')));
    assert.ok(lines.some((l) => l.includes('primary_platforms') && l.includes('instagram')));
    assert.ok(!lines.some((l) => l.includes('cta')), 'a blank answer is not listed');
});

check('the card rule says the value replaces the whole answer, and forbids copy-and-paste hand-offs', () => {
    const p = mentorSetupFieldPromptLine();
    assert.match(p, /REPLACES the whole answer/);
    assert.match(p, /current answer exactly as shown, plus the addition/);
    assert.match(p, /Never hand the user text to copy and paste/);
});

check('saved Business Information is shown, not only what is missing', () => {
    const d: MentorSnapshotData = {
        business: { description: 'Cat grooming', industry: 'Pet care', website: 'https://example.com', targetAudience: 'Owners of nervous cats in Hove',
            brand: brandLines({ primaryColor: '#c2185b', source: 'manual' }, { photoStyle: 'Bright natural light' }) },
        products: [], productCount: 0, offerKinds: null, introOfferAnswered: false, team: [], goals: [], plan: { status: 'active', freeSlots: 1 },
    };
    const out = renderMentorSnapshot(d);
    assert.match(out, /Target audience: Owners of nervous cats in Hove/);
    assert.match(out, /Brand colours: accent #c2185b/);
    assert.match(out, /Picture guidelines — .*Bright natural light/);
});

check('a default brand kit says nothing (it is not theirs)', () => {
    assert.deepStrictEqual(brandLines(null, null), []);
});

check('Take Me There: a known place becomes a card with where to go; an unknown one is refused', () => {
    const c = buildTakeMeThereCard({ place: 'products', summary: 'Your prices live here.' }, []);
    assert.ok(!('error' in c));
    if ('error' in c) return;
    assert.deepStrictEqual([c.view, c.bizTab, c.assistantId], ['assets', 'products', null]);
    assert.ok('error' in buildTakeMeThereCard({ place: 'javascript:alert(1)' }, []));
});

check('Take Me There: an assistant page must name an assistant on this team, and says its name', () => {
    const team = [{ id: 7, name: 'Ava' }];
    const c = buildTakeMeThereCard({ place: 'assistant_what_i_post_about', assistantId: 7 }, team);
    assert.ok(!('error' in c) && c.assistantId === 7 && c.assistantTab === 'strategy' && c.label.startsWith("Ava's"));
    assert.ok('error' in buildTakeMeThereCard({ place: 'assistant_rules', assistantId: 99 }, team));
});

check('Take Me There: every view is a real workspace route, and the Mentor is told about the card', () => {
    const ws = readFileSync('workspace.html', 'utf8');
    const routes = ws.slice(ws.indexOf('const routes = {'), ws.indexOf('};', ws.indexOf('const routes = {')));
    for (const [k, p] of Object.entries(TAKE_ME_THERE_PLACES)) {
        if (p.view) assert.ok(routes.includes(`'${p.view}':`), `${k} → "${p.view}" is not a workspace route`);
    }
    assert.match(mentorCardsPromptBlock(), /"type":"mentor_take_me_there"/);
    const reg = readFileSync('src/components/disruptive-ui-registry.js', 'utf8');
    assert.ok(reg.includes("register('mentor_take_me_there'") && reg.includes('>Take Me There</button>'));
});

console.log(`\n${passed}/${total} passed`);
