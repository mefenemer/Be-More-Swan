// tests/qr-link.test.ts
// A QR code for a link the USER chooses, starting from a suggestion (owner 2026-11-11), in the Website
// Assistant and the Brand Designer: the suggestion order, the link check, the drawing, the design editor's QR
// layer, the chat cards, and the wiring.
//
// Run:  npx tsx tests/qr-link.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanQrUrl, drawQr, pickQrSuggestion } from '../src/utils/qr-link';
import { withQrLink } from '../src/utils/design-options';
import { designEditFromUiElement, DESIGN_EDIT_TYPE, type Design } from '../src/utils/design-doc';

let passed = 0;
let total = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
    total++;
    const done = (ok: boolean, err?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; } };
    try { const r = fn(); if (r instanceof Promise) pending.push(r.then(() => done(true), (e) => done(false, e))); else done(true); }
    catch (err) { done(false, err); }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

check('the suggestion: their offer\'s link, else the booking link, else the website', () => {
    const all = { offer: 'https://lovecat.co.uk/free-trial', booking: 'https://lovecat.bemoreswan.site/book', website: 'lovecat.co.uk' };
    assert.deepStrictEqual(pickQrSuggestion(all), { url: 'https://lovecat.co.uk/free-trial', source: 'offer', label: 'your introductory offer\'s link' });
    assert.strictEqual(pickQrSuggestion({ ...all, offer: null })!.source, 'booking');
    assert.deepStrictEqual(pickQrSuggestion({ website: 'lovecat.co.uk' }), { url: 'https://lovecat.co.uk/', source: 'website', label: 'your website' });
    assert.strictEqual(pickQrSuggestion({ offer: 'not a link', booking: null, website: '' }), null);
});

check('any link they type: http(s), a real host; a bare address gets https://', () => {
    assert.strictEqual(cleanQrUrl('yourshop.co.uk/menu'), 'https://yourshop.co.uk/menu');
    assert.strictEqual(cleanQrUrl('http://yourshop.co.uk'), 'http://yourshop.co.uk/');
    for (const bad of ['javascript:alert(1)', 'mailto:a@b.com', 'localhost', '', null, 42]) assert.strictEqual(cleanQrUrl(bad), null, String(bad));
});

check('drawn on the server as SVG (print) and PNG (a picture), black on white', async () => {
    const qr = await drawQr('yourshop.co.uk/offer');
    assert.ok(qr);
    assert.strictEqual(qr!.url, 'https://yourshop.co.uk/offer');
    assert.ok(qr!.svg.startsWith('<svg') && qr!.svg.includes('#000000'));
    assert.ok(qr!.png.startsWith('data:image/png;base64,'));
    assert.strictEqual(await drawQr('not a link'), null);
});

const DESIGN = { kind: 'image', pageW: 1080, pageH: 1080, pageColor: '#ffffff', photo: null, layers: [], removed: { layers: [], photo: null } } as unknown as Design;

check('design editor: a design without a QR code gets one, remembering its link', async () => {
    const r = await withQrLink(DESIGN, 'yourshop.co.uk');
    assert.ok(r.ok);
    if (!r.ok) return;
    const qr = r.design.layers.find((l) => l.kind === 'qr') as { url?: string; src: string };
    assert.ok(qr && qr.url === 'https://yourshop.co.uk/' && qr.src.startsWith('data:image/png'));
});

check('design editor: the QR code on the page is redrawn where it is; one on the shelf comes back', async () => {
    const onPage = { ...DESIGN, layers: [{ id: 'qr', kind: 'qr', role: 'qr', x: 0.1, y: 0.2, w: 0.2, h: 0.2, src: 'data:old', url: 'https://old.example/' }] } as unknown as Design;
    const a = await withQrLink(onPage, 'https://new.example/offer');
    assert.ok(a.ok);
    if (a.ok) {
        const l = a.design.layers[0] as { x: number; url?: string; src: string };
        assert.ok(l.x === 0.1 && l.url === 'https://new.example/offer' && l.src !== 'data:old', 'same place, new link');
        assert.strictEqual(a.design.layers.length, 1);
    }
    const shelved = { ...DESIGN, removed: { layers: [{ id: 'qr', kind: 'qr', role: 'qr', x: 0.5, y: 0.5, w: 0.2, h: 0.2, src: 'data:old' }], photo: null } } as unknown as Design;
    const b = await withQrLink(shelved, 'https://new.example/');
    assert.ok(b.ok);
    if (b.ok) {
        assert.strictEqual(b.design.layers.length, 1);
        assert.strictEqual(b.design.removed!.layers.length, 0, 'off the shelf');
        assert.strictEqual((b.design.layers[0] as { x: number }).x, 0.5);
    }
    const bad = await withQrLink(DESIGN, 'javascript:alert(1)');
    assert.strictEqual(bad.ok, false);
});

check('chat: a design_edit card carries qrUrl (a link, or "suggested")', () => {
    const c = designEditFromUiElement({ type: DESIGN_EDIT_TYPE, briefId: 3, optionId: 9, qrUrl: ' suggested ' });
    assert.strictEqual(c?.qrUrl, 'suggested');
    const d = designEditFromUiElement({ type: DESIGN_EDIT_TYPE, briefId: 3, optionId: 9, qrUrl: 'https://x.co/y' });
    assert.strictEqual(d?.qrUrl, 'https://x.co/y');
    const opts = read('src/utils/design-options.ts');
    assert.ok(opts.includes("/^suggested$/i.test(args.card.qrUrl) ? (await suggestedQrLink(db, args.orgId))?.url"));
});

check('wiring: endpoint, Website tab, design editor, flyers, chat cards and prompts', () => {
    const fn = read('netlify/functions/qr-code.ts');
    assert.ok(fn.includes('requireTenant(event, db)'), 'signed-in workspaces only');
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes('function qrBlock()') && editor.includes('data-site-qr-url') && editor.includes("fetch('/.netlify/functions/qr-code'"));
    assert.ok(editor.includes('Use ${esc(q.defaultLabel)} again'), 'back to the suggested link');
    assert.ok(read('netlify/functions/sites.ts').includes("await suggestedQrLink(db, orgId, 'booking')"), 'booking link first on the Website tab');
    const studio = read('src/components/design-studio.js');
    assert.ok(studio.includes('data-ds-qr') && studio.includes('pictureFromLibrary({ qrUrl: url.trim() })'));
    assert.ok(read('netlify/functions/brand-briefs.ts').includes('qrSuggestion: await suggestedQrLink(db, orgId)'));
    const flyer = read('src/utils/flyer-words.ts');
    assert.ok(flyer.indexOf('bookingUrl') > -1 && flyer.includes('offerUrl || prevQr?.url || bookingUrl || cleanQrUrl(website)'), 'flyers suggest the booking link before the website');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('qr_code', renderQrCodeCard);"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('{"type":"qr_code","summary":"<one sentence>","url":"<the link they gave, or \\"suggested\\">"}'));
    assert.ok(orch.includes('"qrUrl": "<the link the QR code opens'));
});

Promise.all(pending).then(() => console.log(`\n${passed}/${total} passed`));
