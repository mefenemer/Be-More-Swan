// src/utils/blog-linkedin-optin.ts
// After someone connects LinkedIn FROM the Blog Writer's LinkedIn card, switch the LinkedIn blog
// destination on for them. The card's only reason to start the sign-in is that destination, and
// before this the person landed back on a card still saying "Connect LinkedIn" and had to press it
// a second time (the 409 "connect first" path never saves the opt-in).
//
// Never fatal: the LinkedIn connection itself is already saved by the time this runs, and a
// failure here only means the card stays at "Not enabled" with its one-click switch.

import { connectSocialBlogDestination } from './blog-destinations/store';

export async function optInLinkedInBlogDestination(db: unknown, organisationId: number): Promise<void> {
    try {
        const res = await connectSocialBlogDestination(db as never, organisationId, 'linkedin');
        if (!res.ok) console.warn(`[blog-linkedin-optin] org ${organisationId}: ${res.error}`);
    } catch (err) {
        console.warn(`[blog-linkedin-optin] org ${organisationId}:`, (err as Error).message);
    }
}
