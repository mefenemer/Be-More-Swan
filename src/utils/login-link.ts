// src/utils/login-link.ts
//
// Lets a login link work without a "Log me in" click, without letting an email scanner spend it.
//
// Outlook / Hotmail Safe Links opens links before the person does and runs the page's script, so
// the page can't use the single-use token just because it loaded (prod user 39, 2026-10-27). What a
// scanner can't have is a cookie from the browser that asked for the link. So:
//
//   • Asking for a link sets `bms_login_browser` (random, HttpOnly), and the emailed link carries
//     `b`, a signature over that cookie and the token. verify.ts logs in on page load only when
//     the two match. Anywhere else (a phone, another browser, a scanner) gets a Continue button.
//   • The link also carries `r`, a signed account reference. It outlives the token, so a used or
//     expired link can offer "Email me a new link" without asking for the address again. All it can
//     do is send a link to the account's own inbox, and never logs anyone in.
//
// Both are signed rather than stored. A new `users` column would break every `db.select()` on that
// table until its SQL was applied by hand.
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';

export const LOGIN_BROWSER_COOKIE = 'bms_login_browser';
const LOGIN_BROWSER_MAX_AGE_SECS = 24 * 60 * 60; // the longest a login link lasts (24 h)

function sign(label: string, value: string): string | null {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    return crypto.createHmac('sha256', secret).update(`${label}:${value}`).digest('hex');
}

function sameText(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
    for (const part of (cookieHeader || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

function readBrowserValue(cookieHeader: string | undefined): string | null {
    const value = readCookie(cookieHeader, LOGIN_BROWSER_COOKIE);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/**
 * The value for this browser, and the header that keeps it. Send the header on EVERY answer to a
 * request for a link, whether or not an account exists, so the response never reveals which. An
 * existing value is kept: replacing it would stop an earlier link working in this same browser when
 * a second request was rate-limited and no new link went out.
 */
export function loginBrowserCookie(cookieHeader: string | undefined): { value: string; setCookie: string } {
    const value = readBrowserValue(cookieHeader) || crypto.randomBytes(32).toString('hex');
    return {
        value,
        setCookie: `${LOGIN_BROWSER_COOKIE}=${value}; Path=/.netlify/functions; Secure; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_BROWSER_MAX_AGE_SECS}`,
    };
}

/** Query string to append after `?token=…`. `browser` is left out of links nobody asked for. */
export function loginLinkParams(opts: { plainToken: string; userId: number; browser?: string }): string {
    const ref = sign('login-ref', String(opts.userId));
    const proof = opts.browser ? sign('login-browser', `${opts.browser}:${opts.plainToken}`) : null;
    return `${ref ? `&r=${opts.userId}.${ref}` : ''}${proof ? `&b=${proof}` : ''}`;
}

/** True only for the browser that asked for this token. */
export function isSameLoginBrowser(cookieHeader: string | undefined, plainToken: string, proof: unknown): boolean {
    if (typeof proof !== 'string' || !proof) return false;
    const browser = readBrowserValue(cookieHeader);
    if (!browser) return false;
    const expected = sign('login-browser', `${browser}:${plainToken}`);
    return !!expected && sameText(expected, proof);
}

/** The account a link belongs to, from its signed `r` value. Null if missing or tampered with. */
export function readLoginRef(ref: unknown): number | null {
    if (typeof ref !== 'string') return null;
    const match = /^(\d{1,12})\.([a-f0-9]{64})$/.exec(ref);
    if (!match) return null;
    const expected = sign('login-ref', match[1]);
    return expected && sameText(expected, match[2]) ? Number(match[1]) : null;
}

/** Who this browser is already logged in as, if anyone. */
export function sessionUserId(cookieHeader: string | undefined): number | null {
    const secret = process.env.JWT_SECRET;
    const session = readCookie(cookieHeader, 'aura_session');
    if (!secret || !session) return null;
    try {
        const { userId } = jwt.verify(session, secret) as { userId?: unknown };
        return typeof userId === 'number' ? userId : null;
    } catch {
        return null;
    }
}

/** "catherine@hotmail.co.uk" → "c•••@hotmail.co.uk". Enough to recognise, for anyone holding the link. */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf('@');
    return at < 1 ? '•••' : `${email[0]}•••${email.slice(at)}`;
}
