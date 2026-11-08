// Inviting a teammate chooses which assistants they can use, not every one by default
// (src/utils/assistant-access.ts, db/z-member-assistant-access.sql). Business Information ▸ Team Members.

import { test, expect, openWorkspace } from './fixtures';

const ASSISTANTS = [{ id: 11, name: 'Sam' }, { id: 12, name: 'Jo' }, { id: 13, name: 'Max' }];
const MEMBERS = [
    { membershipId: 1, userId: 1, role: 'owner', assistantIds: null, joinedAt: '2026-10-01T10:00:00Z', firstName: 'Olive', lastName: 'Owner', email: 'olive@example.test' },
    { membershipId: 2, userId: 2, role: 'member', assistantIds: [12], joinedAt: '2026-10-02T10:00:00Z', firstName: 'Mo', lastName: null, email: 'mo@example.test' },
];

test.beforeEach(async ({ api }) => {
    api.set('manage-members', (route, body) => {
        if (route.request().method() === 'GET') {
            return { members: MEMBERS, assistants: ASSISTANTS, seatCount: 2, seatLimit: null, collaboration: true, canInvite: true };
        }
        return { success: true, ...(body as object) };
    });
    api.set('invite-member', { success: true, directAdd: false, message: 'Invitation sent.' });
});

test('the invite form asks which assistants, sends only those, and admins skip it', async ({ page, api, signedIn, pageErrors }) => {
    await openWorkspace(page, 'assets');
    await page.locator('.bizinfo-tab[data-tab="team"]').click();
    // The table shows each person's assistants.
    await expect(page.locator('#member-list-body tr').nth(0)).toContainText('All');
    await expect(page.locator('#member-list-body tr').nth(1)).toContainText('Jo');

    await page.locator('#invite-member-btn').click();
    const modal = page.locator('#invite-modal');
    await expect(modal.getByText('Assistants they can use')).toBeVisible();
    // Nothing is ticked: the owner chooses.
    await expect(modal.locator('#invite-assistants input:checked')).toHaveCount(0);

    await modal.locator('#invite-email').fill('new@example.test');
    await modal.locator('#invite-submit-btn').click();
    await expect(modal.getByText('Choose at least one assistant')).toBeVisible();
    expect(api.called('invite-member')).toHaveLength(0);

    await modal.getByLabel('Sam').check();
    await modal.getByLabel('Max').check();
    await modal.locator('#invite-submit-btn').click();
    await expect(modal).toBeHidden();
    expect(api.called('invite-member')[0].body).toEqual({ email: 'new@example.test', role: 'member', assistantIds: [11, 13] });

    // An admin can use every assistant, so the list goes away and nothing is sent.
    await page.locator('#invite-member-btn').click();
    await modal.locator('#invite-email').fill('boss@example.test');
    await modal.locator('#invite-role').selectOption('admin');
    await expect(modal.locator('#invite-assistants-wrap')).toBeHidden();
    await expect(modal.getByText('Admins can use every assistant.')).toBeVisible();
    await modal.locator('#invite-submit-btn').click();
    await expect(modal).toBeHidden();
    expect(api.called('invite-member')[1].body).toEqual({ email: 'boss@example.test', role: 'admin' });
    expect(pageErrors).toEqual([]);
});

test('Role and access changes which assistants a member has', async ({ page, api, signedIn, pageErrors }) => {
    await openWorkspace(page, 'assets');
    await page.locator('.bizinfo-tab[data-tab="team"]').click();
    await page.getByRole('button', { name: 'Role and access' }).click();
    const modal = page.locator('#role-modal');
    await expect(modal.getByLabel('Jo')).toBeChecked();
    await expect(modal.getByLabel('Sam')).not.toBeChecked();
    await modal.getByLabel('Sam').check();
    await modal.locator('#role-submit-btn').click();
    await expect(modal).toBeHidden();
    const patch = api.called('manage-members').find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('id=2');
    expect(patch.body).toEqual({ role: 'member', assistantIds: [11, 12] });
    expect(pageErrors).toEqual([]);
});
