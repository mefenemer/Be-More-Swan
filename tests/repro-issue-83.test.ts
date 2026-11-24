// tests/repro-issue-83.test.ts
// Fix pipeline #83 (and #82) (prod, workspace 40, Social Media chat 199, 2026-11-23): "A user editing one
// platform's version of a multi-platform post found the caption change applied to all platforms."
// The user had the LinkedIn version (#5903) of a three-platform post open in the editor with the chat docked
// beside it, asked for a LinkedIn-only ending, and the card came back with forPostId 5903 and platforms
// ["linkedin"] — correct. Pressing "Yes, add it to my draft" ran _pceApplyChatCaption → rqReviewSaveAmend,
// which saves to EVERY post in the group whenever "Apply to all N platforms" is ticked, and that box is
// re-ticked on every render. So the LinkedIn wording landed on Facebook and Instagram too ("you changed it on
// all 3 again!"). #82 is the assistant's own reading of the same moment.
//
// Runs the REAL two functions out of workspace.html against a fake three-post group and counts the PATCHes.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const html = readFileSync(join(__dirname, '..', 'workspace.html'), 'utf8');

/** The source of `async function <name>(…) { … }`, by brace matching from its declaration. */
function fnSource(name: string): string {
    const start = html.indexOf(`async function ${name}(`);
    assert.ok(start !== -1, `${name} is in workspace.html`);
    let i = html.indexOf('{', html.indexOf(')', start));
    let depth = 0;
    for (; i < html.length; i++) {
        const c = html[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

async function run(applyAllTicked: boolean, call: string) {
    const fields: Record<string, { value?: string; checked?: boolean }> = {
        'post-review-caption': { value: 'old caption' },
        'post-review-hashtags': { value: '' },
        'post-review-link-url': { value: '' },
        'post-review-cta': { value: '' },
        'post-review-amend-all-cb': { checked: applyAllTicked },
        'post-review-amend-msg': {},
    };
    const patched: number[] = [];
    const cache: Record<number, any> = {
        5900: { id: 5900, platform: 'instagram', caption: 'old caption' },
        5903: { id: 5903, platform: 'linkedin', caption: 'old caption' },
        5904: { id: 5904, platform: 'facebook', caption: 'old caption' },
    };
    const ctx: any = {
        _rqReviewPostId: 5903,
        _rqReviewGroupIds: [5900, 5903, 5904],
        _rqPostCache: cache,
        document: { getElementById: (id: string) => fields[id] || null },
        _pceEl: (id: string) => fields[id] || null,
        _pceNormaliseLink: (s: string) => s,
        _pceSelect() {}, _pceRefreshLinkMeta() {}, _rqReviewRenderActive() {}, _rqLoadQualityReview() {},
        rqReviewSwitchPlatform(id: number) { ctx._rqReviewPostId = id; },
        window: {},
        async fetch(url: string, init: any) {
            const id = Number(new URL(url, 'https://x').searchParams.get('id'));
            patched.push(id);
            return { ok: true, json: async () => ({ post: { id, caption: JSON.parse(init.body).caption } }) };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(`${fnSource('rqReviewSaveAmend')}\n${fnSource('_pceApplyChatCaption')}\nthis.__go = async () => { ${call} };`, ctx);
    await ctx.__go();
    return { patched: patched.sort(), cache };
}

(async () => {
    // The chat card's caption goes on the ONE post it was written for, even with "Apply to all" ticked.
    const viaChat = await run(true, `await _pceApplyChatCaption({ caption: 'LinkedIn only ending', hashtags: null, forPostId: 5903 })`);
    assert.deepStrictEqual(viaChat.patched, [5903], 'a chat card for LinkedIn saves to LinkedIn only');
    assert.strictEqual(viaChat.cache[5900].caption, 'old caption', 'Instagram untouched');
    assert.strictEqual(viaChat.cache[5904].caption, 'old caption', 'Facebook untouched');
    assert.strictEqual(viaChat.cache[5903].caption, 'LinkedIn only ending');

    // The editor's own Save button keeps its "Apply to all platforms" behaviour.
    const viaSave = await run(true, `await rqReviewSaveAmend()`);
    assert.deepStrictEqual(viaSave.patched, [5900, 5903, 5904], 'Save changes with the box ticked still saves the group');
    const viaSaveOne = await run(false, `await rqReviewSaveAmend()`);
    assert.deepStrictEqual(viaSaveOne.patched, [5903], 'Save changes with the box unticked saves this platform');

    console.log('repro-issue-83: chat card saves to its own platform only ✓');
})().catch((e) => { console.error(e); process.exit(1); });
