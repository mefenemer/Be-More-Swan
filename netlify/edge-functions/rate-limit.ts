// netlify/edge-functions/rate-limit.ts
// US-GAP-7.1.1: In-memory edge-level rate limiting for sensitive endpoints.
// Uses a module-level Map so state persists across requests within the same isolate.
//
// Rules:
//   /.netlify/functions/register        → 5 req / 60s  per IP
//   /.netlify/functions/login           → 5 req / 60s  per IP
//   /.netlify/functions/onboarding      → 3 req / 60s  per userId (from JWT cookie)
//   /.netlify/functions/support-tickets → 10 req / 24h per userId (from JWT cookie)
//   /.netlify/functions/site-audit-public → 40 req / 60s per IP (coarse; real limits in the function)

import { Context } from "@netlify/edge-functions";

interface RateLimitEntry {
    count: number;
    windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

interface RuleConfig {
    maxAttempts: number;
    windowMs: number;
    keyType: 'ip' | 'userId';
}

const RULES: Record<string, RuleConfig> = {
    '/.netlify/functions/register':        { maxAttempts: 5,  windowMs: 60_000,       keyType: 'ip' },
    '/.netlify/functions/login':           { maxAttempts: 5,  windowMs: 60_000,       keyType: 'ip' },
    '/.netlify/functions/onboarding':      { maxAttempts: 3,  windowMs: 60_000,       keyType: 'userId' },
    '/.netlify/functions/support-tickets': { maxAttempts: 10, windowMs: 86_400_000,   keyType: 'userId' },
    // The Mystery Shopper's public taster. A COARSE shield only: it counts the result polls too
    // (one every few seconds while a check runs), so it is set well above that. The real limits —
    // 5 checks/hour per IP, 3/day per email, a daily cap — are enforced in site-audit-public.ts.
    '/.netlify/functions/site-audit-public': { maxAttempts: 40, windowMs: 60_000,      keyType: 'ip' },
};

function getUserIdFromCookie(cookieHeader: string | null): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        const parts = match[1].split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.userId ? String(payload.userId) : null;
    } catch {
        return null;
    }
}

function checkRateLimit(key: string, maxAttempts: number, windowMs: number): { allowed: boolean; retryAfterSecs: number } {
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
        rateLimitMap.set(key, { count: 1, windowStart: now });
        return { allowed: true, retryAfterSecs: 0 };
    }

    if (entry.count >= maxAttempts) {
        const retryAfterSecs = Math.ceil((entry.windowStart + windowMs - now) / 1000);
        return { allowed: false, retryAfterSecs };
    }

    entry.count++;
    return { allowed: true, retryAfterSecs: 0 };
}

export default async (request: Request, context: Context) => {
    if (request.method === 'OPTIONS') return context.next();

    const url = new URL(request.url);
    const rule = RULES[url.pathname];
    if (!rule) return context.next();

    let key: string;
    if (rule.keyType === 'ip') {
        const ip = context.ip || request.headers.get('x-forwarded-for') || 'unknown';
        key = `${url.pathname}:${ip}`;
    } else {
        const userId = getUserIdFromCookie(request.headers.get('cookie'));
        if (!userId) return context.next();
        key = `${url.pathname}:${userId}`;
    }

    const { allowed, retryAfterSecs } = checkRateLimit(key, rule.maxAttempts, rule.windowMs);
    if (allowed) return context.next();

    return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        {
            status: 429,
            headers: {
                'Content-Type': 'application/json',
                'Retry-After': String(retryAfterSecs),
            },
        }
    );
};
