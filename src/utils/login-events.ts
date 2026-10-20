// src/utils/login-events.ts
// The one writer for login_events: a row each time a session cookie is issued to someone signing in.
// See db/z-login-events.sql.
//
// ⚠️ NEVER BLOCKS A LOGIN. The table is applied by hand, so it may not exist yet; any failure here
// is logged and swallowed. A login that went through but was not recorded is fine; a login refused
// because of the audit trail is not.
//
// ⚠️ IP IS TRUNCATED, never stored whole: the privacy policy promises sign-in records keep only the
// /24 (IPv4) or first 64 bits (IPv6). See src/utils/ip-pseudonymise.ts.

import { loginEvents } from '../../db/schema';
import { getClientIp } from './rate-limit';
import { pseudonymiseIp } from './ip-pseudonymise';

export type LoginMethod = 'magic_link' | 'review_login' | 'invite';

export async function recordLogin(
    db: any,
    opts: {
        userId: number;
        organisationId?: number | null;
        method: LoginMethod;
        headers?: Record<string, string | undefined>;
    },
): Promise<void> {
    try {
        const headers = opts.headers || {};
        const ip = pseudonymiseIp(getClientIp(headers));
        const userAgent = headers['user-agent'];
        await db.insert(loginEvents).values({
            userId: opts.userId,
            organisationId: opts.organisationId ?? null,
            method: opts.method,
            ip,
            userAgent: userAgent ? userAgent.slice(0, 500) : null,
        });
    } catch (err) {
        console.warn('[login-events] could not record login (non-blocking)', { userId: opts.userId, method: opts.method, err });
    }
}
