// The Brand Designer's editor (owner, 2026-11-05): the design on the left, the chat on the right, drag and change
// anything on it, full screen, and approve from it. The tab's real modules on a bare page, with every function stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Locator, Page } from '@playwright/test';

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
        refuseSaves: false,
        design: design(),
        brief: {
            id: 12, assistantId: 4, title: 'Launch party flyer', purpose: 'flyer', status: 'options_ready', aspectRatio: null, message: 'Our launch', headline: null, mood: 'Calm and natural',
            mustInclude: null, mustAvoid: null, sources: [], rounds: 1, maxRounds: 5, picturesNeeded: 1, picturesApproved: 0, dueDate: null,
            options: [{ id: 77, round: 1, source: 'flyer', status: 'proposed', url: PICTURE, width: 400, height: 560, mimeType: 'image/png', prompt: null, flyer: { layout: 'type_only', paperSize: 'A5', lowResPhoto: false, photoDpi: null } }],
        } as Record<string, unknown>,
    };
    api.set('brand-briefs', async (route, body) => {
        const b = (body || {}) as Record<string, unknown>;
        if (b.action === 'save_design' && store.refuseSaves) {
            await route.fulfill({ status: 500, json: { error: 'That could not be done just now. Please try again.' } });
            return undefined;
        }
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
    // Everything waiting on the user is under "To do" (owner 2026-11-06).
    await page.locator('[data-brief-tab="todo"]').click();
    await page.locator('[data-brief-open-studio="77"]').click();
    await expect(page.locator('[data-design-studio]')).toBeVisible();
    await expect(layer(page, 'headline')).toBeVisible();
}
/** The page is sized to the window once it has drawn, replacing what is on it, so a measurement can miss: try again. */
async function settledBox(target: Locator) {
    let box: { x: number; y: number; width: number; height: number } | null = null;
    await expect.poll(async () => (box = await target.boundingBox()) !== null).toBe(true);
    return box!;
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

    test('words are changed on the design itself: click to select, click again to type, and the design stays still', async ({ page, api, pageErrors }) => {
        // Owner 2026-11-06: "I would like to edit the words in the selected text box directly".
        const store = stubBriefs(api);
        await page.setViewportSize({ width: 1000, height: 950 });
        await openStudio(page);
        const stage = page.locator('[data-ds-page]');
        const editing = page.locator('[data-ds-page] [contenteditable]');
        await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeGreaterThan(100);
        const before = await settledBox(stage);
        await layer(page, 'headline').click();
        await expect(page.locator('[data-ds-bold]')).toBeVisible();
        await expect(editing).toHaveCount(0);
        const after = await settledBox(stage);
        expect(after.y, 'selecting words must not push the design down').toBe(before.y);
        expect(after.width).toBe(before.width);
        await expect(page.locator('[data-ds-text]'), 'no separate box for the words').toHaveCount(0);

        // A second click, and the words are open where they are.
        await layer(page, 'headline').click();
        await expect(editing).toHaveCount(1);
        await expect(editing).toBeFocused();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('Opening night');
        await expect(layer(page, 'headline')).toContainText('Opening night');
        await page.keyboard.press('Escape');
        await expect(editing).toHaveCount(0);
        await expect.poll(() => headline(lastSave(store))?.text, { timeout: 10000 }).toBe('Opening night');

        // One Undo takes back all that typing.
        await page.locator('[data-ds-undo]').click();
        await expect(layer(page, 'headline')).toContainText('Launch party');

        // Dragging selected words moves them and does not open them.
        const box = await settledBox(layer(page, 'headline'));
        await page.mouse.move(box.x + 30, box.y + 10);
        await page.mouse.down();
        await page.mouse.move(box.x + 30, box.y + 60, { steps: 4 });
        await page.mouse.up();
        await expect(editing).toHaveCount(0);

        // Enter opens them too.
        await stage.focus();
        await page.keyboard.press('Enter');
        await expect(editing).toHaveCount(1);
        await page.keyboard.press('Escape');

        // The contact details open the same way as any other words, and there is no separate list of them.
        await stage.click({ position: { x: 3, y: 3 } });
        await expect(page.locator('[data-ds-words]')).toHaveCount(0);
        await expect(page.locator('[data-ds-tools]')).not.toContainText('Change the words');
        await layer(page, 'contact').click();
        await layer(page, 'contact').click();
        await expect(editing).toBeFocused();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('01632 960000');
        await page.keyboard.press('Escape');
        await expect(layer(page, 'contact')).toContainText('01632 960000');

        // A double-click from nothing selected opens them as well.
        await stage.click({ position: { x: 3, y: 3 } });
        await layer(page, 'headline').dblclick();
        await expect(editing).toHaveCount(1);
        await page.keyboard.press('Escape');

        // + Add words goes straight to typing.
        await stage.click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-add]').click();
        await expect(editing).toBeFocused();
        await page.keyboard.type('Free entry');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-ds-page]')).toContainText('Free entry');
        await page.screenshot({ path: 'test-results/design-studio-words.png' });
        expect(pageErrors).toEqual([]);
    });

    test('a picture can be set as the page background, undone, and made a normal picture again', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        await page.locator('[data-ds-add-picture]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await page.locator('[data-ds-bg]').click();
        const bg = layer(page, 'photo');
        await expect(bg).toBeVisible();
        await expect(layer(page, 'p1')).toHaveCount(0);
        const stage = await settledBox(page.locator('[data-ds-page]'));
        const b = await settledBox(bg);
        expect(Math.round(b.width)).toBe(Math.round(stage.width));
        expect(Math.round(b.height)).toBe(Math.round(stage.height));
        // It goes behind the words.
        const ids = () => page.locator('[data-ds-page] [data-ds-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.dsId));
        expect((await ids())[0]).toBe('photo');
        const savedPhoto = () => (lastSave(store) as unknown as { photo?: { id?: string; w?: number } | null } | undefined)?.photo;
        await expect.poll(() => savedPhoto()?.id, { timeout: 10000 }).toBe('p1');
        expect(savedPhoto()?.w).toBe(1);
        await page.screenshot({ path: 'test-results/design-studio-background.png' });

        await page.locator('[data-ds-undo]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await expect(layer(page, 'photo')).toHaveCount(0);
        await page.locator('[data-ds-redo]').click();
        await expect(layer(page, 'photo')).toBeVisible();

        await layer(page, 'photo').click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-unbg]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await expect(layer(page, 'photo')).toHaveCount(0);
        await expect(page.locator('[data-ds-order]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('several parts can be selected, grouped, moved and resized together, and ungrouped', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        const editing = page.locator('[data-ds-page] [contenteditable]');
        const groups = () => (lastSave(store)?.layers ?? []).map((l) => (l as { group?: string }).group);

        // Shift-click selects both, and Group ties them together.
        await layer(page, 'headline').click();
        await layer(page, 'contact').click({ modifiers: ['Shift'] });
        await expect(page.locator('[data-ds-tools]')).toContainText('2 parts selected');
        await page.locator('[data-ds-group]').click();
        await expect.poll(() => groups().filter(Boolean).length, { timeout: 10000 }).toBe(2);
        expect(new Set(groups()).size).toBe(1);
        await expect(page.locator('[data-ds-ungroup]')).toBeVisible();

        // Away and back: one click selects the whole group.
        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await expect(page.locator('.ds-group-box')).toHaveCount(0);
        await layer(page, 'contact').click();
        await expect(page.locator('[data-ds-tools]')).toContainText('2 parts selected');
        await page.screenshot({ path: 'test-results/design-studio-group.png' });

        // Dragging moves both by the same amount.
        const y = (id: string) => lastSave(store)?.layers.find((l) => l.id === id)?.y ?? 0;
        const c = await settledBox(layer(page, 'contact'));
        await page.mouse.move(c.x + 5, c.y + 3);
        await page.mouse.down();
        await page.mouse.move(c.x + 5, c.y - 57, { steps: 4 });
        await page.mouse.up();
        await expect.poll(() => y('contact'), { timeout: 10000 }).toBeLessThan(0.89);
        expect(y('contact') - 0.9).toBeCloseTo(y('headline') - 0.3, 3);
        await expect(editing).toHaveCount(0);

        // The corner resizes both, their words too.
        const size = () => (lastSave(store)?.layers.find((l) => l.id === 'headline') as { fontSizePct?: number } | undefined)?.fontSizePct ?? 0;
        const handle = await settledBox(page.locator('.ds-group-box .ds-handle'));
        await page.mouse.move(handle.x + 7, handle.y + 7);
        await page.mouse.down();
        await page.mouse.move(handle.x - 60, handle.y + 7, { steps: 4 });
        await page.mouse.up();
        await expect.poll(size, { timeout: 10000 }).toBeLessThan(0.06);

        // A click on one part narrows to that part, and another click types in it.
        await layer(page, 'headline').click();
        await expect(page.locator('[data-ds-bold]')).toBeVisible();
        await layer(page, 'headline').click();
        await expect(editing).toHaveCount(1);
        await page.keyboard.press('Escape');

        // Ungroup from a part, and each is its own again.
        await page.locator('[data-ds-ungroup]').click();
        await expect.poll(() => groups().filter(Boolean).length, { timeout: 10000 }).toBe(0);

        // Dragging across the bare page selects what it touches.
        const stage = await settledBox(page.locator('[data-ds-page]'));
        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await page.mouse.move(stage.x + 3, stage.y + 3);
        await page.mouse.down();
        await page.mouse.move(stage.x + stage.width - 3, stage.y + stage.height - 3, { steps: 4 });
        await expect(page.locator('.ds-marquee')).toHaveCount(1);
        await page.mouse.up();
        await expect(page.locator('.ds-marquee')).toHaveCount(0);
        await expect(page.locator('[data-ds-tools]')).toContainText('2 parts selected');

        // Cmd/Ctrl+G groups them, and Delete takes both.
        await page.keyboard.press('ControlOrMeta+g');
        await expect(page.locator('[data-ds-ungroup]')).toBeVisible();
        await page.locator('[data-ds-delete]').click();
        await expect(page.locator('[data-ds-page] [data-ds-id]')).toHaveCount(0);
        await page.locator('[data-ds-undo]').click();
        await expect(page.locator('[data-ds-page] [data-ds-id]')).toHaveCount(2);
        expect(pageErrors).toEqual([]);
    });

    test('Resize a copy makes a new option and opens it, leaving the original', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        const options = () => store.brief.options as Array<Record<string, unknown>>;
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        const opened: number[] = [];
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'list') return { ...(base!(route, body) as object), briefs: [store.brief] };
            if (b.action === 'resize_design') {
                store.brief = { ...store.brief, options: [...options(), { ...options()[0], id: 78 }] };
                return { ok: true, optionId: 78 };
            }
            if (b.action === 'open_design') { opened.push(b.optionId as number); return { ok: true, design: { ...design(), pageW: 1080, pageH: 1080, kind: 'image' }, photoUrl: null }; }
            return base!(route, body);
        });
        await openStudio(page);
        await page.locator('[data-ds-resize]').selectOption('1:1');
        await expect.poll(() => opened.at(-1)).toBe(78);
        const box = await settledBox(page.locator('[data-ds-page]'));
        expect(Math.abs(box.width - box.height)).toBeLessThan(2);
        await expect(page.locator('[data-ds-thumb="77"]')).toBeVisible();
        await expect(page.locator('[data-ds-thumb="78"]')).toHaveAttribute('aria-current', 'true');
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
        const frame = await settledBox(layer(page, 'p1'));
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
        // The page is sized to the window once it has drawn, so measure after it settles.
        let made: { width: number; height: number } | null = null;
        await expect.poll(async () => (made = await shape.boundingBox()) !== null).toBe(true);
        made = made!;
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
        const b = await settledBox(shape);
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

        const again = await settledBox(shape);
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
        await page.locator('[data-brief-tab="todo"]').click();
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

    test('Remove background swaps in the cut-out, and Undo brings the original back', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        const CUT = PICTURE.replace('8a9a8f', '123456');
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
            if (b.action === 'remove_background') {
                const layers = (store.design.layers as Array<Record<string, unknown>>).map((l) => (l.id === b.target ? { ...l, id: 'p2' } : l));
                store.design = { ...store.design, layers } as never;
                return { ok: true, design: store.design, photoUrl: null, pictureUrls: { p2: CUT }, addedId: 'p2' };
            }
            if (b.action === 'save_design') {
                store.saves.push({ design: JSON.parse(JSON.stringify(b.design)) });
                store.design = b.design as never;
                if (b.addPicture) {
                    store.design = { ...store.design, layers: [...store.design.layers, { id: 'p1', kind: 'picture', role: 'picture', x: 0.25, y: 0.5, w: 0.5, h: 0.3, opacity: 1, ref: { storageKey: 'k' } } as never] };
                    return { ok: true, design: store.design, photoUrl: null, pictureUrls: { p1: PICTURE }, addedId: 'p1' };
                }
                return { ok: true, design: store.design, photoUrl: null };
            }
            return base!(route, body);
        });
        await openStudio(page);
        await page.locator('[data-ds-add-picture]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await page.locator('[data-ds-cutout]').click();
        await expect(layer(page, 'p2')).toBeVisible();
        await expect(layer(page, 'p2').locator('img')).toHaveAttribute('src', CUT);
        await expect(page.locator('[data-ds-cutout]')).toBeEnabled();
        await page.locator('[data-ds-undo]').click();
        await expect(layer(page, 'p1')).toBeVisible();
        await expect(layer(page, 'p1').locator('img')).toHaveAttribute('src', PICTURE);
        expect(pageErrors).toEqual([]);
    });

    test('Download asks for a see-through PNG when chosen, and saves through the address it gets back', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        const asked: unknown[] = [];
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'download_png') { asked.push(b.seeThrough); return { ok: true, url: '/e2e-download.png' }; }
            if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
            return base!(route, body);
        });
        await page.route('**/e2e-download.png', (r) => r.fulfill({ contentType: 'image/png', headers: { 'Content-Disposition': 'attachment; filename="design.png"' }, body: Buffer.from('x') }));
        await openStudio(page);
        const saved = page.waitForEvent('download');
        await page.locator('[data-ds-download]').selectOption('clear');
        expect((await saved).suggestedFilename()).toBe('design.png');
        expect(asked).toEqual([true]);
        await expect(page.locator('[data-ds-download]')).toHaveValue('');
        await expect(page.locator('[data-ds-download]')).toBeEnabled();
        expect(pageErrors).toEqual([]);
    });

    test('a flyer can have a back: add it, edit it apart from the front, save both, undo, and remove it', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        const saved = () => lastSave(store) as unknown as { layers: Array<{ id: string; text?: string }>; back?: { layers: Array<{ id: string; text?: string }>; pageColor: string } | null; pageColor: string };
        await openStudio(page);
        await expect(page.locator('[data-ds-side="back"]')).toHaveCount(0);
        await page.locator('[data-ds-add-back]').click();
        await expect(page.locator('[data-ds-side="back"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-ds-page] [data-ds-id]')).toHaveCount(0);

        // What goes on the back stays on the back, and the front is sent as the front.
        await page.locator('[data-ds-page-color]').fill('#123456');
        await page.locator('[data-ds-add]').click();
        await page.keyboard.type('Terms and conditions');
        await page.keyboard.press('Escape');
        await expect.poll(() => saved()?.back?.layers.length ?? 0, { timeout: 10000 }).toBe(1);
        // New words show up on a dark page.
        await expect(page.locator('[data-ds-page] [data-kind="text"]')).toHaveCSS('color', 'rgb(255, 255, 255)');
        expect(saved().back?.layers[0].text).toBe('Terms and conditions');
        expect(saved().back?.pageColor).toBe('#123456');
        expect(saved().pageColor).toBe('#f2aa00');
        expect(saved().layers.map((l) => l.id)).toContain('headline');
        await page.screenshot({ path: 'test-results/design-studio-back.png' });

        // Over to the front and back again.
        await page.locator('[data-ds-side="front"]').click();
        await expect(layer(page, 'headline')).toBeVisible();
        await expect(page.locator('[data-ds-page]')).toHaveCSS('background-color', 'rgb(242, 170, 0)');
        await page.locator('[data-ds-side="back"]').click();
        await expect(page.locator('[data-ds-page]')).toContainText('Terms and conditions');
        await expect(page.locator('[data-ds-page]')).toHaveCSS('background-color', 'rgb(18, 52, 86)');

        // Saved while on the back: still the front at the top of what is sent.
        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await page.locator('[data-ds-add]').click();
        await page.keyboard.type('More');
        await page.keyboard.press('Escape');
        await expect.poll(() => saved()?.back?.layers.length ?? 0, { timeout: 10000 }).toBe(2);
        expect(saved().layers.map((l) => l.id)).toContain('headline');

        // Remove the back: the front is what remains, and Undo returns it.
        await page.locator('[data-ds-remove-back]').click();
        await expect(page.locator('[data-ds-side="back"]')).toHaveCount(0);
        await expect(layer(page, 'headline')).toBeVisible();
        await expect.poll(() => saved()?.back ?? null, { timeout: 10000 }).toBeNull();
        await page.locator('[data-ds-undo]').click();
        await expect(page.locator('[data-ds-side="back"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('templates: save one under a name, use it with Undo to come back, and delete it', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        let templates: Array<{ id: number; name: string }> = [];
        const savedDesigns: unknown[] = [];
        const templated = { ...design(), pageColor: '#ffe4e1', layers: [{ ...design().layers[0], id: 'tpl', text: 'From the template' }] };
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'list_design_templates') return { templates };
            if (b.action === 'save_template') { savedDesigns.push(b.design); templates = [{ id: 7, name: String(b.name) }]; return { ok: true, templates }; }
            if (b.action === 'use_template') { expect(b.templateId).toBe(7); store.design = templated as never; return { ok: true, design: templated, photoUrl: null }; }
            if (b.action === 'delete_design_template') { templates = []; return { ok: true, templates }; }
            if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
            return base!(route, body);
        });
        await openStudio(page);
        const menu = page.locator('[data-ds-templates]');
        await menu.selectOption('save');
        const name = page.locator('#apm-input');
        await expect(name).toBeVisible();
        // Cancel leaves everything as it was.
        await page.locator('#apm-cancel').click();
        await expect(name).toHaveCount(0);
        expect(savedDesigns).toHaveLength(0);
        await menu.selectOption('save');
        await name.fill('Summer events');
        await page.locator('#apm-confirm').click();
        await expect(page.locator('[data-ds-saved]')).toContainText('Summer events');
        expect(savedDesigns).toHaveLength(1);

        await menu.selectOption('use:7');
        await expect(layer(page, 'tpl')).toContainText('From the template');
        await expect(page.locator('[data-ds-page]')).toHaveCSS('background-color', 'rgb(255, 228, 225)');
        await page.screenshot({ path: 'test-results/design-studio-template.png' });
        await page.locator('[data-ds-undo]').click();
        await expect(layer(page, 'headline')).toContainText('Launch party');

        await page.locator('[data-ds-page]').click({ position: { x: 3, y: 3 } });
        await menu.selectOption('del:7');
        await page.getByRole('button', { name: 'Delete template' }).click();
        await expect(page.locator('[data-ds-saved]')).toContainText('Template deleted');
        await expect(menu.locator('option[value="use:7"]')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('the design holds still while the server changes a picture, and takes clicks again after', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        let release: () => void = () => {};
        const waiting = new Promise<void>((r) => { release = r; });
        api.set('brand-briefs', async (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
            if (b.addPicture) {
                await waiting;
                store.design = { ...(b.design as typeof store.design), layers: [...(b.design as typeof store.design).layers, { id: 'p1', kind: 'picture', role: 'picture', x: 0.25, y: 0.5, w: 0.5, h: 0.3, opacity: 1, ref: {} } as never] };
                return { ok: true, design: store.design, photoUrl: null, pictureUrls: { p1: PICTURE }, addedId: 'p1' };
            }
            return base!(route, body) as never;
        });
        await openStudio(page);
        await page.locator('[data-ds-add-picture]').click();
        await expect(page.locator('[data-ds-page]')).toHaveCSS('pointer-events', 'none');
        await expect(page.locator('[data-ds-tools]')).toHaveCSS('pointer-events', 'none');
        release();
        await expect(layer(page, 'p1')).toBeVisible();
        await expect(page.locator('[data-ds-page]')).not.toHaveCSS('pointer-events', 'none');
        await layer(page, 'p1').click();
        await expect(page.locator('[data-ds-bg]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('a picture brief has no back to add', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.design = { ...store.design, kind: 'image', pageW: 1080, pageH: 1080, paperSize: null } as never;
        await openStudio(page);
        await expect(page.locator('[data-ds-add-back]')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('Download offers a PDF, and a print-shop one for a flyer only, and sends what is on screen', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        let base: ((route: unknown, body: unknown) => unknown) | null = null;
        stubBriefs({ set: (_n: string, h: typeof base) => { base = h; } } as unknown as ApiStub);
        const asked: Array<Record<string, unknown>> = [];
        api.set('brand-briefs', (route, body) => {
            const b = (body || {}) as Record<string, unknown>;
            if (b.action === 'download_pdf') { asked.push(b); return { ok: true, url: b.printShop ? '/e2e-shop.pdf' : '/e2e-home.pdf' }; }
            if (b.action === 'open_design') return { ok: true, design: store.design, photoUrl: null };
            return base!(route, body);
        });
        await page.route('**/e2e-home.pdf', (r) => r.fulfill({ contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="design.pdf"' }, body: Buffer.from('%PDF') }));
        await page.route('**/e2e-shop.pdf', (r) => r.fulfill({ contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="design-print-shop.pdf"' }, body: Buffer.from('%PDF') }));
        await openStudio(page);
        const menu = page.locator('[data-ds-download]');
        let saved = page.waitForEvent('download');
        await menu.selectOption('pdf');
        expect((await saved).suggestedFilename()).toBe('design.pdf');
        await expect(menu).toBeEnabled();
        saved = page.waitForEvent('download');
        await menu.selectOption('shop');
        expect((await saved).suggestedFilename()).toBe('design-print-shop.pdf');
        expect(asked.map((a) => a.printShop)).toEqual([false, true]);
        expect(asked[0].title).toBe('Launch party flyer');
        expect((asked[0].design as { layers: unknown[] }).layers.length).toBe(2);
        expect(pageErrors).toEqual([]);
    });

    test('a picture design offers a PDF but no print-shop one', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.design = { ...store.design, kind: 'image', pageW: 1080, pageH: 1080, paperSize: null } as never;
        await openStudio(page);
        await expect(page.locator('[data-ds-download] option[value="pdf"]')).toHaveCount(1);
        await expect(page.locator('[data-ds-download] option[value="shop"]')).toHaveCount(0);
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
        const b = await settledBox(dock);
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

    test('"Back to brief" opens a brief that started closed, in view, with its round button', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        // Reached as the chat reaches it: this brief has never been opened, so its card is folded shut.
        await page.addInitScript(() => localStorage.setItem('bms-briefs-open-4', '[]'));
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="todo"]').click();
        await expect(page.locator('[data-brief-generate="12"]')).toBeHidden();
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('brief:openStudioAny', { detail: { briefId: 12 } })));
        await expect(layer(page, 'headline')).toBeVisible();
        await expect(page.getByRole('button', { name: /Back to brief/ })).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'More options', exact: true })).toHaveCount(0);
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        await expect(page.locator('[data-brief-tab="todo"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-brief-generate="12"]')).toBeVisible();
        await expect(page.locator('[data-brief-card="12"]')).toBeInViewport();
        expect(store.saves[store.saves.length - 1].finish).toBe(true);
        expect(pageErrors).toEqual([]);
    });

    test('"Back to brief" follows a brief that a round from the chat has moved to Being made', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        store.brief = { ...store.brief, status: 'generating' };
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-brief-tab="making"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-brief-card="12"]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('a failed save keeps you in the editor, and a second press leaves', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        store.refuseSaves = true;
        const saves = store.saves.length;
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-ds-error]')).toContainText('Press again to leave');
        await expect(page.locator('[data-design-studio]')).toBeVisible();
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        expect(store.saves.length).toBe(saves);
        expect(pageErrors).toEqual([]);
    });

    test('a change made after a failed save is saved again before leaving', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        await openStudio(page);
        store.refuseSaves = true;
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-ds-error]')).toContainText('Press again to leave');
        store.refuseSaves = false;
        await layer(page, 'headline').click();
        await page.keyboard.press('ArrowRight');
        const before = store.saves.length;
        await page.locator('[data-ds-back]').click();
        await expect(page.locator('[data-design-studio]')).toHaveCount(0);
        expect(store.saves.length).toBeGreaterThan(before);
        expect(store.saves[store.saves.length - 1].finish).toBe(true);
        expect(pageErrors).toEqual([]);
    });

    test('a brief with all its rounds used says so, and offers no cost line', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        store.brief = { ...store.brief, rounds: 5 };
        await page.route('**/e2e-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-studio.html');
        await page.locator('[data-brief-tab="todo"]').click();
        const card = page.locator('[data-brief-card="12"]');
        await expect(card).toContainText('used all 5 of its rounds');
        await expect(page.locator('[data-brief-generate="12"]')).toBeDisabled();
        await expect(card).not.toContainText('Each round');
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

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('tap to select, tap again to type; the page stays on screen and sideways scrolling stays away', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openStudio(page);
        await layer(page, 'headline').tap();
        await expect(page.locator('[data-ds-bold]')).toBeVisible();
        await layer(page, 'headline').tap();
        await expect(page.locator('[data-ds-page] [contenteditable]')).toHaveCount(1);
        await page.keyboard.type('!');
        await page.locator('[data-ds-page] [contenteditable]').press('Escape');
        await expect(layer(page, 'headline')).toContainText('!');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.screenshot({ path: 'test-results/design-studio-phone.png' });
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
        await page.locator('[data-brief-tab="todo"]').click();
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
        await page.locator('[data-brief-tab="todo"]').click();
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
        await page.locator('[data-brief-tab="todo"]').click();
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
        await page.locator('[data-brief-tab="todo"]').click();
        const toggle = page.locator('[data-brief-toggle="12"]');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('[data-brief-body="12"]')).toBeVisible();
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-brief-body="12"]')).toBeHidden();
        await expect(page.locator('[data-brief-body="13"]')).toBeVisible();
        await page.reload();
        await page.locator('[data-brief-tab="todo"]').click();
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
