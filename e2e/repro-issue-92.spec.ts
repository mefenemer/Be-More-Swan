// Issue #92: "The 'Help me write it' button isn't working in my Partner Assistant."
// The button sits in the invite page form; it sends a question to the Partner Assistant, whose chat is the
// next card down the page. Nothing brought the chat into view, so the question, "Working on it…" and the
// answer (12–14 s later on prod) all happened off screen: to the partner the button did nothing, and they
// pressed it again. Prod logs (2026-11-25 16:50–16:52) show each press answered by the model.
// Every button that asks the assistant from elsewhere on the page now scrolls the chat into view.

import { test, expect, openWorkspace } from './fixtures';

const hub = {
    partner: { status: 'approved', promoCode: 'KUDZU' },
    partnerSince: '2026-11-24T15:31:37Z',
    partnerTerms: { accepted: true, version: '1.3', updated: '23 November 2026' },
    link: { inviteUrl: 'https://bemoreswan.com/invite/ABC123', partnerCode: 'KUDZU' },
    stats: {}, terms: null, commissions: [], payout: {},
    invitePage: { state: null, live: null, pending: null },
};

for (const [label, viewport] of [['laptop', { width: 1280, height: 720 }], ['phone width', { width: 390, height: 844 }]] as const) test.describe(label, () => {
test.use({ viewport });
test('"Help me write it" on the invite page form shows the Partner Assistant answering', async ({ page, api, signedIn, pageErrors }) => {
    api.set('partner-hub', hub);
    api.set('partner-assistant', async () => {
        await new Promise((r) => setTimeout(r, 600));
        return { reply: 'Here is a headline and a line for your invite page — check they sound like you.', cards: [
            { kind: 'invite_page', headline: 'Why I use Be More Swan', quote: 'It helps me keep my social posts going.' },
        ] };
    });

    await openWorkspace(page, 'partner');
    const button = page.getByRole('button', { name: 'Help me write it' });
    await button.scrollIntoViewIfNeeded();
    await button.click();

    const answer = page.locator('#pa-log').getByText('Here is a headline and a line for your invite page');
    await expect(answer).toBeVisible();
    await expect(answer).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Put it in my invite page form' })).toBeInViewport();
    expect(pageErrors).toEqual([]);
});
});
