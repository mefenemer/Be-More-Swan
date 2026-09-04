// tests/blog-destinations-panel-copy.test.ts
// Blog Studio's "Where this post gets published" panel makes two claims that are load-bearing and
// unverifiable by eye. Both were wrong, and both cost real time before this file existed.
//
//   1. WHEN. Nothing on that panel is sent on save, on schedule, or on approval — syndication runs
//      inside publishBlogPost and nowhere else. The panel described the mechanic and never the
//      timing, so a SCHEDULED post displayed every destination ticked and read as though
//      distribution had already been arranged. It had not, and would not be until the post
//      published. That misread is what sent an author hunting for two scheduled posts in a review
//      queue that nothing had submitted them to.
//
//   2. WHO RELEASES IT. The Swan Index is the first-party destination and it fell through to the
//      generic draft line, "sent as a draft for you to release over there". The author cannot
//      release it: the piece is submitted to the magazine's EDITORS as `pending` and appears when
//      one of them approves it (src/utils/blog-destinations/swanindex.ts). A destination note that
//      hands the author a job only an editor can do is worse than no note.
//
// The panel copy is built by two pure functions, so this file calls them for real rather than
// scanning for phrases. Wording may change freely; the CLAIMS may not.
//
// Run:  npx tsx tests/blog-destinations-panel-copy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// The modal is a browser IIFE; nothing at load time needs a real DOM.
const sandbox: any = {
    window: {},
    document: {
        addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [],
        createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, appendChild() {} }),
    },
    fetch: () => {}, setTimeout, console, navigator: {},
};
createContext(sandbox);
runInContext(read('src/components/blog-studio-modal.js'), sandbox);

type Dest = { social?: boolean; firstParty?: boolean; publishMode?: string };
const copy: {
    distributionTiming: (post: unknown) => string;
    destinationNote: (d: Dest) => string;
} = sandbox.window._blogStudioCopy;

check('the panel still exposes its copy helpers', () => {
    assert.ok(copy && typeof copy.distributionTiming === 'function' && typeof copy.destinationNote === 'function',
        'window._blogStudioCopy is gone — every check below is vacuous without it.');
});

const inSixDays = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();

// ── 1. Timing ────────────────────────────────────────────────────────────────
check('a SCHEDULED post says nothing has been sent yet', () => {
    const line = copy.distributionTiming({ status: 'scheduled', publishDate: inSixDays });
    assert.ok(/nothing has been sent/i.test(line),
        `A scheduled post must say plainly that nothing has gone anywhere yet. Got:\n  ${line}`);
    assert.ok(/publishes/i.test(line),
        `It must name publication as the trigger. Got:\n  ${line}`);
});

check('a scheduled post names its own publish date', () => {
    const line = copy.distributionTiming({ status: 'scheduled', publishDate: inSixDays });
    const day = new Date(inSixDays).toLocaleString('en-GB', { day: 'numeric' });
    assert.ok(line.includes(day),
        `"when it publishes" alone leaves the author to go and look. Got:\n  ${line}`);
});

check('a DRAFT with no date still says it, without inventing one', () => {
    const line = copy.distributionTiming({ status: 'draft', publishDate: null });
    assert.ok(/nothing has been sent/i.test(line), `Got:\n  ${line}`);
    assert.ok(!/\bon\s/.test(line.replace(/anywhere/g, '')),
        `A post with no publish date must not be given a date. Got:\n  ${line}`);
});

check('a past publish_date is not read out as a future promise', () => {
    // A scheduled post whose slot has gone by is waiting on the publish cron. Printing the elapsed
    // date as when it "will" publish would be a confident statement of something already untrue.
    const line = copy.distributionTiming({ status: 'scheduled', publishDate: '2020-01-01T09:00:00.000Z' });
    assert.ok(!/2020/.test(line), `Got:\n  ${line}`);
    assert.ok(/nothing has been sent/i.test(line), `Got:\n  ${line}`);
});

check('a PUBLISHED post speaks in the past tense and names the real button', () => {
    const line = copy.distributionTiming({ status: 'published', publishDate: inSixDays });
    assert.ok(!/nothing has been sent/i.test(line),
        `A live post has already been sent; saying otherwise is the opposite error. Got:\n  ${line}`);
    // Naming a control that does not exist is how a user ends up hunting a screen for a button.
    const modal = read('src/components/blog-studio-modal.js');
    const quoted = line.match(/[“"]([^”"]+)[”"]/);
    assert.ok(quoted, `The published line should name the re-push control. Got:\n  ${line}`);
    assert.ok(modal.includes('>' + quoted![1] + '<'),
        `The panel points at a button labelled "${quoted![1]}", which is not a label in this file.`);
});

// ── 2. The first-party destination ───────────────────────────────────────────
check('The Swan Index is submitted for review, not handed to the author', () => {
    const note = copy.destinationNote({ firstParty: true, publishMode: 'draft' });
    assert.ok(/review|approve/i.test(note),
        `The first-party note must say the piece goes to editors. Got:\n  ${note}`);
    assert.ok(!/for you to release/i.test(note),
        `The note tells the author to release the piece over there. They cannot — only an editor `
        + `can. Got:\n  ${note}`);
});

check('its note is not the generic draft line', () => {
    const firstParty = copy.destinationNote({ firstParty: true, publishMode: 'draft' });
    const generic = copy.destinationNote({ publishMode: 'draft' });
    assert.notEqual(firstParty, generic,
        'The first-party destination has fallen back to the generic draft note again.');
});

check('a first-party destination set to live says so instead', () => {
    const note = copy.destinationNote({ firstParty: true, publishMode: 'live' });
    assert.ok(!/review|approve/i.test(note),
        `On live mode the piece is not queued for an editor. Got:\n  ${note}`);
});

check('the social and generic notes are unchanged in substance', () => {
    assert.ok(/lead-in/i.test(copy.destinationNote({ social: true })),
        'A social destination gets a lead-in and a link, not the article — the note must still say so.');
    assert.ok(/live/i.test(copy.destinationNote({ publishMode: 'live' })),
        'The live note no longer says the post goes live.');
});

// ── 3. The wiring ────────────────────────────────────────────────────────────
check('the panel actually renders both, into elements that exist', () => {
    const modal = read('src/components/blog-studio-modal.js');
    assert.ok(/id="bs-dist-when"/.test(modal), 'The timing line has no element to render into.');
    assert.ok(/whenEl\.textContent = distributionTiming\(post\)/.test(modal),
        'loadDistribution no longer fills the timing line — the element renders empty.');
    assert.ok(/destinationNote\(d\)/.test(modal),
        'The destination rows no longer call destinationNote.');
});

console.log(`\n${passed} checks passed`);
