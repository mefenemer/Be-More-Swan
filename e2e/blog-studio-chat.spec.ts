// The Blog Studio's docked chat (owner, 2026-11-05: the Website tab's chat pane, for the Blog Assistant):
// the article on the left, the chat on the right, "Select" putting a block into the chat, and a card
// that changes only that block. Plus the bug that mattered most: a rewrite pressed in the chat while the
// article is open must not be overwritten by the editor's old words on its next autosave.
//
// The real modules on a bare page; every function is stubbed, with save-blog-draft and generate-blog
// sharing one `saved` body so a test can see what actually ends up stored.

import { test, expect } from './fixtures';
import type { ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const PARAGRAPH = 'Coffee goes stale within weeks of roasting.\nMost supermarket bags are months old.';
const LIST = '- Taste\n- Smell';
const BODY = `## Why fresh beans matter\n\n${PARAGRAPH}\n\n${LIST}`;
const POST_ID = 41;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/style.css"></head><body class="bg-gray-50">
  <script src="/src/components/scroll-lock.js"></script><script src="/dialogs.js"></script>
  <script src="/src/components/disruptive-ui-registry.js"></script><script src="/src/components/chat-session.js"></script><script src="/src/components/chat-pane.js"></script>
  <script src="/src/public/marked-bms-directives.js"></script><script src="/src/components/markdown-editor.js"></script>
  <script src="/src/generated/platform-constants.js"></script><script src="/src/components/blog-studio-modal.js"></script>
</body></html>`;

/** The article as the server holds it, moved on by autosaves and by the rewrite worker alike. */
function stubArticle(api: ApiStub, status = 'draft') {
    const store = { saved: BODY, saves: [] as string[] };
    const post = () => ({ post: { id: POST_ID, assistantId: 7, title: 'Fresh beans', status, bodyMarkdown: store.saved } });
    api.set('get-assistants', { assistants: [{ id: 7, name: 'Quill', role: 'Blog Writer', roleKey: 'blog_writer', isActive: true, status: 'active' }] });
    api.set('blog-posts', () => post());
    api.set('save-widget-config', { config: { publicKey: 'e2e-key' } });
    api.set('save-blog-draft', (_route, body) => {
        const md = (body as { bodyMarkdown?: string }).bodyMarkdown;
        if (typeof md === 'string') { store.saved = md; store.saves.push(md); }
        return { ok: true, updatedAt: new Date().toISOString() };
    });
    return store;
}

async function openStudio(page: Page) {
    await page.route('**/e2e-blog-studio.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('/e2e-blog-studio.html');
    await page.evaluate((id) => (window as unknown as { openBlogStudio(o: object): void }).openBlogStudio({ postId: id, assistantId: 7 }), POST_ID);
    await expect(page.locator('#bs-editor .bmsme-block').first()).toBeVisible();
}

const input = (page: Page) => page.locator('#bs-chat-host [data-chat-input]');

async function selectParagraph(page: Page) {
    await page.locator('#bs-select').click();
    await page.locator('#bs-editor .bmsme-block', { hasText: 'Coffee goes stale' }).click();
    await expect(page.locator('#bs-select')).toHaveAttribute('aria-pressed', 'false');
}

test('wide screen: the article on the left, the chat docked on the right', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    stubArticle(api);
    await openStudio(page);
    await expect(input(page)).toBeVisible();
    const editor = await page.locator('#bs-editor').boundingBox();
    const chat = await input(page).boundingBox();
    expect(editor!.x + editor!.width).toBeLessThanOrEqual(chat!.x);
    await page.screenshot({ path: 'test-results/blog-studio-chat.png' });
    // The button hides it and brings it back.
    await page.locator('#bs-chat-toggle').click();
    await expect(input(page)).toBeHidden();
    await page.locator('#bs-chat-toggle').click();
    await expect(input(page)).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('narrow screen: the chat opens over the right edge without the page scrolling sideways', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    stubArticle(api);
    await openStudio(page);
    await expect(input(page)).toBeHidden();                  // off by default where it doesn't fit
    await page.locator('#bs-chat-toggle').click();
    await expect(input(page)).toBeVisible();
    const chat = await input(page).boundingBox();
    expect(chat!.x + chat!.width).toBeLessThanOrEqual(1000);
    await page.screenshot({ path: 'test-results/blog-studio-chat-narrow.png' });
    expect(pageErrors).toEqual([]);
});

test('Select → the whole paragraph reaches the assistant → "Use this" changes only that part, and saves it', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const store = stubArticle(api);
    const replacement = 'Coffee loses its flavour within weeks of roasting.';
    api.set('chat-orchestrator', () => ({ chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Here is a tighter version.', uiElement: {
        type: 'blog_block_edit', postId: POST_ID, find: PARAGRAPH, replace: replacement, summary: 'Tightens the paragraph.',
    } } }));
    await openStudio(page);
    await selectParagraph(page);
    await expect(page.locator('#bs-chat-host').getByText('🎯', { exact: false }).first()).toBeVisible();
    await input(page).fill('Make this tighter');
    await input(page).press('Enter');

    const use = page.getByRole('button', { name: 'Use this' });
    await expect(use).toBeVisible();
    const sent = api.called('chat-orchestrator')[0].body as { message: string };
    expect(sent.message).toContain(PARAGRAPH);
    expect(sent.message).toContain('Make this tighter');
    await page.screenshot({ path: 'test-results/blog-studio-chat-card.png' });

    await use.click();
    await expect(page.getByText('Done — it\'s changed in your article.')).toBeVisible();
    await expect(page.locator('#bs-editor')).toContainText(replacement);
    expect(store.saved).toBe(`## Why fresh beans matter\n\n${replacement}\n\n${LIST}`);
    expect(pageErrors).toEqual([]);
});

test('a long paragraph is not cut short on its way to the assistant', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const store = stubArticle(api);
    const long = `Start of it. ${'Every sentence in this paragraph matters to the reader. '.repeat(30)}The very end.`;
    store.saved = `${long}\n\n${LIST}`;
    api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
    await openStudio(page);
    await page.locator('#bs-select').click();
    await page.locator('#bs-editor .bmsme-block', { hasText: 'Start of it' }).click();
    await input(page).fill('Shorter please');
    await input(page).press('Enter');
    await expect(page.getByText('Noted.')).toBeVisible();
    const sent = api.called('chat-orchestrator')[0].body as { message: string };
    expect(sent.message).toContain('The very end.');
    expect(pageErrors).toEqual([]);
});

test('a Revise card pressed beside the open article: saved first, locked, reloaded — and never overwritten', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const store = stubArticle(api);
    const REWRITTEN = '## A better article\n\nThe worker wrote this.';
    const queued: unknown[] = [];
    let finish = false;
    api.set('generate-blog', (route, body) => {
        if (route.request().method() === 'POST') { queued.push({ body, savedAtQueue: store.saved }); return { jobId: 'j1' }; }
        if (!finish) return { status: 'processing' };
        store.saved = REWRITTEN;
        return { status: 'completed' };
    });
    api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement: {
        type: 'blog_action_proposal', action: 'revise', postId: POST_ID, title: 'Fresh beans', status: 'draft', instruction: 'Make it punchier', timezone: 'Europe/London',
    } } });
    await openStudio(page);

    await input(page).fill('Make it punchier');
    await input(page).press('Enter');
    await page.getByRole('button', { name: 'Rewrite it' }).click();

    // Locked while the worker writes: a click can't start typing over it.
    await expect.poll(() => page.locator('#bs-editor').evaluate((e) => (e as HTMLElement).style.pointerEvents)).toBe('none');
    await expect.poll(() => queued.length).toBe(1);
    finish = true;

    await expect(page.locator('#bs-editor')).toContainText('The worker wrote this.', { timeout: 15000 });
    await expect.poll(() => page.locator('#bs-editor').evaluate((e) => (e as HTMLElement).style.pointerEvents)).toBe('');
    await expect(page.getByText('It’s in the article beside this chat.', { exact: false })).toBeVisible();
    // Past the editor's autosave delay and on closing: the rewrite is still what is stored.
    await page.waitForTimeout(1600);
    expect(store.saved).toBe(REWRITTEN);
    await page.evaluate(() => (window as unknown as { closeBlogStudio(): void }).closeBlogStudio());
    await page.waitForTimeout(200);
    expect(store.saved).toBe(REWRITTEN);
    expect(pageErrors).toEqual([]);
});

test('a block edit waits while a rewrite is running', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const store = stubArticle(api);
    api.set('generate-blog', (route) => (route.request().method() === 'POST' ? { jobId: 'j2' } : { status: 'processing' }));
    let turn = 0;
    api.set('chat-orchestrator', () => {
        turn++;
        return { chatSessionId: 9, message: { id: turn, role: 'assistant', content: `Reply ${turn}.`, uiElement: turn === 1
            ? { type: 'blog_block_edit', postId: POST_ID, find: PARAGRAPH, replace: 'Changed.', summary: 'A change.' }
            : { type: 'blog_action_proposal', action: 'revise', postId: POST_ID, title: 'Fresh beans', status: 'draft', instruction: 'Punchier', timezone: 'Europe/London' } } };
    });
    await openStudio(page);
    await input(page).fill('first');
    await input(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Use this' })).toBeVisible();
    await input(page).fill('second');
    await input(page).press('Enter');
    await page.getByRole('button', { name: 'Rewrite it' }).click();
    await expect.poll(() => page.locator('#bs-editor').evaluate((e) => (e as HTMLElement).style.pointerEvents)).toBe('none');
    await page.getByRole('button', { name: 'Use this' }).click();
    await expect(page.getByText('still working on this article', { exact: false })).toBeVisible();
    expect(store.saved).toBe(BODY);
    expect(pageErrors).toEqual([]);
});

test('a live article: the card says plainly that the change is live', async ({ page, api, pageErrors }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    stubArticle(api, 'published');
    api.set('chat-orchestrator', { chatSessionId: 9, message: { id: 1, role: 'assistant', content: 'Here.', uiElement: {
        type: 'blog_block_edit', postId: POST_ID, find: PARAGRAPH, replace: 'Changed.', summary: 'A change.',
    } } });
    await openStudio(page);
    await input(page).fill('Change it');
    await input(page).press('Enter');
    await page.getByRole('button', { name: 'Use this' }).click();
    await expect(page.getByText('live on your blog now', { exact: false })).toBeVisible();
    expect(pageErrors).toEqual([]);
});
