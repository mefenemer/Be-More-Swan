// tests/repro-issue-48.test.ts
// Issue #48 (prod): "Athens timezone missing from Posting Schedule". My Account offers Europe/Athens, but the
// assistant's Posting Schedule timezone list (assistant-detail.html #edit_timezone, painted by
// assistants.js _paintPostingSchedule) was a fixed list of 12 zones, so it could not be chosen.
// Runs the REAL _paintPostingSchedule (lifted from assistants.js) against the page's real <select> options.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const js = readFileSync('assistants.js', 'utf8');
const html = readFileSync('assistant-detail.html', 'utf8');

// The page's own options for #edit_timezone.
const selectHtml = html.slice(html.indexOf('<select id="edit_timezone"'), html.indexOf('</select>', html.indexOf('<select id="edit_timezone"')));
const initial = [...selectHtml.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
assert.ok(initial.length >= 5, 'found the page\'s timezone options');

// A tiny DOM: just enough for _paintPostingSchedule.
type Opt = { value: string; textContent: string };
function makeSelect(values: string[]) {
    const options: Opt[] = values.map((v) => ({ value: v, textContent: v }));
    const sel: any = {
        options, value: values[0],
        appendChild(node: any) {
            if (node.tag === 'optgroup') { for (const o of node.children) options.push(o); } else options.push(node);
            return node;
        },
    };
    return sel;
}
const tzSel = makeSelect(initial);
const doc: any = {
    getElementById: (id: string) => (id === 'edit_timezone' ? tzSel : null),
    createElement: (tag: string) => {
        const node: any = { tag, children: [] as Opt[], value: '', textContent: '', label: '' };
        node.appendChild = (c: Opt) => { node.children.push(c); return c; };
        return node;
    },
};

// Lift the function and the helpers it uses, then run it the way the page does on load.
const grab = (name: string) => {
    const at = js.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is in assistants.js`);
    let depth = 0, i = js.indexOf('{', at);
    for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
    return js.slice(at, i + 1);
};
const helpers = ['_ensureAllTimezones'].filter((n) => js.includes(`function ${n}(`)).map(grab).join('\n');
const run = new Function('document', 'window', `
    const _POSTING_DEFAULT_TZ = 'Europe/London';
    const _POSTING_DEFAULT_DAYS = ['mon','tue','wed','thu','fri'];
    const _POSTING_DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
    function _renderPostingTimes() {}
    ${helpers}
    ${grab('_paintPostingSchedule')}
    return _paintPostingSchedule;
`)(doc, {});
run({ posting_timezone: null, posting_days: null, posting_times: [] }, { draftHorizonDays: 7 });

const values = tzSel.options.map((o: Opt) => o.value);
assert.ok(values.includes('Europe/Athens'), 'Europe/Athens can be chosen in the Posting Schedule');
assert.ok(values.includes('Asia/Tokyo') && values.includes('America/Sao_Paulo'), 'every timezone is offered, not just Athens');
assert.strictEqual(new Set(values).size, values.length, 'no timezone listed twice');
assert.strictEqual(values[0], 'Europe/London', 'the common zones stay at the top');
assert.strictEqual(tzSel.value, 'Europe/London', 'with nothing saved it still starts on the default');
console.log('repro-issue-48: passed');
