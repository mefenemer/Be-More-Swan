// The Brand Designer's editor (owner, 2026-11-05): the design on the left, the chat on the right, drag and change
// anything on it, full screen, and approve from it. The tab's real modules on a bare page, with every function stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560"><rect width="400" height="560" fill="#8a9a8f"/></svg>')}`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-briefs"><div id="briefs-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/generated/platform-constants.js"></script><script src="/src/components/font-picker.js"></script><script src="/src/components/brand-style-dialog.js"></script>
  <script src="/src/components/design-studio.js"></script><script src="/src/components/assistant-briefs.js"></script>
  <script>window.MediaPicker = { open(o) { window.__picker = o; o.onPick({ id: 501, url: 'x', name: 'mine.jpg', video: false }); } };</script>
  <script>AssistantBriefs.init({ assistantId: 4, assistantName: 'Mira' }); setTimeout(() => AssistantBriefs.activate(), 50);</script>
</body></html>`;

const design = () => ({
    v: 1, kind: 'flyer', pageW: 148, pageH: 210, paperSize: 'A5', pageColor: '#f2aa00', photo: null,
    layers: [
        { id: 'headline', kind: 'text', role: 'headline', text: 'Launch party', x: 0.1, y: 0.3, w: 0.8, fontFamily: null, fontSizePct: 0.06, bold: true, align: 'left', color: '#14243a', boxFill: null, boxOpacity: 1 },
        { id: 'contact', kind: 'text', role: 'contact', text: '01632 960418', x: 0.1, y: 0.9, w: 0.5, fontFamily: null, fontSizePct: 0.015, bold: false, align: 'left', color: '#14243a', boxFill: null, boxOpacity: 1 },
    ],
});

function stubBriefs(api: ApiStub) {
    const store = {
        saves: [] as Array<{ design: ReturnType<typeof design>; finish?: boolean }>,
        decided: [] as unknown[],
        applied: [] as unknown[],
        design: design(),
        brief: {
            id: 12, assistantId: 4, title: 'Launch party flyer', purpose: 'flyer', status: 'options_ready', aspectRatio: null, message: 'Our launch', headline: null, mood: 'Calm and natural',
            mustInclude: null, mustAvoid: null, sources: [], rounds: 1, maxRounds: 5, picturesNeeded: 1, picturesApproved: 0, dueDate: null,
            options: [{ id: 77, round: 1, source: 'flyer', status: 'proposed', url: PICTURE, width: 400, height: 560, mimeType: 'image/png', prompt: null, flyer: { layout: 'type_only', paperSize: 'A5', lowResPhoto: false, photoDpi: null } }],
        } as Record<string, unknown>,
    };
    api.set('brand-briefs', (_route, body) => {
        const b = (body || {}) as Record<string, unknown>;
        if (b.action === 'list') {
            return { briefs: [store.brief], vocab: { purposes: [], sources: [], aspectRatios: [], rejectReasons: [{ key: 'style', label: 'Wrong style' }], maxRounds: 5, flyer: null }, credits: 10, unit: 'tasks', aiAvailable: true, defaultSources: ['stock'], guidelines: null };
        }
        if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
        if (b.action === 'save_design') {
            store.saves.push({ design: JSON.parse(JSON.stringify(b.design)), finish: b.finish as boolean });
            store.design = b.design as ReturnType<typeof design>;
            // As the server does: it alone adds or swaps a picture, and says where to show it.
            if (b.addPicture) {
                store.design = { ...store.design, layers: [...store.design.layers, { id: 'p1', kind: 'picture', role: 'picture', x: 0.25, y: 0.5, w: 0.5, h: 0.3, opacity: 1, ref: { storageKey: 'k' } } as never] };
                return { ok: true, design: store.design, photoUrl: null, pictureUrls: { p1: PICTURE }, addedId: 'p1' };
            }
            return { ok: true, design: store.design, photoUrl: null };
        }
        if (b.action === 'apply_design_edit') {
            store.applied.push(b.card);
            store.design = { ...store.design, pageColor: '#ffe4e1' };
            return { ok: true, optionId: 77, design: store.design, photoUrl: null };
        }
        if (b.action === 'decide') {
            store.decided.push(b);
            store.brief = { ...store.brief, status: 'complete', options: [{ ...(store.brief.options as Record<string, unknown>[])[0], status: 'approved' }] };
            return { ok: true };
        }
        return { ok: true };
    });
    return store;
}

// Briefs start closed (owner, 2026-11-06); these tests are about what is inside one.
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('bms-briefs-open-4')) localStorage.setItem('bms-briefs-open-4', '[12,13]'); });
});

async function openStudio(page: Page) {
    await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-studio.html');
    // The tab opens on "Not started" (owner 2026-11-05); a brief with options waiting is under "To review".
    await page.locator('[data-brief-tab="review"]').click();
    await page.locator('[data-brief-open-studio="77"]').click();
    await expect(page.locator('[data-design-studio]')).toBeVisible();
    await expect(layer(page, 'headline')).toBeVisible();
}
const layer = (page: Page, id: string) => page.locator(`[data-ds-page] [data-ds-id="${id}"]`);
const lastSave = (store: ReturnType<typeof stubBriefs>) => store.saves[store.saves.length - 1]?.design;
const headline = (d: ReturnType<typeof design> | undefined) => d?.layers.find((l) => l.id === 'headline');

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('"Open in editor" shows the design on the left and the chat on the right', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openStudio(page);
        const pageBox = await page.locator('[data-ds-page]').boundingBox();
        const chat = await page.locator('#briefs-chat-host [data-chat-input]').boundingBox();
        expect(pageBox && chat).toBeTruthy();
        expect(pageBox!.x + pageBox!.width).toBeLessThanOrEqual(chat!.x);
        await expect(layer(page, 'headline')).toContainText('Launch party');
        await page.screenshot({ path: 'test-results/design-studio.png' });
        expect(pageErrors).toEqual([]);
    });

    test('drag the headline, give it a see-through background, then undo — each saved', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        // The page is sized to the window once it has drawn: measure after it settles.
        await layer(page, 'headline').hover();
        let box: { x: number; y: number; width: number; height: number } | null = null;
        await expect.poll(async () => (box = await layer(page, 'headline').boundingBox()) !== null).toBe(true);
        box = box!;
        await page.mouse.move(box.x + 20, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 20, box.y + box.height / 2 + 120, { steps: 6 });
        await page.mouse.up();
        await expect.poll(() => headline(lastSave(store))?.y ?? 0, { timeout: 10000 }).toBeGreaterThan(0.35);

        await page.locator('[data-ds-tools] [data-ds-boxon]').check();
        await page.locator('[data-ds-tools] [data-ds-boxop]').fill('40');
        // The slider says how see-through it is: 40% see-through is 0.6 strength.
        await expect.poll(() => headline(lastSave(store))?.boxOpacity, { timeout: 10000 }).toBe(0.6);
        // Dark words get a white box, not one in the page's own yellow, which would not show.
        expect(headline(lastSave(store))?.boxFill).toBe('#ffffff');
        await page.screenshot({ path: 'test-results/design-studio-edited.png' });

        await page.locator('[data-ds-undo]').click();
        await page.locator('[data-ds-undo]').click();
        await page.locator('[data-ds-undo]').click();
        await expect.poll(() => headline(lastSave(store))?.y, { timeout: 10000 }).toBe(0.3);
        expect(pageErrors).toEqual([]);
    });

    test('any words: changed in the Words box, from the list, or by double-clicking them, and the design stays still', async ({ page, api, pageErrors }) => {
        // Owner 2026-11-06: "no UI option to change the words". The column is narrow enough here for the tools to wrap.
        const store = stubBriefs(api);
        await page.setViewportSize({ width: 1000, height: 950 });
        await openStudio(page);
        const stage = page.locator('[data-ds-page]');
        await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeGreaterThan(100);
        const before = (await stage.boundingBox())!;
        await layer(page, 'headline').click();
        await expect(page.locator('[data-ds-text]')).toHaveValue('Launch party');
        const after = (await stage.boundingBox())!;
        expect(after.y, 'selecting words must not push the design down').toBe(before.y);
        expect(after.width).toBe(before.width);

        await page.locator('[data-ds-text]').fill('Opening night');
        await expect(layer(page, 'headline')).toContainText('Opening night');
        await expect.poll(() => headline(lastSave(store))?.text, { timeout: 10000 }).toBe('Opening night');

        // Backspace in the box deletes letters, not the layer.
        await page.locator('[data-ds-text]').press('End');
        await page.locator('[data-ds-text]').press('Backspace');
        await expect(layer(page, 'headline')).toContainText('Opening nigh');

        // Clicking away finishes the box; one Undo takes back all that typing.
        await page.locator('[data-ds-wrap]').click({ position: { x: 3, y: 3 } });
        await stage.click({ position: { x: 3, y: 3 } });
        await expect(page.locator('[data-ds-add]')).toBeVisible();
        await page.locator('[data-ds-undo]').click();
        await expect(layer(page, 'headline')).toContainText('Launch party');

        // With nothing selected, every piece of text is listed, the contact details too.
        await page.locator('[data-ds-words="contact"]').click();
        await expect(page.locator('[data-ds-text]')).toHaveValue('01632 960418');
        await expect(page.locator('[data-ds-text]')).toBeFocused();
        await page.locator('[data-ds-text]').fill('01632 960000');
        await expect(layer(page, 'contact')).toContainText('01632 960000');

        // A double-click from nothing selected opens the words on the design for typing.
        await stage.click({ position: { x: 3, y: 3 } });
        await layer(page, 'headline').dblclick();
        await expect(page.locator('[data-ds-page] [contenteditable]')).toHaveCount(1);
        await page.keyboard.type(' tonight');
        await page.locator('[data-ds-page] [contenteditable]').press('Escape');
        await expect(layer(page, 'headline')).toContainText('Launch party tonight');
        await expect.poll(() => headline(lastSave(store))?.text, { timeout: 10000 }).toBe('Launch party tonight');
        await expect(page.locator('[data-ds-text]')).toHaveValue('Launch party tonight');
        await page.screenshot({ path: 'test-results/design-studio-words.png' });
        expect(pageErrors).toEqual([]);
    });

    test('page colour transparency fades the page towards white, is saved, and undoes', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        const stage = page.locator('[data-ds-page]');
        await expect(stage).toHaveCSS('background-color', 'rgb(242, 170, 0)');
        await page.locator('[data-ds-page-op]').fill('50');
        await expect(stage).toHaveCSS('background-color', 'rgb(249, 213, 128)');
        await expect.poll(() => (lastSave(store) as { pageOpacity?: number } | undefined)?.pageOpacity, { timeout: 10000 }).toBe(0.5);
        await page.screenshot({ path: 'test-results/design-studio-page-transparency.png' });
        await page.locator('[data-ds-undo]').click();
        await expect(stage).toHaveCSS('background-color', 'rgb(242, 170, 0)');
        expect(pageErrors).toEqual([]);
    });

    test('moving the words\' Transparency slider with no background turns the background on', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await layer(page, 'headline').click();
        await expect(page.locator('[data-ds-boxop]')).toBeEnabled();
        await page.locator('[data-ds-boxop]').fill('30');
        await expect(page.locator('[data-ds-boxon]')).toBeChecked();
        await expect(layer(page, 'headline')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.7)');
        await expect.poll(() => headline(lastSave(store))?.boxOpacity, { timeout: 10000 }).toBe(0.7);
        expect(pageErrors).toEqual([]);
    });

    test('add a picture from the library, crop it, duplicate it, order it, delete it and put it back', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-add-picture]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await expect(layer(page, 'p1').locator('img')).toHaveJSProperty('complete', true);
        // Crop: zoom, then drag the picture inside its frame. The frame stays where it is.
        const frame = (await layer(page, 'p1').boundingBox())!;
        await page.locator('[data-ds-crop]').click();
        await page.locator('[data-ds-crop-zoom]').fill('300');
        await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
        await page.mouse.down();
        await page.mouse.move(frame.x + frame.width / 2 + 40, frame.y + frame.height / 2 + 30, { steps: 4 });
        await page.mouse.up();
        await page.locator('[data-ds-crop-done]').click();
        const p1 = () => (lastSave(store) as unknown as { layers: Array<Record<string, any>> } | undefined)?.layers.find((l) => l.id === 'p1');
        await expect.poll(() => p1()?.crop?.zoom, { timeout: 10000 }).toBe(3);
        expect(p1()?.crop?.x).toBeLessThan(0.5);
        expect(p1()?.x).toBe(0.25);
        await page.screenshot({ path: 'test-results/design-studio-picture.png' });

        // Duplicate names what it copies, because a browser can never name a file.
        await page.locator('[data-ds-duplicate]').click();
        const ids = () => page.locator('[data-ds-page] [data-ds-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.dsId));
        await expect.poll(async () => (await ids()).length).toBe(4);
        const copy = (await ids())[3];
        const saved = () => (lastSave(store) as unknown as { layers: Array<Record<string, any>> } | undefined)?.layers.find((l) => l.id === copy);
        await expect.poll(() => saved()?.copyOf, { timeout: 10000 }).toBe('p1');

        // Layer order moves it in the stack.
        await page.locator('[data-ds-order]').selectOption('back');
        await expect.poll(async () => (await ids())[0]).toBe(copy);
        await page.locator('[data-ds-order]').selectOption('front');
        await expect.poll(async () => (await ids()).at(-1)).toBe(copy);

        // Deleted: it can be put back.
        await page.locator('[data-ds-delete]').click();
        await expect(layer(page, copy as string)).toHaveCount(0);
        await page.locator(`[data-ds-putback="${copy}"]`).click();
        await expect(layer(page, copy as string)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('add shapes, and words can be italic, underlined and spaced', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-add-shape]').selectOption('circle');
        const shape = page.locator('[data-ds-page] [data-kind="shape"]');
        await expect(shape).toHaveCSS('border-radius', '50%');
        const made = (await shape.boundingBox())!;
        expect(Math.abs(made.width - made.height), 'a circle is round on the page').toBeLessThan(2);
        await page.locator('[data-ds-shapeop]').fill('50');
        await expect(shape).toHaveCSS('opacity', '0.5');
        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-add-shape]').selectOption('line');
        await expect(shape).toHaveCount(2);

        await layer(page, 'headline').click({ position: { x: 5, y: 5 } });
        await page.locator('[data-ds-italic]').click();
        await page.locator('[data-ds-underline]').click();
        await page.locator('[data-ds-lh]').fill('2');
        await page.locator('[data-ds-lh]').press('Tab');
        await expect(layer(page, 'headline')).toHaveCSS('font-style', 'italic');
        await expect(layer(page, 'headline')).toHaveCSS('text-decoration-line', 'underline');
        await expect.poll(() => (headline(lastSave(store)) as Record<string, unknown> | undefined)?.lineHeight, { timeout: 10000 }).toBe(2);
        await page.screenshot({ path: 'test-results/design-studio-shapes.png' });
        expect(pageErrors).toEqual([]);
    });

    test('dragging snaps to the middle of the page and shows a guide; Alt turns it off', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-add-shape]').selectOption('rectangle');
        const shape = page.locator('[data-ds-page] [data-kind="shape"]');
        const b = (await shape.boundingBox())!;
        // The rectangle is 0.2 tall, so its centre is 0.5 when its top is 0.4. It starts there: move away, then come back near.
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 40, cy + 40, { steps: 3 });
        await page.mouse.move(cx + 3, cy + 40, { steps: 2 });
        await expect(page.locator('.ds-guide[data-axis="x"]')).toHaveCount(1);
        await page.screenshot({ path: 'test-results/design-studio-guides.png' });
        await page.mouse.up();
        await expect(page.locator('.ds-guide')).toHaveCount(0);
        const shapeSave = () => (lastSave(store) as unknown as { layers: Array<Record<string, number & string>> } | undefined)?.layers.find((l) => l.kind === 'shape' as never);
        await expect.poll(() => Math.round((shapeSave()?.x ?? 0) * 1000) / 1000, { timeout: 10000 }).toBe(0.3);

        const again = (await shape.boundingBox())!;
        await page.keyboard.down('Alt');
        await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
        await page.mouse.down();
        await page.mouse.move(again.x + again.width / 2 + 2, again.y + again.height / 2 + 2, { steps: 2 });
        await page.mouse.move(again.x + again.width / 2 + 4, again.y + again.height / 2 + 2, { steps: 2 });
        await expect(page.locator('.ds-guide')).toHaveCount(0);
        await page.mouse.up();
        await page.keyboard.up('Alt');
        expect(pageErrors).toEqual([]);
    });

    test('the real picture window opens over the editor, in full screen too', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        const real = PAGE.replace(/<script>window\.MediaPicker = [^\n]*<\/script>/, '<script src="/src/components/media-picker.js"></script>');
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: real }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="review"]').click();
        await page.locator('[data-brief-open-studio="77"]').click();
        await expect(layer(page, 'headline')).toBeVisible();
        await page.locator('button[data-ds-full]').click();
        // A click on the design or a tool stays in full screen.
        await layer(page, 'headline').click();
        await page.locator('[data-ds-italic]').click();
        await expect(page.locator('.chatpane-dock[data-ds-full]')).toHaveCount(1);
        await page.locator('[data-ds-wrap]').click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-add-picture]').click();
        await expect(page.getByText('Add a picture', { exact: true })).toBeVisible();
        const onTop = await page.getByText('Add a picture', { exact: true }).evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
        });
        expect(onTop).toBe(true);
        await page.screenshot({ path: 'test-results/design-studio-picker.png' });
        expect(pageErrors).toEqual([]);
    });

    test('a removed logo or QR code offers itself back, and comes back', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.design = { ...store.design, removed: { layers: [{ id: 'qr', kind: 'qr', role: 'qr', x: 0.7, y: 0.8, w: 0.2, h: 0.14, src: PICTURE }], photo: null } } as never;
        await openStudio(page);
        await page.locator('[data-ds-putback="qr"]').click();
        await expect(layer(page, 'qr')).toBeVisible();
        await expect(page.locator('[data-ds-delete]')).toBeVisible();
        await page.locator('[data-ds-delete]').click();
        await expect(page.locator('[data-ds-putback="qr"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('full screen covers the page, and Esc leaves it', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-full]').first().click();
        const dock = page.locator('.chatpane-dock[data-ds-full]');
        await expect(dock).toHaveCount(1);
        const b = (await dock.boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(1580);
        await page.mouse.move(5, 900);
        const exit = page.locator('[data-ds-full].ds-btn');
        await expect(exit).toHaveText('Exit full screen');
        // Pressed reads as on: dark, with white words (owner saw it look disabled mid-fade in a screenshot).
        await expect.poll(() => exit.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(31, 41, 55)');
        await expect(exit).toHaveCSS('color', 'rgb(255, 255, 255)');
        await page.screenshot({ path: 'test-results/design-studio-full.png' });
        await page.keyboard.press('Escape');
        await expect(dock).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('a "Change this design" card from the chat changes the open design', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'Here is a softer page.', uiElement: {
            type: 'design_edit', briefId: 12, optionId: 77, summary: 'A soft pink page.', pageColor: '#ffe4e1', changes: [],
        } } });
        await openStudio(page);
        const input = page.locator('#briefs-chat-host [data-chat-input]');
        await input.fill('Make the page soft pink');
        await input.press('Enter');
        await page.getByRole('button', { name: 'Change it' }).click();
        await expect(page.getByText('Done. Undo in the editor takes it back.')).toBeVisible();
        expect(store.applied).toHaveLength(1);
        await expect.poll(() => page.locator('[data-ds-page]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 228, 225)');
        expect(pageErrors).toEqual([]);
    });

    test('"Use this design" saves, approves and goes to Approved', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-approve]').click();
        await expect.poll(() => store.decided.length, { timeout: 10000 }).toBe(1);
        expect(store.decided[0]).toMatchObject({ action: 'decide', optionId: 77, decision: 'approve' });
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        await expect(page.locator('[data-brief-tab="approved"]')).toHaveAttribute('aria-selected', 'true');
        expect(pageErrors).toEqual([]);
    });
});

test.describe('the questions go straight to the editor', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('a design_started reply opens the editor on the new brief, with no card to confirm', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'A calm A5 flyer suits a launch evening.', uiElement: {
            type: 'design_started', briefId: 12, title: 'Launch party flyer', note: null,
        } } });
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        const input = page.locator('#briefs-chat-host [data-chat-input]');
        await input.fill('My answers:\nWhat do you need it for?: A printed flyer or poster');
        await input.press('Enter');
        await expect(page.locator('[data-design-studio]')).toBeVisible();
        await expect(page.getByText('Save flyer')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('a video clip goes to its brief, not to an editor with nothing to edit', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.brief = { ...store.brief, purpose: 'social', status: 'generating', sources: ['stock_video'], options: [] };
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'A short clip suits this.', uiElement: {
            type: 'design_started', briefId: 12, title: 'Launch clip', note: null,
        } } });
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        const input = page.locator('#briefs-chat-host [data-chat-input]');
        await input.fill('My answers:\nWhat do you need it for?: A short video clip');
        await input.press('Enter');
        await expect(page.locator('[data-brief-tab="making"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-brief-card="12"]')).toBeVisible();
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('New brief always starts a new conversation, never the one on screen', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A few quick questions.', uiElement: null } });
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-new]').click();
        await expect(page.getByText('A few quick questions.')).toHaveCount(1);
        await page.locator('[data-brief-new]').click();
        await expect.poll(() => api.called('chat-orchestrator').length).toBe(2);
        const second = api.called('chat-orchestrator')[1].body as { chatSessionId?: number; message: string };
        expect(second.message).toBe('I need a new brief.');
        expect(second.chatSessionId ?? null).toBeNull();
        await expect(page.getByText('A few quick questions.')).toHaveCount(1);
        expect(pageErrors).toEqual([]);
    });

    test('a flyer with no words: Edit flyer starts from its title, "Save and make the flyer" goes to the editor while it is made', async ({ page, api, pageErrors }) => {
        // The usual stub's handler, wrapped: edit and generate move this brief along.
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        const store = stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        store.brief = { ...store.brief, status: 'open', rounds: 0, options: [], flyerContent: null, paperSize: 'A5', title: 'Marmalade Productions launch party' };
        const calls: string[] = [];
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            calls.push(String(b.action));
            if (b.action === 'edit') { store.brief = { ...store.brief, flyerContent: b.flyerContent }; return { ok: true }; }
            if (b.action === 'generate') { store.brief = { ...store.brief, status: 'generating', rounds: 1 }; return { ok: true, briefId: 12, round: 1 }; }
            return base!(route, body);
        });
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await expect(page.locator('[data-brief-generate="12"]')).toHaveText('Make the flyer');
        await page.locator('[data-brief-edit="12"]').first().click();
        await expect(page.locator('[data-flyer-form] input[name="headline"]')).toHaveValue('Marmalade Productions launch party');
        await page.getByRole('button', { name: 'Save and make the flyer' }).click();
        await expect.poll(() => calls.includes('generate')).toBe(true);
        expect(calls.indexOf('edit')).toBeLessThan(calls.indexOf('generate'));
        // No waiting screen (owner 2026-11-05): the brief moves to "Being made", with a half see-through pop-up.
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        await expect(page.locator('[data-brief-tab="making"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-brief-card="12"]')).toBeVisible();
        const notice = page.locator('#brief-notice');
        await expect(notice).toContainText('Mira is making your flyer');
        await expect(notice).toHaveCSS('background-color', 'rgba(17, 24, 39, 0.5)');
        await page.screenshot({ path: 'test-results/briefs-making-notice.png' });
        expect(pageErrors).toEqual([]);
    });

    test('no Select beside New brief or on an option the editor opens; Select is in the editor', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="review"]').click();
        await expect(page.locator('[data-brief-open-studio="77"]')).toBeVisible();
        await expect(page.locator('[data-brief-pick]')).toHaveCount(0);
        await expect(page.locator('[data-brief-select="77"]')).toHaveCount(0);
        await page.locator('[data-brief-open-studio="77"]').click();
        await expect(page.locator('[data-ds-pick]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('"Not this" with only their own words: a button sends it, and the flyer leaves the list', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="review"]').click();
        await page.locator('[data-brief-reject="77"]').click();
        await page.getByRole('button', { name: 'Not this one' }).click();
        expect(store.decided).toHaveLength(0);
        await page.locator('[data-brief-reject-note="77"]').fill('The cat should be ginger, not grey');
        await page.getByRole('button', { name: 'Not this one' }).click();
        await expect.poll(() => store.decided.length).toBe(1);
        expect(store.decided[0]).toMatchObject({ action: 'decide', optionId: 77, decision: 'reject', reason: 'other', note: 'The cat should be ginger, not grey' });
        expect(pageErrors).toEqual([]);
    });

    test('Edit brief says what saving does to what is already made', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="review"]').click();
        const edit = page.getByRole('button', { name: 'Edit brief', exact: true });
        await expect(edit).toBeVisible();
        await expect(page.getByRole('button', { name: 'Edit flyer' })).toHaveCount(0);
        await edit.click();
        await expect(page.locator('[data-brief-edit-keeps]')).toContainText('The 1 flyer page already made stay as they are');
        expect(pageErrors).toEqual([]);
    });

    test('every brief can be hidden and shown, remembered; Hide all and Show all for the tab', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.brief = { ...store.brief };
        const second = { ...store.brief, id: 13, title: 'Second flyer', options: [{ ...(store.brief.options as Record<string, unknown>[])[0], id: 78 }] };
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        api.set('brand-briefs', (route, body) => {
            const out = base!(route, body) as Record<string, unknown>;
            if ((body as { action?: string })?.action === 'list') return { ...out, briefs: [store.brief, second] };
            return out;
        });
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="review"]').click();
        const toggle = page.locator('[data-brief-toggle="12"]');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-brief-body="12"]')).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-brief-body="12"]')).toBeHidden();
        await expect(page.locator('[data-brief-body="13"]')).toBeVisible();
        await page.reload();
        await page.locator('[data-brief-tab="review"]').click();
        await expect(page.locator('[data-brief-body="12"]')).toBeHidden();
        await page.getByRole('button', { name: 'Hide all' }).click();
        await expect(page.locator('[data-brief-body="13"]')).toBeHidden();
        await page.screenshot({ path: 'test-results/briefs-collapsed.png' });
        await page.getByRole('button', { name: 'Show all' }).click();
        await expect(page.locator('[data-brief-body="12"]')).toBeVisible();
        await expect(page.locator('[data-brief-body="13"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
