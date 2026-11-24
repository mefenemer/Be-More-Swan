// tests/repro-issue-77-61.test.ts
// Fix pipeline #77 (owner, 2026-11-17): "Items within the tabs in the Blog Assistant details page should be expandable
// and collapsible." The Blog setup tab's three sections (Keywords, Search performance, Widget) are <details> but were
// forced OPEN every time the tab mounted (blog-studio-modal.js mountBlogSetup: s.open = true). Owner, 2026-11-24: start
// them closed like every other card.
// Fix pipeline #61 (and #78): a structured route's model saw only the PROSE of its own earlier replies, so its history
// read as plain-text answers and it answered "the card below…" in plain text. Owner, 2026-11-24: option A — say in the
// history which card went with each reply. The Mentor already had this (cardOutcomeLine, 2026-10-26); every other
// structured route now gets cardSentLine.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { cardOutcomeLine, cardSentLine } from '../src/utils/mentor-card-outcome';
import { withoutCardPlaceholder } from '../src/utils/confirm-card-reply';

const root = join(__dirname, '..');

// ── #77: the real mountBlogSetup, with stand-ins for the page ────────────────────────────────────
const js = readFileSync(join(root, 'src/components/blog-studio-modal.js'), 'utf8');
const st = js.indexOf('function mountBlogSetup(');
let i = js.indexOf('{', st), d = 0;
for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; }
const mountSrc = js.slice(st, i + 1);
const sec = (name: string) => ({ name, open: true, parentNode: null as unknown });
const sections = { keywords: sec('keywords'), search: sec('search'), widget: sec('widget') };
const home = { insertBefore() {} };
(sections.widget as any).parentNode = home;
const host = { kids: [] as unknown[], appendChild(x: unknown) { this.kids.push(x); } };
const ctx: any = {
    inject() {}, loadWidget() {}, loadSearchConsole() {}, loadKeywordManager() {},
    revealKeywordsIfAsked() { if (ctx.state.openKeywordsSetup) sections.keywords.open = true; },
    state: { assistantId: null, openKeywordsSetup: false },
    setupTab: { host: null, assistantId: null, sections: null, home: null, before: null },
    document: { querySelector: (q: string) => (q.includes('"keywords"') ? sections.keywords : q.includes('"search"') ? sections.search : q.includes('"widget"') ? sections.widget : null) },
};
vm.createContext(ctx);
vm.runInContext(`${mountSrc}\nthis.mount = mountBlogSetup;`, ctx);
ctx.mount(host, 14);
assert.strictEqual(host.kids.length, 3, 'all three sections are in the tab');
assert.deepStrictEqual([sections.keywords.open, sections.search.open, sections.widget.open], [false, false, false], 'they start closed');
// A "Blog setup › Keywords" link still opens its own section.
ctx.state.openKeywordsSetup = true;
ctx.mount(host, 14);
assert.strictEqual(sections.keywords.open, true, 'asked-for section opens');

// ── #61: the history line ─────────────────────────────────────────────────────────────────────────
assert.strictEqual(cardSentLine(null), null);
assert.strictEqual(cardSentLine({ caption: 'no type' }), null);
const line = cardSentLine({ type: 'social_post_draft', summary: 'Ipswich training, sales version' })!;
assert.ok(line.startsWith('[Sent with this reply: a social_post_draft card — "Ipswich training, sales version"'), line);
assert.ok(/uiElement/.test(line) && /never write/.test(line), 'says how a card reaches the user, and that the line is the system\'s');
assert.ok(!/clicked|saved|nothing has changed/.test(line), 'claims nothing about what the user did with it');
// The Mentor keeps its own, outcome-aware line.
assert.ok(cardOutcomeLine({ type: 'mentor_quiet_mode', summary: 'Quiet mode' })!.startsWith('[Card under this reply'));
// A copy of the line written as text is taken out, as a "[Card: …]" line is (#58).
assert.strictEqual(withoutCardPlaceholder('Here it is.\n\n[Sent with this reply: a rule_proposal card — "x"]'), 'Here it is.');

// Wired into every structured route except the Mentor (which has cardOutcomeLine) and the default route.
const orch = readFileSync(join(root, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
assert.ok(orch.includes("route !== defaultRoute && route !== ROUTES.business_mentor && m.role === 'assistant' && cardSentLine(m.uiElementJson)"), 'every other structured route');

console.log('repro-issue-77-61: Blog setup starts closed; earlier cards are named in the history ✓');
