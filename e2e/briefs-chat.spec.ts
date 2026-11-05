// The Brand Designer's docked chat (owner, 2026-11-05: the Website tab's chat pane, on the Briefs tab). The
// tab's real modules on a bare page, with every function stubbed.

import { test, expect, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#8a9a8f"/></svg>')}`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <div class="page-wide p-4"><div id="maintab-briefs"><div id="briefs-host"></div></div></div>
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/generated/platform-constants.js"></script><script src="/src/components/font-picker.js"></script><script src="/src/components/brand-style-dialog.js"></script>
  <script src="/src/components/assistant-briefs.js"></script>
  <script>AssistantBriefs.init({ assistantId: 4, assistantName: 'Mira' }); setTimeout(() => AssistantBriefs.activate(), 50);</script>
</body></html>`;

function stubBriefs(api: ApiStub) {
    const store = {
        edits: [] as Record<string, unknown>[],
        spends: 0,
        brief: {
            id: 12, assistantId: 4, title: 'Spring sale post', purpose: 'social', status: 'options_ready', aspectRatio: '1:1', message: 'A sunny shop front', headline: null, mood: null,
            mustInclude: null, mustAvoid: null, sources: ['stock', 'ai_image'], rounds: 1, maxRounds: 5, picturesNeeded: 1, picturesApproved: 0, dueDate: null,
            options: [{ id: 77, round: 1, source: 'ai_image', status: 'proposed', url: PICTURE, width: 400, height: 400, mimeType: 'image/png', prompt: 'A shop front at dawn, soft light' }],
        } as Record<string, unknown>,
    };
    api.set('brand-briefs', (_route, body) => {
        const b = (body || {}) as Record<string, unknown>;
        if (b.action === 'list') {
            return { briefs: [store.brief], vocab: { purposes: [], sources: [], aspectRatios: [], rejectReasons: [{ key: 'style', label: 'Wrong style' }], maxRounds: 5, flyer: null }, credits: 10, unit: 'tasks', aiAvailable: true, defaultSources: ['stock'], guidelines: null };
        }
        if (b.action === 'edit') {
            store.edits.push(b);
            const { action: _a, briefId: _b, ...fields } = b;
            store.brief = { ...store.brief, ...fields };
            return { ok: true };
        }
        if (b.action === 'generate') store.spends++;
        return { ok: true };
    });
    return store;
}

async function openTab(page: Page) {
    await page.route('**/e2e-briefs.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-briefs.html');
    await expect(page.locator('[data-brief-card="12"]')).toBeVisible();
}

const input = (page: Page) => page.locator('#briefs-chat-host [data-chat-input]');
const select = (page: Page) => page.locator('[data-brief-select="77"]');
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string };
async function ask(page: Page, text: string) { await input(page).fill(text); await input(page).press('Enter'); }

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the briefs on the left, the chat docked on the right; its button only shows once the chat is closed', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openTab(page);
        await expect(input(page)).toBeVisible();
        const card = await page.locator('[data-brief-card="12"]').boundingBox();
        const box = await input(page).boundingBox();
        expect(card!.x + card!.width).toBeLessThanOrEqual(box!.x);
        await page.screenshot({ path: 'test-results/briefs-chat.png' });
        await expect(page.locator('[data-brief-chat-toggle]')).toHaveCount(0);
        await page.getByRole('button', { name: /close/i }).first().click();
        await expect(input(page)).toBeHidden();
        await page.locator('[data-brief-chat-toggle]').click();
        await expect(input(page)).toBeVisible();
        await expect(page.locator('[data-brief-chat-toggle]')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('Select an option → the card changes the brief → it saves, and nothing is spent', async ({ page, api, pageErrors }) => {
        const store = stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
            type: 'visual_brief_edit', briefId: 12, mood: 'Bright and sunny, like the dawn shop front', summary: 'Brighter.',
        } } });
        await openTab(page);
        await select(page).click();
        await ask(page, 'More like this one, but brighter');
        const save = page.getByRole('button', { name: 'Save the change' });
        await expect(save).toBeVisible();
        expect(sent(api).message).toContain('About this option on my brief 12 “Spring sale post”: option 77');
        expect(sent(api).message).toContain('A shop front at dawn, soft light');
        await page.screenshot({ path: 'test-results/briefs-chat-card.png' });
        await save.click();
        await expect(page.getByText('Saved. Ask for more options', { exact: false })).toBeVisible();
        expect(store.edits[0]).toMatchObject({ action: 'edit', briefId: 12, mood: 'Bright and sunny, like the dawn shop front' });
        expect(store.spends).toBe(0);
        expect(pageErrors).toEqual([]);
    });

    test('a refused save says why, and can be tried again', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        const fallback = (route: { request(): { postDataJSON(): Record<string, unknown> }; fulfill(o: unknown): Promise<void>; fallback(): Promise<void> }) => {
            if (route.request().postDataJSON()?.action === 'edit') return route.fulfill({ status: 409, json: { error: 'Options are being made right now.' } });
            return route.fallback();
        };
        await page.route('**/.netlify/functions/brand-briefs', fallback as never);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'Here.', uiElement: { type: 'visual_brief_edit', briefId: 12, mood: 'Bright', summary: 'Brighter.' } } });
        await openTab(page);
        await ask(page, 'Brighter');
        await page.getByRole('button', { name: 'Save the change' }).click();
        await expect(page.getByText('Options are being made right now.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save the change' })).toBeEnabled();
        expect(pageErrors).toEqual([]);
    });

    test('"Talk it through" uses the docked chat, not a pop-up', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await page.locator('[data-brief-chat="12"]').click();
        await ask(page, 'Thoughts?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).message).toContain('About my brief 12 “Spring sale post”.');
        expect(pageErrors).toEqual([]);
    });

    test('the conversation is remembered for this assistant', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        api.set('chat-orchestrator', { chatSessionId: 3, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openTab(page);
        await ask(page, 'Hello');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('bms-brief-chat:4'))).toBe('3');
        expect(pageErrors).toEqual([]);
    });
});

test.describe('Love Cat feedback (2026-11-05)', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    function stubStages(api: ApiStub) {
        const base = { assistantId: 4, purpose: 'social_post', aspectRatio: '1:1', message: 'x', headline: null, mood: null, mustInclude: null, mustAvoid: null, sources: ['stock'], rounds: 0, maxRounds: 6, picturesNeeded: 1, dueDate: null, options: [] };
        const opt = { round: 1, source: 'stock', url: PICTURE, width: 400, height: 400, mimeType: 'image/png', prompt: 'p' };
        const briefs = [
            { ...base, id: 1, title: 'Not begun', status: 'open' },
            { ...base, id: 2, title: 'In the works', status: 'generating' },
            { ...base, id: 3, title: 'Waiting for you', status: 'in_review', rounds: 1, options: [{ ...opt, id: 31, status: 'proposed' }] },
            { ...base, id: 4, title: 'All done', status: 'approved', rounds: 1, options: [{ ...opt, id: 41, status: 'approved' }] },
            { ...base, id: 5, title: 'Stopped', status: 'cancelled' },
        ];
        api.set('brand-briefs', (_r, body) => ((body as { action?: string }).action === 'list'
            ? { briefs, vocab: { purposes: [{ key: 'social_post', label: 'Social post' }, { key: 'flyer', label: 'Printed flyer' }], sources: [], aspectRatios: [], rejectReasons: [], maxRounds: 6, flyer: { paperSizes: [{ key: 'A5', label: 'A5' }], defaultPaperSize: 'A5', limits: {}, photoSources: ['stock'] } }, credits: 10, unit: 'tasks', aiAvailable: true, defaultSources: ['stock'],
                guidelines: { photoStyle: null, mustInclude: null, mustAvoid: null, secondaryColors: [] }, brandKit: { primaryColor: '#1f1e1b', backgroundColor: '#ffffff', textColor: '#1f1e1b', fontFamily: null, source: 'default' } }
            : { ok: true }));
    }
    async function open(page: Page) {
        await page.route('**/e2e-briefs.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
        await page.goto('/e2e-briefs.html');
        await expect(page.locator('[data-brief-tabs]')).toBeVisible();
    }

    test('tabs run left to right with counts, open on what needs the user, and each brief is in one', async ({ page, api, pageErrors }) => {
        stubStages(api);
        await open(page);
        const tabs = page.getByRole('tab');
        await expect(tabs).toHaveText([/Not started\s*1/, /Being made\s*1/, /To review\s*1/, /Approved\s*1/, /Archived\s*1/]);
        await expect(page.getByRole('tab', { name: /To review/ })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-brief-card]')).toHaveCount(1);
        await expect(page.locator('[data-brief-card="3"]')).toBeVisible();
        await page.screenshot({ path: 'test-results/brief-tabs.png' });
        await page.getByRole('tab', { name: /Archived/ }).click();
        await expect(page.locator('[data-brief-card="5"]')).toBeVisible();
        await page.getByRole('tab', { name: /Archived/ }).press('Home');
        await expect(page.locator('[data-brief-card="1"]')).toBeVisible();
        await expect(page.getByRole('tab', { name: /Not started/ })).toBeFocused();
        expect(pageErrors).toEqual([]);
    });

    test('one New brief button: it asks in the chat and spends nothing; the form still covers a flyer', async ({ page, api, pageErrors }) => {
        stubStages(api);
        api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A few quick questions.', uiElement: { type: 'chat_questions', questions: [{ question: 'What do you need it for?', options: ['A social media post', 'A printed flyer or poster'] }] } } });
        await open(page);
        await expect(page.locator('[data-brief-new-flyer]')).toHaveCount(0);
        await page.locator('[data-brief-new]').click();
        await expect(page.getByText('What do you need it for?')).toBeVisible();
        expect((api.called('chat-orchestrator')[0].body as { message: string }).message).toBe('I need a new brief.');
        await page.locator('[data-brief-new-form]').click();
        await page.locator('[data-brief-form] select[name="purpose"]').selectOption('flyer');
        await expect(page.locator('[data-flyer-form]')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('Select: the toolbar tool picks an option by clicking it, and Escape stops it', async ({ page, api, pageErrors }) => {
        stubStages(api);
        await open(page);
        await page.locator('[data-brief-pick]').click();
        await expect(page.locator('[data-brief-pick]')).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-brief-pick]')).toHaveAttribute('aria-pressed', 'false');
        await page.locator('[data-brief-pick]').click();
        await page.locator('[data-brief-option="31"] img').click();
        await expect(page.locator('#briefs-chat-host').getByText(/Waiting for you/)).toBeVisible();
        await expect(page.locator('[data-brief-pick]')).toHaveAttribute('aria-pressed', 'false');
        expect(pageErrors).toEqual([]);
    });

    test('brand style opens here: says plainly nothing is chosen, fonts show in a list with an example, saves only what changed', async ({ page, api, pageErrors }) => {
        stubStages(api);
        const calls: Array<{ method: string; body: unknown }> = [];
        await page.route('**/.netlify/functions/brand-kit', async (r) => {
            const body = r.request().postDataJSON?.() ?? null;
            calls.push({ method: r.request().method(), body });
            if (r.request().method() === 'GET') return r.fulfill({ json: { brandKit: { primaryColor: '#1f1e1b', backgroundColor: '#ffffff', textColor: '#1f1e1b', fontFamily: null, source: 'default' }, guidelines: { photoStyle: null, mustInclude: null, mustAvoid: null, secondaryColors: [] } } });
            return r.fulfill({ json: { ok: true, dataUrl: PICTURE, brandKit: {} } });
        });
        await open(page);
        await expect(page.locator('[data-brief-style]').getByText('No brand colours chosen yet')).toBeVisible();
        await page.locator('[data-brief-edit-style]').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText(/You have not chosen brand colours yet/)).toBeVisible();
        await dialog.locator('[data-fp-toggle]').click();
        await dialog.locator('[data-fp-search]').fill('playfair');
        const option = dialog.getByRole('option', { name: /Playfair Display/ });
        await expect(option).toHaveCSS('font-family', /Playfair Display/);
        await option.click();
        await expect(dialog.locator('[data-fp-sample]').getByText('Your words, in this font')).toBeVisible();
        await page.screenshot({ path: 'test-results/brand-style-dialog.png', fullPage: true });
        await dialog.locator('[data-bsd-save]').click();
        await expect(dialog).toBeHidden();
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.body).toEqual({ fontFamily: 'Playfair Display' });
        expect(calls.some((c) => (c.body as { action?: string } | null)?.action === 'save_guidelines')).toBe(false);
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrow screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; Select opens it over the right edge; the ✕ closes it', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openTab(page);
        await expect(input(page)).toBeHidden();
        await select(page).click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(1100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/briefs-chat-narrow.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test('Select works, the chat fills the width, and the ✕ gets back to the briefs', async ({ page, api, pageErrors }) => {
        stubBriefs(api);
        await openTab(page);
        await select(page).click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        await page.screenshot({ path: 'test-results/briefs-chat-phone.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(select(page)).toBeVisible();
        expect(pageErrors).toEqual([]);
    });
});
