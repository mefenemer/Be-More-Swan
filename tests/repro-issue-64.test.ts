// tests/repro-issue-64.test.ts
// Fix pipeline #64 (prod, owner report, 2026-11-16): Marvin (Social Media Manager, org 37, kicked off months ago)
// was system-paused when X's token refresh failed, and the detail page showed the red "Attention required —
// Reconnect X (Twitter)" panel inside the card headed "🚀 Kick Off Meeting" (assistant-detail.html #kickoff-card,
// filled by _renderKickOff in assistants.js). The heading never changed with what the card was showing.
//
// Runs the REAL _renderKickOff out of assistants.js against stub elements and a readiness reply.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(__dirname, '..', 'assistants.js'), 'utf8');
const start = src.indexOf('async function _renderKickOff(');
assert.ok(start !== -1);
let i = src.indexOf('{', start), depth = 0;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
const fnSrc = src.slice(start, i + 1);

function el(id: string) {
    const classes = new Set<string>(['hidden']);
    return {
        id, textContent: id === 'kickoff-icon' ? '🚀' : id === 'kickoff-title' ? 'Kick Off Meeting' : '',
        innerHTML: '', dataset: {} as Record<string, string>, style: {} as Record<string, string>, disabled: false,
        classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
            toggle: (c: string, on?: boolean) => { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); }, contains: (c: string) => classes.has(c) },
        setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [], appendChild() {}, insertAdjacentHTML() {},
    };
}

async function render(readiness: Record<string, unknown>) {
    const els: Record<string, any> = {};
    const ctx: any = {
        document: { getElementById: (id: string) => (els[id] ||= el(id)), querySelector: () => null, querySelectorAll: () => [], createElement: () => el('x') },
        _detailTicket: () => () => false,
        _fetchPrefetched: async () => ({ ok: true, json: async () => readiness }),
        window: {}, console,
    };
    vm.createContext(ctx);
    vm.runInContext(`${fnSrc}\nthis.__run = _renderKickOff;`, ctx);
    try { await ctx.__run(1); } catch { /* the rest of the card needs more page than this stub has; the heading is set first */ }
    return { icon: els['kickoff-icon']?.textContent, title: els['kickoff-title']?.textContent };
}

(async () => {
    // Marvin on prod: system_paused, X refresh failed.
    const paused = await render({ attention: { kind: 'connection', services: ['x'] }, working: false });
    assert.strictEqual(paused.title, 'Needs your attention', 'an attention panel is not headed "Kick Off Meeting"');
    assert.strictEqual(paused.icon, '⚠️');

    // A real kick-off still says so (and the card is reset when the page moves on to another assistant).
    const fresh = await render({ working: false, items: [] });
    assert.strictEqual(fresh.title, 'Kick Off Meeting');
    assert.strictEqual(fresh.icon, '🚀');

    console.log('repro-issue-64: the attention card is not headed Kick Off Meeting ✓');
})().catch((e) => { console.error(e); process.exit(1); });
