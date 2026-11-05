// The Email Studio's docked chat (owner, 2026-11-05: the Website tab's chat pane, for the Email Marketing
// assistant): the email on the left, the chat on the right, "Select" putting a part of it into the chat, and
// cards that change it. The real workspace; every function is stubbed, with one `saved` email behind them.

import { test, expect, openWorkspace, type ApiStub } from './fixtures';
import type { Page } from '@playwright/test';

const design = () => ({ version: 1, template: 'custom', theme: {}, blocks: [
    { id: 'b1', type: 'heading', text: 'Summer update', level: 2, align: 'left' },
    { id: 'b2', type: 'text', markdown: 'Our new roast is here.\nIt sold out last time.', align: 'left' },
    { id: 'b3', type: 'image', assetId: null, baseAssetId: null, alt: '', href: '', align: 'center', width: 100, overlays: [] },
    { id: 'b4', type: 'button', label: 'Read more', href: 'https://example.com/roast', align: 'center', background: '#111111', color: '#ffffff' },
] });

function stubEmail(api: ApiStub, opts: { designed?: boolean; status?: string; roleKey?: string } = {}) {
    const store = {
        issue: {
            id: 31, assistantId: 9, subject: 'Our summer roast', preheader: 'Back in stock', bodyMarkdown: 'Our new roast is here.\n\nIt sold out last time.',
            status: opts.status ?? 'draft', purpose: 'newsletter', design: opts.designed === false ? null : design(), segmentId: null, renderedPayload: null,
        } as Record<string, unknown>,
        updates: [] as Record<string, unknown>[],
        refines: [] as Record<string, unknown>[],
        approves: [] as { savedSubject: unknown }[],
    };
    api.set('get-assistants', { assistants: [{ id: 9, name: 'Nell', role: 'Email Marketing', roleKey: opts.roleKey ?? 'newsletter_editor', isActive: true, status: 'active' }] });
    api.set('newsletter-issues', (route, body) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET') {
            if (url.searchParams.get('id')) return { issue: store.issue, audienceEstimate: 0, links: [], deliverability: null };
            return { issues: [store.issue], segments: [], customFields: [], purposes: [], templates: [] };
        }
        const b = body as Record<string, unknown>;
        if (b.action === 'update') {
            store.updates.push(b);
            const { action: _a, ...fields } = b;
            store.issue = { ...store.issue, ...fields };
            return { issue: store.issue };
        }
        if (b.action === 'refine') { store.refines.push(b); return { subject: 'Better', preheader: '', bodyMarkdown: 'A new version.', summary: 'Tighter.' }; }
        if (b.action === 'approve') { store.approves.push({ savedSubject: store.issue.subject }); store.issue = { ...store.issue, status: 'approved' }; return { issue: store.issue }; }
        return {};
    });
    return store;
}

async function openEmail(page: Page) {
    await openWorkspace(page);
    await page.evaluate(() => { (window as any)._newsletterInitialIssueId = 31; (window as any).loadView('newsletter'); });
    await expect(page.locator('#nl-editor')).toBeVisible();
    await expect(page.locator('#nl-chat-toggle')).toBeVisible();
}

const input = (page: Page) => page.locator('#nl-chat-host [data-chat-input]');
const block = (page: Page, id: string) => page.locator(`#nl-design-host [data-nld-block="${id}"]`);
const sent = (api: ApiStub, i = 0) => api.called('chat-orchestrator')[i].body as { message: string; forIssueId?: number };
const reply = (api: ApiStub, uiElement: unknown) => api.set('chat-orchestrator', { chatSessionId: 5, message: { id: 1, role: 'assistant', content: 'A card is ready.', uiElement } });
async function ask(page: Page, text: string) { await input(page).fill(text); await input(page).press('Enter'); }

test.describe('wide screen', () => {
    test.use({ viewport: { width: 1600, height: 950 } });

    test('the email on the left, the chat docked on the right; "All emails" brings the list back', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        await openEmail(page);
        await expect(input(page)).toBeVisible();
        const email = await page.locator('#nl-editor').boundingBox();
        const box = await input(page).boundingBox();
        expect(email!.x + email!.width).toBeLessThanOrEqual(box!.x);
        await expect(page.locator('#nl-list-col')).toBeHidden();      // the email gets the room
        await page.screenshot({ path: 'test-results/email-studio-chat.png' });
        await page.locator('#nl-all-emails').click();
        await expect(page.locator('#nl-list-col')).toBeVisible();
        await expect(input(page)).toBeHidden();
        expect(await page.evaluate(() => localStorage.getItem('bms-email-chat-on'))).not.toBe('0');   // not a lasting choice
        expect(pageErrors).toEqual([]);
    });

    test('Select stays on screen, down in the body of a long email', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        await openEmail(page);
        await page.locator('#nl-sendmode').scrollIntoViewIfNeeded();
        const bar = await page.locator('#nl-select').boundingBox();
        expect(bar!.y).toBeGreaterThanOrEqual(64);
        expect(bar!.y).toBeLessThan(950);
        await page.locator('#nl-select').click();
        await expect(page.locator('#nl-select')).toHaveAttribute('aria-pressed', 'true');
        expect(pageErrors).toEqual([]);
    });

    test('every turn says which email it is about', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        api.set('chat-orchestrator', { chatSessionId: 5, message: { id: 1, role: 'assistant', content: 'Noted.', uiElement: null } });
        await openEmail(page);
        await ask(page, 'Is this any good?');
        await expect(page.getByText('Noted.')).toBeVisible();
        expect(sent(api).forIssueId).toBe(31);
        expect(pageErrors).toEqual([]);
    });

    test('Select a paragraph: the whole of it reaches the assistant, and "Use this" changes and saves only that', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_edit', issueId: 31, part: 'block', find: 'Our new roast is here. It sold out last time.', replace: 'Our new roast is back.', summary: 'Tighter.' });
        await openEmail(page);
        await page.locator('#nl-select').click();
        await block(page, 'b2').click();
        await expect(page.locator('#nl-select')).toHaveAttribute('aria-pressed', 'false');
        await ask(page, 'Shorter');
        await expect(page.getByRole('button', { name: 'Use this' })).toBeVisible();
        expect(sent(api).message).toContain('the paragraph “Our new roast is here.\nIt sold out last time.”');
        await page.screenshot({ path: 'test-results/email-studio-chat-card.png' });
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.getByText('Done.', { exact: true })).toBeVisible();
        await expect(block(page, 'b2')).toContainText('Our new roast is back.');
        const saved = store.issue.design as { blocks: { id: string; markdown?: string; text?: string }[] };
        expect(saved.blocks.find((b) => b.id === 'b2')!.markdown).toBe('Our new roast is back.');
        expect(saved.blocks.find((b) => b.id === 'b1')!.text).toBe('Summer update');
        expect(pageErrors).toEqual([]);
    });

    test('Select the subject: the field does not open for typing, and the card changes and saves it', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_edit', issueId: 31, part: 'subject', find: 'Our summer roast', replace: 'It’s back: our summer roast', summary: 'A stronger subject.' });
        await openEmail(page);
        await page.locator('#nl-select').click();
        await page.locator('#nl-subject').click();
        expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('nl-subject');
        await ask(page, 'Stronger');
        expect(sent(api).message).toContain('the subject line “Our summer roast”');
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.locator('#nl-subject')).toHaveValue('It’s back: our summer roast');
        await expect.poll(() => store.issue.subject).toBe('It’s back: our summer roast');
        expect(pageErrors).toEqual([]);
    });

    test('a part changed since the card was written: nothing happens', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_edit', issueId: 31, part: 'block', find: 'Words that are not there', replace: 'New.', summary: 'A change.' });
        await openEmail(page);
        await ask(page, 'Change it');
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.getByText('changed since', { exact: false })).toBeVisible();
        expect(store.updates).toHaveLength(0);
        expect(pageErrors).toEqual([]);
    });

    test('"add a button here" goes after the selected part, with no link', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_block_add', issueId: 31, kind: 'button', text: 'Order now', summary: 'Adds a button.' });
        await openEmail(page);
        await page.locator('#nl-select').click();
        await block(page, 'b1').click();
        await ask(page, 'Add a button here');
        await page.getByRole('button', { name: 'Add the button' }).click();
        await expect(page.getByText('Now give it a link', { exact: false })).toBeVisible();
        const saved = store.issue.design as { blocks: { id: string; type: string; label?: string; href?: string }[] };
        expect(saved.blocks[0].id).toBe('b1');
        expect(saved.blocks[1].label).toBe('Order now');
        expect(saved.blocks[1].href).toBe('');
        expect(pageErrors).toEqual([]);
    });

    test('Select the picture → the card opens the library for that block; without a selection it says what to do', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        reply(api, { type: 'email_picture', issueId: 31 });
        api.set('content-assets', { assets: {} });
        await openEmail(page);
        await ask(page, 'A different picture');
        await page.getByRole('button', { name: 'Choose a picture' }).click();
        await expect(page.getByText('click the picture first', { exact: false })).toBeVisible();
        await page.locator('#nl-select').click();
        await block(page, 'b3').click();
        await page.getByRole('button', { name: 'Choose a picture' }).click();
        await expect(page.locator('.nld-pick')).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('the whole email: the card puts the new version under it, unchanged until they press "Use it"', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_refine', issueId: 31, instruction: 'Make it shorter', summary: 'A shorter version.' });
        await openEmail(page);
        await ask(page, 'Make it shorter');
        await page.getByRole('button', { name: 'Write the new version' }).click();
        await expect(page.locator('#nl-rev-keep')).toBeVisible();
        expect(store.refines[0].instruction).toBe('Make it shorter');
        expect(store.issue.bodyMarkdown).not.toBe('A new version.');
        expect(pageErrors).toEqual([]);
    });

    test('approve from a card: unsaved words land first, and the page then shows it approved', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api);
        reply(api, { type: 'email_action_proposal', action: 'approve', issueId: 31, subject: 'Our summer roast', status: 'draft' });
        await openEmail(page);
        await ask(page, 'Approve it');
        const go = page.locator('#nl-chat-host button').filter({ hasText: /^Approve/ }).first();
        await expect(go).toBeVisible();
        await page.locator('#nl-subject').fill('Typed just now');
        await go.click();
        await expect.poll(() => store.approves.length).toBe(1);
        expect(store.approves[0].savedSubject).toBe('Typed just now');
        await expect(page.locator('#nl-status')).not.toHaveText('Draft');
        expect(pageErrors).toEqual([]);
    });

    test('a plain-text email: the card changes one place, and adding a button says what to do first', async ({ page, api, signedIn: _s, pageErrors }) => {
        const store = stubEmail(api, { designed: false });
        let turn = 0;
        api.set('chat-orchestrator', () => {
            turn++;
            return { chatSessionId: 5, message: { id: turn, role: 'assistant', content: `Reply ${turn}.`, uiElement: turn === 1
                ? { type: 'email_edit', issueId: 31, part: 'block', find: 'It sold out last time.', replace: 'It sold out in a week.', summary: 'A change.' }
                : { type: 'email_block_add', issueId: 31, kind: 'button', text: 'Order now', summary: 'A button.' } } };
        });
        await openEmail(page);
        await ask(page, 'Change that');
        await page.getByRole('button', { name: 'Use this' }).click();
        await expect(page.locator('#nl-body')).toHaveValue('Our new roast is here.\n\nIt sold out in a week.');
        await expect.poll(() => store.issue.bodyMarkdown).toBe('Our new roast is here.\n\nIt sold out in a week.');
        await ask(page, 'Add a button');
        await page.getByRole('button', { name: 'Add the button' }).click();
        await expect(page.getByText('This email is plain text', { exact: false })).toBeVisible();
        expect(pageErrors).toEqual([]);
    });

    test('an email that has gone out: the chat is there, but nothing to select', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api, { status: 'sent' });
        await openEmail(page);
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#nl-select')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('very wide screen', () => {
    test.use({ viewport: { width: 1900, height: 1000 } });

    test('room for the list as well', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        await openEmail(page);
        await expect(input(page)).toBeVisible();
        await expect(page.locator('#nl-list-col')).toBeVisible();
        await expect(page.locator('#nl-all-emails')).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('narrow screens', () => {
    test.use({ viewport: { width: 1100, height: 850 } });

    test('off by default; opens over the right edge; steps aside for Select; the ✕ closes it', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        await openEmail(page);
        await expect(input(page)).toBeHidden();
        await page.locator('#nl-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(1100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/email-studio-chat-narrow.png' });
        await page.locator('#nl-select').click();
        await expect(input(page)).toBeHidden();
        await block(page, 'b1').click();
        await expect(input(page)).toBeVisible();
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});

test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test('the chat fills the width, and the ✕ gets back to the email', async ({ page, api, signedIn: _s, pageErrors }) => {
        stubEmail(api);
        await openEmail(page);
        await page.locator('#nl-chat-toggle').scrollIntoViewIfNeeded();
        await page.locator('#nl-chat-toggle').click();
        await expect(input(page)).toBeVisible();
        const box = await input(page).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: 'test-results/email-studio-chat-phone.png' });
        await page.getByRole('button', { name: 'Close the chat' }).click();
        await expect(input(page)).toBeHidden();
        expect(pageErrors).toEqual([]);
    });
});
