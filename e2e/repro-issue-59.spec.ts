// Issue #59: a "new reply on your ticket" notification's "View ticket" button opened Help & Support but
// not the ticket. The conversation box sat under the whole "Your requests" list and was scrolled to
// while that list was still loading; the list then filled in above it and pushed the conversation off
// screen, so the user had to scroll through every request to find it. It now opens under its own row,
// after the list has loaded, and that row is brought into view.

import { test, expect, openWorkspace } from './fixtures';

test.use({ viewport: { width: 1280, height: 720 } });

test('"View ticket" opens that ticket on screen, however long the list', async ({ page, api, signedIn, pageErrors }) => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, 14 - n)).toISOString();
    const tickets = Array.from({ length: 12 }, (_, i) => ({
        id: 200 + i, subject: `Question number ${i + 1}`, category: 'general', status: 'open', createdAt: day(i),
    }));
    // The ticket the reply is on is the oldest, so it is drawn last.
    const target = tickets[tickets.length - 1];
    api.set('support-tickets', async (route) => {
        const url = new URL(route.request().url());
        const id = url.searchParams.get('ticketId');
        if (id) {
            return { ticket: { ...target, id: Number(id), description: 'The words I first wrote.' }, replies: [
                { id: 1, body: 'A reply from the team about this exact question.', fromTeam: true, createdAt: day(0) },
            ] };
        }
        // The list takes a moment, as it does on the live site.
        await new Promise((r) => setTimeout(r, 400));
        return tickets;
    });
    api.set('issue-reports', { issues: [] });

    await openWorkspace(page);
    await page.evaluate((id) => (window as any).routeToSupportTicket(id), target.id);

    const thread = page.locator('#ticket-thread');
    await expect(thread).toContainText('A reply from the team about this exact question.');
    await expect(page.locator(`#ri-my-list [data-ticket-id="${target.id}"]`)).toBeAttached();
    // Give the list time to land, then the conversation must still be on screen.
    await page.waitForTimeout(800);
    await expect(thread).toBeInViewport();
    expect(pageErrors).toEqual([]);
});
