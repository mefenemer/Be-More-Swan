// tests/repro-issue-66.test.ts
// Fix pipeline #66 (prod, owner report, 2026-11-16): "When trying to connect to Google Search Console from the
// Blog Set-up tab, it navigates me to the integrations page which is not correct. It should navigate me to the
// connections tab in the side bar."
// Blog setup's Connect (#bs-gsc-connect, blog-studio-modal.js) sent the browser straight into
// oauth-integrations?provider=searchconsole&action=connect with NO assistantId, so every outcome
// (not_configured, a decline, a token failure) came back to /integrations.html and a success to /blog-studio.html.
// Search Console's row lives on the assistant's Connections tab (integrations.js _searchConsoleCard).
//
// Runs the REAL click handler out of blog-studio-modal.js with stubs, in both places it can be pressed.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(__dirname, '..');
const modal = readFileSync(join(root, 'src/components/blog-studio-modal.js'), 'utf8');
const assistants = readFileSync(join(root, 'assistants.js'), 'utf8');

/** The body of the function passed to el('bs-gsc-connect').addEventListener('click', function () { … }). */
function handlerBody(): string {
    const head = "el('bs-gsc-connect').addEventListener('click', function () {";
    const start = modal.indexOf(head);
    assert.ok(start !== -1, 'the Blog setup Connect handler exists');
    let i = start + head.length - 1, depth = 0;
    for (; i < modal.length; i++) {
        if (modal[i] === '{') depth++;
        else if (modal[i] === '}' && --depth === 0) return modal.slice(start + head.length, i);
    }
    throw new Error('unbalanced handler');
}

function press(opts: { stateAid: number | null; pageAid: number | null; drawer: boolean; inTab: boolean }) {
    const opened: string[] = [];
    let closed = false;
    const ctx: any = {
        state: { assistantId: opts.stateAid },
        setupTab: { host: opts.inTab ? {} : null },
        closeBlogStudio() { closed = true; },
        window: {
            _currentAssistantId: opts.pageAid,
            _openBriefDrawer: opts.drawer ? (k: string) => opened.push(k) : undefined,
            location: { href: '' },
        },
        encodeURIComponent,
    };
    vm.createContext(ctx);
    vm.runInContext(`(function () {${handlerBody()}})()`, ctx);
    return { opened, closed, href: ctx.window.location.href as string };
}

// 1. The Blog setup TAB on the Blog assistant's own page: open its Connections tab in the side menu.
const tab = press({ stateAid: 14, pageAid: 14, drawer: true, inTab: true });
assert.deepStrictEqual(tab.opened, ['platforms'], 'opens Assistant Settings ▸ Connections');
assert.strictEqual(tab.href, '', 'does not leave the page for the integrations flow');
assert.strictEqual(tab.closed, false, 'the tab is not a modal to close');

// 2. The Blog setup MODAL opened over the same assistant's page: it steps aside, Connections opens.
const modalOver = press({ stateAid: 14, pageAid: 14, drawer: true, inTab: false });
assert.deepStrictEqual(modalOver.opened, ['platforms']);
assert.strictEqual(modalOver.closed, true);

// 3. Anywhere without that assistant's page (standalone Blog Studio, the Calendar): the connect carries the
//    assistant, so the callback returns to /workspace.html?…&assistantId=14 (its Connections tab).
const elsewhere = press({ stateAid: 14, pageAid: null, drawer: false, inTab: false });
assert.deepStrictEqual(elsewhere.opened, []);
assert.ok(elsewhere.href.includes('provider=searchconsole&action=connect'), 'still starts the connect');
assert.ok(elsewhere.href.includes('&assistantId=14'), 'with the assistant, so it comes back to it');

// 4. The KPI cards' "Connect Google Search Console" link carries the assistant too.
const kpi = assistants.slice(assistants.indexOf("cta.className = 'kpi-gsc-cta") - 600, assistants.indexOf("cta.className = 'kpi-gsc-cta"));
assert.ok(/provider=searchconsole&action=connect'\s*\+\s*\(window\._currentAssistantId/.test(kpi), 'KPI connect link adds assistantId');

console.log('repro-issue-66: Blog setup Connect goes to the assistant’s Connections tab ✓');
