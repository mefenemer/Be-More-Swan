// src/utils/meta-accounts.ts
// The account choice behind the Meta (Facebook / Instagram) OAuth flow.
//
// A Meta login can hand back several Pages, each of which may carry an Instagram business account.
// Which one a workspace got used to be decided by array order — the first Page with a linked
// Instagram, or `?? pageList[0]` for Facebook. That is how org 37 silently moved from one Instagram
// account to another on a routine reconnect: Meta returned the Pages in a different order, and
// publishing then failed with `(#10) Application does not have permission for this action`, which
// reads as an App Review problem and sends you to the Meta dashboard instead of here.
//
// Everything in this module is pure — no db, no vault, no network — so the ordering, the escaping
// and the handle signing can all be tested directly (tests/meta-account-picker.test.ts). The flow
// that uses it lives in netlify/functions/meta-oauth.ts.

import { createHmac } from 'crypto';

/** A Page as returned by /me/accounts (and the business-portfolio fallback). */
export type IgPage = { id: string; name?: string; instagram_business_account?: { id: string; username?: string } };

/** One connectable account, as offered in the picker and keyed on the row's external_user_id. */
export type MetaAccount = {
    externalUserId: string;   // instagram: the linked IG business account id — facebook: the Page id
    fbPageId: string;
    pageName: string | null;
    igUsername: string | null;
};

/** A choice parked in the vault between the OAuth callback and the user picking an account. */
export type PendingConnect = {
    token: string;
    fbUserId: string | null;
    organisationId: number;
    userId: number | null;
    assistantId: number | null;
    platform: 'instagram' | 'facebook';
    accounts: MetaAccount[];
    createdAt: number;
};

/** How long a parked choice stays usable. Long enough to read the page, short enough to matter. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The accounts this login can connect for `platform`, in the order they are offered.
 *
 * Instagram requires a linked instagram_business_account (only Business/Creator accounts can be
 * linked to a Page, so the presence of the link IS the account-type check). Facebook accepts any
 * Page but lists the ones that also carry an Instagram account first, preserving the old default
 * that Facebook and Instagram land on the same Page. Deduped on externalUserId: two Pages can
 * surface the same Instagram account, and offering it twice is a choice between identical options.
 */
export function accountsFor(platform: 'instagram' | 'facebook', pageList: IgPage[]): MetaAccount[] {
    const linkedFirst = [...pageList].sort((a, b) =>
        Number(Boolean(b.instagram_business_account?.id)) - Number(Boolean(a.instagram_business_account?.id)));
    const seen = new Set<string>();
    const accounts: MetaAccount[] = [];
    for (const page of linkedFirst) {
        const ig = page.instagram_business_account;
        if (platform === 'instagram' && !ig?.id) continue;
        const externalUserId = platform === 'instagram' ? ig!.id : page.id;
        if (seen.has(externalUserId)) continue;
        seen.add(externalUserId);
        accounts.push({ externalUserId, fbPageId: page.id, pageName: page.name ?? null, igUsername: ig?.username ?? null });
    }
    return accounts;
}

// ── The hand-off between the two requests ─────────────────────────────────────────────────────
// Choosing takes a second request, and between the two the long-lived token has to live somewhere.
// It goes in the vault — encrypted, like every other token — under a single-use key, and the
// browser carries only an opaque signed handle. Neither the token nor the account list ever travels
// in a URL.

/** Vault key for a parked choice. Inside the org prefix, so org-wide revocation sweeps it too. */
export function pendingRefKey(organisationId: number, userId: number, nonce: string): string {
    return `aura/org-${organisationId}/meta-pending-u${userId}-${nonce}`;
}

export function signPickerHandle(secret: string, organisationId: number, userId: number, nonce: string): string {
    const body = `${organisationId}.${userId}.${nonce}`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Verify a handle and recover the vault key it points at. Null on anything malformed or tampered:
 * the handle is what lets `select` find a token, so a forged one must never resolve to a key.
 */
export function parsePickerHandle(
    secret: string,
    handle: string | undefined | null,
): { organisationId: number; userId: number; nonce: string } | null {
    const parts = (handle ?? '').split('.');
    if (parts.length !== 4) return null;
    const [org, uid, nonce, mac] = parts;
    if (!/^\d+$/.test(org) || !/^\d+$/.test(uid) || !/^[a-f0-9]{64}$/.test(nonce)) return null;
    if (createHmac('sha256', secret).update(`${org}.${uid}.${nonce}`).digest('hex') !== mac) return null;
    return { organisationId: parseInt(org), userId: parseInt(uid), nonce };
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * The picker itself. Page and account names come from Meta, so every one of them is escaped. No
 * script and no external asset — a plain form, which is also why it renders before any of the app
 * has loaded. The account already connected is badged and pre-selected: a reconnect should default
 * to keeping the workspace where it is, never to whatever Meta happened to list first.
 */
export function renderAccountPicker(opts: {
    handle: string;
    platform: 'instagram' | 'facebook';
    accounts: MetaAccount[];
    connectedIds: string[];
    cancelUrl: string;
}): string {
    const { handle, platform, accounts, connectedIds, cancelUrl } = opts;
    const label = platform === 'instagram' ? 'Instagram' : 'Facebook';
    const preselect = accounts.find(a => connectedIds.includes(a.externalUserId)) ?? accounts[0];

    const options = accounts.map(account => {
        const isConnected = connectedIds.includes(account.externalUserId);
        const title = platform === 'instagram'
            ? `@${account.igUsername ?? account.externalUserId}`
            : (account.pageName ?? `Page ${account.fbPageId}`);
        const detail = platform === 'instagram'
            ? `via ${account.pageName ?? 'a Facebook Page'}`
            : (account.igUsername ? `Instagram @${account.igUsername} is linked` : 'No Instagram account linked');
        return `      <label class="opt${isConnected ? ' opt-current' : ''}">
        <input type="radio" name="account" value="${escapeHtml(account.externalUserId)}"${account.externalUserId === preselect.externalUserId ? ' checked' : ''}>
        <span class="opt-body">
          <span class="opt-title">${escapeHtml(title)}${isConnected ? '<span class="badge">Currently connected</span>' : ''}</span>
          <span class="opt-detail">${escapeHtml(detail)}</span>
        </span>
      </label>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose an account — Be More Swan</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;color:#111827}
.card{background:#fff;border-radius:1rem;padding:2rem;max-width:32rem;width:calc(100% - 2rem);box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.15rem;margin:0 0 .5rem}
.sub{color:#6b7280;font-size:.875rem;margin:0 0 1.25rem;line-height:1.5}
.opt{display:flex;gap:.75rem;align-items:flex-start;padding:.875rem;border:1px solid #e5e7eb;border-radius:.625rem;margin-bottom:.625rem;cursor:pointer}
.opt:hover{border-color:#d1d5db;background:#fafafa}
.opt-current{border-color:#c7d2fe;background:#f5f7ff}
.opt input{margin-top:.2rem;flex:none}
.opt-body{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.opt-title{font-weight:600;font-size:.9rem;word-break:break-word}
.opt-detail{color:#6b7280;font-size:.8rem;word-break:break-word}
.badge{display:inline-block;margin-left:.5rem;padding:.05rem .4rem;border-radius:.25rem;background:#e0e7ff;color:#3730a3;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;vertical-align:middle}
button{width:100%;margin-top:.75rem;padding:.7rem 1rem;border:0;border-radius:.625rem;background:#111827;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer}
button:hover{background:#000}
.cancel{display:block;text-align:center;margin-top:.875rem;color:#6b7280;font-size:.8rem}
</style></head>
<body>
  <form class="card" method="POST" action="/.netlify/functions/meta-oauth?action=select">
    <input type="hidden" name="h" value="${escapeHtml(handle)}">
    <h1>Which ${label} account should this workspace use?</h1>
    <p class="sub">Your Meta login gives Be More Swan access to more than one. Posts, insights and scheduling all use the account you pick here — you can change it later by connecting again.</p>
${options}
    <button type="submit">Connect this account</button>
    <a class="cancel" href="${escapeHtml(cancelUrl)}">Cancel — leave my connections as they are</a>
  </form>
</body>
</html>`;
}
