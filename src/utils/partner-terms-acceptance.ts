// src/utils/partner-terms-acceptance.ts
// Partner Terms 1.2 (cross-border review 2026-11-23): every acceptance is kept — an append-only row in
// partner_terms_acceptances (db/z-partner-terms-cross-border.sql) — and the partner is emailed a copy: the
// version and a link to its frozen page, /partner-terms-v<version>.html, which stays on the site.
// partners.terms_version / terms_accepted_at keep saying what is current; this keeps the history.

import { partnerTermsAcceptances } from '../../db/schema';
import { PARTNER_TERMS_UPDATED, PARTNER_TERMS_VERSION } from '../config/partner-terms';
import { sendTemplatedEmail } from './email';

type Db = any;

export const frozenTermsPath = (version: string = PARTNER_TERMS_VERSION) => `/partner-terms-v${version}.html`;

export async function recordTermsAcceptance(db: Db, input: {
    partnerId: number; userId: number | null; applicantEmail?: string | null;
    channel: 'application' | 'partner_page'; email: string | null; firstName?: string | null;
}): Promise<void> {
    await db.insert(partnerTermsAcceptances).values({
        partnerId: input.partnerId, userId: input.userId, applicantEmail: input.applicantEmail ?? null,
        version: PARTNER_TERMS_VERSION, channel: input.channel,
    });
    if (!input.email) return;
    const base = (process.env.BASE_URL || 'https://bemoreswan.com').replace(/\/$/, '');
    await sendTemplatedEmail({
        triggerKey: 'partner_terms_accepted', to: input.email,
        vars: {
            user: { first_name: input.firstName || '' },
            partner: { terms_version: PARTNER_TERMS_VERSION, terms_updated: PARTNER_TERMS_UPDATED },
            link: { action_url: `${base}${frozenTermsPath()}` },
        },
    }).catch((err: unknown) => console.error('[partner-terms-acceptance] copy email failed (non-blocking):', err));
}
