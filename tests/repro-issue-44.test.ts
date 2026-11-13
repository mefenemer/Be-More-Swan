// tests/repro-issue-44.test.ts
// Issue #44 (noticed by the Business Mentor, workspace 40, 2026-11-12 10:27): the owner asked why "What your
// business offers" stayed unticked on the Set-up checklist. The Mentor sent them to "Business Information ▸
// Business Profile" to find a text field; the question is the tick boxes at the top of Business Information
// ▸ Products & Services, and it apologised two minutes later. Its prompt (businessGaps → the checklist's
// gap line) said only "(Business Information)", so the model guessed the tab. It also didn't know the boxes
// can LOOK ticked while unsaved: an unanswered workspace is shown our guess, pre-ticked (issue #46).
// The gap line now names the tab and says what an unsaved guess looks like and how to save it.
import assert from 'node:assert';
import { businessGaps, setupChecklist, type MentorSnapshotData } from '../src/utils/mentor-snapshot';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const data = (over: Partial<MentorSnapshotData> = {}): MentorSnapshotData => ({
    business: { description: 'Coaching for women leaving nursing', industry: 'Coaching', website: 'https://example.test' },
    products: [{ name: 'Discovery call', hasPrice: true }], productCount: 3, offerKinds: [], introOfferAnswered: false, introOfferHas: false,
    team: [], goals: [], plan: { status: 'active', freeSlots: null }, ...over,
} as MentorSnapshotData);

check('the unanswered offer question tells the Mentor WHERE it is: Products & Services, not Business Profile', () => {
    const gap = businessGaps(data()).find((g) => /What does your business offer/.test(g));
    assert.ok(gap, 'the gap is raised');
    assert.match(gap!, /Business Information ▸ Products & Services/);
    assert.match(gap!, /tick boxes/);
});

check('it knows ticked-looking boxes can be an unsaved guess, and how the owner saves it', () => {
    const gap = setupChecklist(data()).find((i) => i.key === 'offer')!.gap;
    assert.match(gap, /guess/);
    assert.match(gap, /That's right, save it/);
});

check('the intro offer question names its tab too', () => {
    const gap = setupChecklist(data()).find((i) => i.key === 'intro_offer')!.gap;
    assert.match(gap, /Business Information ▸ Products & Services/);
});

check('an answered offer raises no gap', () => {
    assert.ok(!businessGaps(data({ offerKinds: ['services'] })).some((g) => /What does your business offer/.test(g)));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}.`);
