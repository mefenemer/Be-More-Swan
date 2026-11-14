// tests/site-card-pictures.test.ts — FR#18 (owner 2026-11-14): the Website Assistant sees which picture sits on
// each card of a features / steps section, and a site_picture card can change ONE card's picture.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as store from '../src/utils/site-store';
import { normaliseSitePictureCard } from '../src/utils/site-picture-card';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    console.log('site-card-pictures');

    await check('the site snapshot lists each card with its number and picture', () => {
        const line = (store as any).cardPicturesLine;
        assert.strictEqual(typeof line, 'function', 'cardPicturesLine exists');
        const out = line([{ title: 'Fast', body: '', image: { assetId: 45, url: 'u', alt: 'A van' } }, { title: 'Local', body: '' }, { body: '' }]);
        assert.strictEqual(out, ' · cards (itemIndex, title, picture): card 0 "Fast" (picture #45 "A van"); card 1 "Local" (no picture); card 2 (no title) (no picture)');
        const s = read('src/utils/site-store.ts');
        assert.ok(s.includes("s.type === 'features' || s.type === 'steps' ? cardPicturesLine(pr.items) : ''"), 'used for features and steps');
    });

    await check('the site_picture card keeps a card number, and two cards of one section are two pickers', () => {
        const c = normaliseSitePictureCard({ type: 'site_picture', pageId: 'p', sectionId: 's', itemIndex: 1, sections: [{ pageId: 'p', sectionId: 's', itemIndex: 2 }, { pageId: 'p', sectionId: 's', itemIndex: 1 }] }) as any;
        assert.strictEqual(c.itemIndex, 1);
        assert.deepStrictEqual(c.sections.map((x: any) => x.itemIndex), [1, 2]);
        const bad = normaliseSitePictureCard({ type: 'site_picture', pageId: 'p', sectionId: 's', itemIndex: -1 }) as any;
        assert.ok(!('itemIndex' in bad), 'nonsense index dropped');
    });

    await check('placing a picture on card 1 changes only card 1 (and refuses a video)', async () => {
        const js = read('src/components/chat-session.js');
        const a = js.indexOf('    async function onSitePicturePlace(e) {');
        const fn = js.slice(a, js.indexOf('\n    }\n', a) + 6);
        const calls: any[] = [];
        const def = { pages: [{ id: 'p', sections: [{ id: 's', type: 'features', props: { items: [{ title: 'A', body: '', image: { assetId: 1, url: 'x', alt: 'one' } }, { title: 'B', body: '' }] } }] }] };
        const c: any = { assistantId: 7, siteChanged: () => {}, sitePost: async (b: any) => { calls.push(b); return b.action === 'get' ? { definition: def } : { warnings: [] }; } };
        vm.createContext(c);
        vm.runInContext(`${fn}; this.f = onSitePicturePlace;`, c);
        let res: any;
        await c.f({ detail: { pageId: 'p', sectionId: 's', place: 'in', itemIndex: 1, assetId: 99, alt: 'new', video: false, respond: (r: any) => { res = r; } } });
        assert.ok(res.ok, JSON.stringify(res));
        const op = calls.find((x) => x.action === 'apply').ops[0];
        assert.strictEqual(op.op, 'update_section');
        assert.strictEqual(JSON.stringify(op.props.items[0]), JSON.stringify(def.pages[0].sections[0].props.items[0]), 'card 0 untouched');
        assert.strictEqual(JSON.stringify(op.props.items[1]), JSON.stringify({ title: 'B', body: '', image: { assetId: 99, url: '', alt: 'new' } }));
        await c.f({ detail: { pageId: 'p', sectionId: 's', itemIndex: 0, assetId: 5, video: true, respond: (r: any) => { res = r; } } });
        assert.ok(!res.ok && /picture, not a video/.test(res.error));
        await c.f({ detail: { pageId: 'p', sectionId: 's', itemIndex: 9, assetId: 5, respond: (r: any) => { res = r; } } });
        assert.ok(!res.ok && /card isn't in the section/.test(res.error));
    });

    await check('the card passes its card number on, and the prompt explains itemIndex', () => {
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes('detail: { pageId, sectionId, place, itemIndex, assetId, alt, video'));
        const o = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(o.includes('add "itemIndex": N to that section\'s entry'));
    });

    console.log(`\n${passed} passed`);
})();
