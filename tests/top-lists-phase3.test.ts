// tests/top-lists-phase3.test.ts
// Top lists Phase 3 (docs/top-lists-plan.md §3, §6): the Email "Top 5" layout, the Video countdown, and
// the Mentor's list suggestion with its Take Me There into Blog Studio. What could quietly regress:
//   · a "Top 5" subject or a countdown hook keeping the model's wrong count
//   · a numbered list offered for a terms notice or an outage email (newsletters only)
//   · a templated issue's draft failing because the model sent only a layout
//   · a countdown whose on-screen numbers don't run down to #1, or one built over own footage
//   · the Mentor nagging a workspace that already publishes lists, or pointing at a page that isn't there
//
// Run:  npx tsx tests/top-lists-phase3.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    countHeadingItems, countdownNumber, isListPiece, isListSearchTerm,
    TOP_LIST_TEMPLATE, TOP_LIST_EMAIL_BRIEF, COUNTDOWN_VIDEO_BRIEF, TOP_LIST_RULES,
} from '../src/utils/top-lists';
import { NEWSLETTER_TEMPLATES, templateAllowsPurpose, designFromTemplate } from '../src/config/newsletter-templates';
import { NEWSLETTER_PURPOSE_KEYS } from '../src/config/newsletter-purposes';
import { designToMarkdown } from '../src/utils/newsletter-design';
import { isTopListIssue } from '../src/utils/newsletter-generate';
import { newsletterDraftFromUiElement } from '../src/utils/newsletter-chat-draft';
import { fixCountdown, enforceStoryboard, storyboardUserPrompt, type Scene, type VideoBrief } from '../src/lib/storyboard';
import { readBrief } from '../src/utils/video-producer';
import { contentFindings } from '../src/utils/mentor-content-checks';
import { buildTakeMeThereCard, TAKE_ME_THERE_PLACES } from '../src/config/take-me-there';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { process.exitCode = 1; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

// ── Email "Top 5" ───────────────────────────────────────────────────────────────────────────────

check('email items are numbered level-2 or level-3 headings, counted as one run from 1', () => {
    assert.strictEqual(countHeadingItems('Hi\n\n### 1. One\ntext\n### 2. Two\n### 3) Three'), 3);
    assert.strictEqual(countHeadingItems('## 1. One\n## 2. Two'), 2);
    assert.strictEqual(countHeadingItems('# 1. Title only\n#### 1. too deep'), 0);
    assert.strictEqual(countHeadingItems('### 2024 in review\n### Looking ahead'), 0, 'a year is not item 1');
});

check('the "Top 5" template exists, is newsletters only, and its own headings count as 5', () => {
    const t = NEWSLETTER_TEMPLATES.find((x) => x.key === TOP_LIST_TEMPLATE)!;
    assert.ok(t, 'top_list template');
    assert.deepStrictEqual([...(t.purposes ?? [])], ['newsletter']);
    for (const p of NEWSLETTER_PURPOSE_KEYS) assert.strictEqual(templateAllowsPurpose(TOP_LIST_TEMPLATE, p), p === 'newsletter', p);
    assert.ok(templateAllowsPurpose('classic', 'incident'), 'unlimited templates stay open to every purpose');
    assert.strictEqual(countHeadingItems(designToMarkdown(designFromTemplate(TOP_LIST_TEMPLATE))), 5);
});

check('server: purposes ride along to the dialog, and a Top 5 is refused for other purposes', () => {
    const fn = read('netlify/functions/newsletter-issues.ts');
    assert.match(fn, /\.\.\.\(t\.purposes \? \{ purposes: t\.purposes \} : \{\}\)/);
    assert.match(fn, /if \(body\.template && !templateAllowsPurpose\(body\.template, purpose\)\)/);
    assert.match(fn, /body\.mode !== 'convert' && body\.template && !templateAllowsPurpose\(body\.template, purposeOrDefault\(issue\.purpose\)\)/);
    assert.match(fn, /shape: body\.shape === 'list' \? 'list' : undefined/);
    const ui = read('newsletter.js');
    assert.match(ui, /state\.templates\.filter\(\(t\) => templateFits\(t\.key, newIssueChoice\.purpose\)\)/);
    assert.match(ui, /state\.templates\.filter\(\(t\) => templateFits\(t\.key, purpose\)\)/, 'the "start from a template" picker too');
});

check('a draft is a Top 5 when asked or started from the layout — and only ever for a newsletter', () => {
    assert.strictEqual(isTopListIssue('newsletter', { template: TOP_LIST_TEMPLATE }), true);
    assert.strictEqual(isTopListIssue('newsletter', null, 'list'), true);
    assert.strictEqual(isTopListIssue('newsletter', { template: 'classic' }), false);
    assert.strictEqual(isTopListIssue('incident', { template: TOP_LIST_TEMPLATE }), false);
    assert.strictEqual(isTopListIssue('policy_change', null, 'list'), false);
});

check('drafter: the Top 5 brief after the purpose, the subject count fixed from the items written', () => {
    const gen = read('src/utils/newsletter-generate.ts');
    const body = gen.slice(gen.indexOf('export async function generateIssueBody'), gen.indexOf('// ── Making an existing draft better'));
    assert.match(body, /\(purposeBlock \? `\\n\\n\$\{purposeBlock\}` : ''\) \+\s*\n\s*\/\/[^\n]*\n\s*\(topList \? `\\n\\n\$\{TOP_LIST_EMAIL_BRIEF\}` : ''\)/);
    assert.match(body, /const listCount = topList \? countHeadingItems\(bodyText\) : 0;/);
    assert.match(body, /fixListCount\(subjectRaw\.text, listCount\)/);
    assert.ok(TOP_LIST_EMAIL_BRIEF.includes(TOP_LIST_RULES), 'the list rules travel with the brief');
});

check('drafter: a templated issue whose reply is only a layout still gets its words (no failed draft)', () => {
    const gen = read('src/utils/newsletter-generate.ts');
    const body = gen.slice(gen.indexOf('export async function generateIssueBody'), gen.indexOf('// ── Making an existing draft better'));
    assert.match(body, /\|\| \(issue\.design \? layoutAsProse\(parsed\?\.layout\) : ''\);/);
    assert.match(gen, /function layoutAsProse\(raw: unknown\): string \{/);
});

check('chat Top 5: the card\'s subject count is made to match the headings written', () => {
    const d = newsletterDraftFromUiElement({
        type: 'newsletter_issue_draft', subject: '5 walks to try this spring', preheader: '',
        bodyMarkdown: 'Hi there,\n\nFour favourites.\n\n### 1. Ridge path\nGo early.\n\n### 2. River loop\nFlat.\n\n### 3. Woods\nShady.\n\n### 4. Coast\nWindy.\n\nSee you out there.',
    })!;
    assert.strictEqual(d.subject, '4 walks to try this spring');
    const plain = newsletterDraftFromUiElement({ type: 'newsletter_issue_draft', subject: 'Our 3 big news items', bodyMarkdown: 'Hi,\n\n## News\nThings.' })!;
    assert.strictEqual(plain.subject, 'Our 3 big news items', 'a non-list email is left alone');
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /TOP 5 EMAILS\. When they ask for a list email/);
});

// ── Video countdown ─────────────────────────────────────────────────────────────────────────────

const scene = (beat: Scene['beat'], voiceover: string, onScreenText?: string): Scene =>
    ({ id: 'x', beat, voiceover, source: 'stock_video', targetS: 5, ...(onScreenText ? { onScreenText } : {}) });

check('countdown numbers run down to #1, labels kept; the hook says the real count', () => {
    const changes: string[] = [];
    const out = fixCountdown([
        scene('hook', 'Five things every new runner gets wrong.', 'Top 5 mistakes'),
        scene('value', 'Buying shoes by looks.', '1. Shoes'),
        scene('value', 'Starting too fast.', 'Too fast'),
        scene('value', 'Skipping rest days.', '#3 Rest'),
        scene('cta', 'Book a gait check.'),
    ], changes);
    assert.deepStrictEqual(out.slice(1, -1).map((s) => s.onScreenText), ['#3 Shoes', '#2 Too fast', '#1 Rest']);
    assert.strictEqual(out[0].voiceover, 'Three things every new runner gets wrong.');
    assert.strictEqual(out[0].onScreenText, 'Top 3 mistakes');
    assert.ok(changes.some((c) => /hook now says 3/.test(c)));
    assert.strictEqual(out[4].onScreenText, undefined, 'the call to action is not numbered');
});

check('a countdown with too few items is said, never padded', () => {
    const changes: string[] = [];
    const out = fixCountdown([scene('hook', '2 tips.'), scene('value', 'One.'), scene('value', 'Two.'), scene('cta', 'Call us.')], changes);
    assert.strictEqual(out.length, 4);
    assert.ok(changes.some((c) => /at least 3 items/.test(c)));
});

const BRIEF: VideoBrief = { purpose: 'tip', lengthS: 30, message: 'Three mistakes new runners make', voiceover: true, allowAi: 'stock_only', countdown: true };

check('enforceStoryboard applies the countdown and fixes the title\'s count', () => {
    const { storyboard } = enforceStoryboard({
        title: 'Top 5 runner mistakes',
        scenes: [
            { beat: 'hook', voiceover: 'Five mistakes.' }, { beat: 'value', voiceover: 'a' }, { beat: 'value', voiceover: 'b' },
            { beat: 'value', voiceover: 'c' }, { beat: 'cta', voiceover: 'Book now.' },
        ],
    }, BRIEF);
    assert.strictEqual(storyboard.title, 'Top 3 runner mistakes');
    assert.strictEqual(storyboard.scenes[1].onScreenText, '#3');
    assert.strictEqual(storyboard.scenes[0].voiceover, 'Three mistakes.');
    const plain = enforceStoryboard({ title: 'Top 5 tips', scenes: [{ beat: 'hook', voiceover: 'Hi' }, { beat: 'value', voiceover: 'x' }, { beat: 'cta', voiceover: 'y' }] }, { ...BRIEF, countdown: false });
    assert.strictEqual(plain.storyboard.title, 'Top 5 tips', 'no countdown, no rewrite');
});

check('the planner is told the countdown shape, never for own footage', () => {
    const base = { businessName: 'B', businessFacts: '', library: [], today: '2026-11-17' };
    assert.ok(storyboardUserPrompt({ ...base, brief: BRIEF }).includes(COUNTDOWN_VIDEO_BRIEF));
    assert.ok(!storyboardUserPrompt({ ...base, brief: { ...BRIEF, countdown: false } }).includes('COUNTDOWN VIDEO'));
    assert.ok(!storyboardUserPrompt({ ...base, brief: { ...BRIEF, footageAssetIds: [7] } }).includes('COUNTDOWN VIDEO'));
});

check('readBrief keeps countdown for a made-up video and drops it for own footage', () => {
    const a = readBrief({ message: 'Three mistakes new runners make', countdown: true });
    assert.ok('brief' in a && a.brief.countdown === true);
    const b = readBrief({ message: 'Three mistakes new runners make', countdown: true, footageAssetIds: [5] });
    assert.ok('brief' in b && !b.brief.countdown);
    const c = readBrief({ message: 'Three mistakes new runners make', countdown: 'yes' });
    assert.ok('brief' in c && !c.brief.countdown, 'only a real true');
});

check('countdown is offered on the brief form, in chat and on the card', () => {
    const vids = read('src/components/assistant-videos.js');
    assert.match(vids, /<input type="checkbox" name="countdown"/);
    assert.match(vids, /\.\.\.\(fd\.get\('countdown'\) \? \{ countdown: true \} : \{\}\)/);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /"countdown": true\s+\/\/ only for a countdown/);
    assert.match(orch, /set "countdown": true — the storyboard then says how many are coming/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /\.\.\.\(ui\.countdown === true \? \{ countdown: true \} : \{\}\)/);
    assert.match(reg, /row\('Shape of the story', 'Countdown/);
    assert.strictEqual(countdownNumber('#3 Book early'), 3);
    assert.strictEqual(countdownNumber('No. 2 Ask'), 2);
    assert.strictEqual(countdownNumber('Book early'), null);
});

// ── Mentor ──────────────────────────────────────────────────────────────────────────────────────

const NONE = { ctas: [], offer: null, goals: [], services: [] };
const writer = [{ id: 9, name: 'Bella' }];

check('Mentor suggests a list only on a 30-day gap, with the best reason, pointing at Blog Studio', () => {
    const term = contentFindings({ ...NONE, lists: { blogWriters: writer, listedRecently: false, productCount: 12, listTerms: ['best wedding venues leeds'] } });
    assert.strictEqual(term.length, 1);
    assert.match(term[0].text, /last 30 days has been a list\. People search "best wedding venues leeds"/);
    assert.strictEqual(term[0].where, 'Bella\'s Blog Studio (Type of article: Top list)');
    const products = contentFindings({ ...NONE, lists: { blogWriters: writer, listedRecently: false, productCount: 12, listTerms: [] } });
    assert.match(products[0].text, /12 products and services, so a "Top 7"/);
    assert.strictEqual(contentFindings({ ...NONE, lists: { blogWriters: writer, listedRecently: true, productCount: 12, listTerms: [] } }).length, 0, 'already publishing lists');
    assert.strictEqual(contentFindings({ ...NONE, lists: { blogWriters: [], listedRecently: false, productCount: 12, listTerms: [] } }).length, 0, 'no Blog Writer to write it');
    assert.strictEqual(contentFindings(NONE).length, 0, 'older callers without `lists`');
});

check('what counts as a list piece, and a list-shaped search', () => {
    assert.ok(isListPiece('## 1. Book early\ntext\n## 2. Ask\n## 3. Pay'));
    assert.ok(isListPiece('Three tips:\n1. One.\n2. Two.\n3. Three.'));
    assert.ok(!isListPiece('## Why we started\n## What is next'));
    assert.ok(isListSearchTerm('best coffee in york') && isListSearchTerm('gift ideas for dad'));
    assert.ok(!isListSearchTerm('coffee shop york'));
    const load = read('src/utils/mentor-content-checks.ts');
    assert.match(load, /eq\(blogPosts\.status, 'published'\), gte\(blogPosts\.publishedAt, since\)/);
    assert.match(load, /eq\(scheduledPosts\.status, 'published'\), gte\(scheduledPosts\.publishedAt, since\)/);
    assert.match(load, /t\.roleKey === 'blog_writer'/);
});

check('Take Me There "blog_top_list" opens that Blog Writer\'s Blog Studio with Top list chosen', () => {
    assert.ok(TAKE_ME_THERE_PLACES.blog_top_list);
    const card = buildTakeMeThereCard({ place: 'blog_top_list', assistantId: 9, summary: 'Start one' }, [{ id: 9, name: 'Bella' }]);
    assert.ok(!('error' in card));
    if (!('error' in card)) {
        assert.strictEqual(card.studio, 'top_list');
        assert.strictEqual(card.assistantId, 9);
        assert.match(card.label, /^Bella's Blog Studio, with "Top list" chosen/);
    }
    assert.ok('error' in buildTakeMeThereCard({ place: 'blog_top_list' }, [{ id: 9, name: 'Bella' }]), 'needs a real assistant');
    const plain = buildTakeMeThereCard({ place: 'calendar' }, []);
    assert.ok(!('error' in plain) && plain.studio === null);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /ui\.studio === 'top_list' && ui\.assistantId && typeof window\.openBlogStudio === 'function'/);
    assert.match(reg, /window\.openBlogStudio\(\{ assistantId: ui\.assistantId, articleType: 'list' \}\)/);
    const bs = read('src/components/blog-studio-modal.js');
    assert.match(bs, /state\.presetArticleType = typeof opts\.articleType === 'string'/);
    assert.match(bs, /el\('bs-ai-type'\)\.value = preset;/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
