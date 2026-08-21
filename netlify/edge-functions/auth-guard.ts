/// <reference path="./types/deno.d.ts" />
import { Context } from "@netlify/edge-functions";
import * as jose from 'https://deno.land/x/jose@v5.2.3/index.ts';

/**
 * Every page on this site answers to TWO URLs. Netlify publishes the repo root, so admin.html is
 * served at both `/admin.html` and `/admin`, and the same goes for every other page.
 *
 * This guard used to reason entirely in the `.html` spelling: it early-returned on any path not
 * ending in `.html`, and its protected list held only `.html` entries. Deleting four characters
 * therefore walked straight past it — `/admin` returned the full 504KB admin page to anyone who
 * asked, unauthenticated, because admin.html carries no client-side auth-check.js either and this
 * function was its only guard.
 *
 * So: normalise first, compare second. `normalisePath` maps both spellings onto one key, and
 * every list below is written in that normalised form.
 */
const normalisePath = (pathname: string): string =>
    pathname === '/' ? '/' : pathname.replace(/\.html$/, '');

/**
 * Pages that require a valid session, normalised. MUST stay in step with the auth-guard
 * `[[edge_functions]]` bindings in netlify.toml: this function can only protect a path it is
 * actually invoked on, and a page listed here but not bound there is silently unprotected —
 * exactly the failure this file is fixing. tests/auth-guard-paths.test.ts fails on drift.
 */
export const PROTECTED_PATHS = ['/workspace', '/onboarding', '/dashboard', '/billing', '/admin'];

/** Reachable without a session — the pages you need in order to get one. */
const ALWAYS_ALLOWED = ['/maintenance', '/login', '/logout', '/check-email', '/register'];

/**
 * Hosts served by this deployment that are NOT the Be More Swan app.
 *
 * The Swan Index (netlify/functions/swan-index-page.ts) is a separate public publication answered
 * by the same Netlify site via the host-scoped rewrites in netlify.toml. This guard is bound to
 * `path = "/"`, and a Netlify edge binding is host-agnostic — so the magazine's front page lands
 * here too, on a function that exists to gate an application it is not part of.
 *
 * That is not merely wasted work, though it is that: every front-page hit would pay a round trip
 * to platform-config-public before rendering. The failure that matters is maintenance mode. Turning
 * it on to deploy the app would redirect theswanindex.com to /maintenance and take a public
 * magazine, with third-party authors' bylines on it, offline for a reason that has nothing to do
 * with the magazine.
 *
 * Matched on hostname, not on path: the publication owns every path on its own domain, including
 * ones that collide with app pages.
 */
const NON_APP_HOSTS = ['theswanindex.com', 'www.theswanindex.com'];

export default async (request: Request, context: Context) => {
    const url = new URL(request.url);
    const path = normalisePath(url.pathname);

    // Not the app — see NON_APP_HOSTS. Must be the first thing checked, before any config fetch.
    if (NON_APP_HOSTS.includes(url.hostname.toLowerCase())) {
        return context.next();
    }

    // Skip assets. The netlify.toml bindings mean little else reaches this function, but a
    // request for /style.css or /images/hero.webp must never reach the config fetch below —
    // that would put a network round trip in front of every static file on the site.
    const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    if (lastSegment.includes('.') && !url.pathname.endsWith('.html')) {
        return context.next();
    }

    // ⚠️ '/register' is deliberately NOT short-circuited here, and that exception is the whole
    // point of this block. It needs no session — but it IS subject to the new_registration_lock
    // switch, and that lives behind the platform-config fetch further down. Returning early for
    // every ALWAYS_ALLOWED path is exactly what made the admin "lock registrations" control dead
    // code: it had never blocked a signup, because the check it drives was unreachable.
    //
    // Everything else in ALWAYS_ALLOWED still exits immediately. /register pays one config fetch
    // per page load, which is the price of the switch working at all.
    const isAlwaysAllowed = ALWAYS_ALLOWED.includes(path);
    if (isAlwaysAllowed && path !== '/register') {
        return context.next();
    }

    const protectedPaths = PROTECTED_PATHS;

    // BUG-P0-1: JWT_SECRET required for signature verification — fail closed if missing.
    // Without it we cannot verify any token, so protect all protected routes.
    const jwtSecretRaw = Deno.env.get('JWT_SECRET');
    if (!jwtSecretRaw) {
        if (protectedPaths.includes(path)) {
            return Response.redirect(new URL('/login.html', request.url));
        }
        return context.next();
    }
    const jwtSecretBytes = new TextEncoder().encode(jwtSecretRaw);

    // ── US-ADM-3.2.1: Maintenance mode check ─────────────────────────────────
    // Fetch the lightweight config endpoint. Fails open (returns context.next())
    // if the config service is unreachable, to avoid taking down the whole platform.
    try {
        const configUrl = `${url.origin}/.netlify/functions/platform-config-public`;
        const configRes = await fetch(configUrl, { signal: AbortSignal.timeout(2000) });
        if (configRes.ok) {
            const cfg = await configRes.json() as {
                maintenanceMode: boolean;
                maintenanceMessage: string;
                registrationLocked: boolean;
                globalAiDisabled: boolean;
            };

            // `!isAlwaysAllowed` preserves the pre-existing exemption. /register now reaches this
            // block (it has to, to be checked against the registration lock below), but it used to
            // exit before maintenance mode was ever evaluated — along with /login, /logout and
            // /check-email, which must stay reachable during maintenance or an admin cannot sign in
            // to lift it. Letting /register fall into the maintenance redirect would be a silent
            // behaviour change smuggled in on the back of the registration-lock fix.
            if (cfg.maintenanceMode && !isAlwaysAllowed) {
                // Admin users bypass maintenance — verify JWT signature before trusting adminRole
                const sessionCookie = context.cookies.get('aura_session');
                let isAdmin = false;
                if (sessionCookie) {
                    try {
                        const { payload } = await jose.jwtVerify(sessionCookie, jwtSecretBytes);
                        const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];
                        isAdmin = !!(payload.adminRole && ADMIN_ROLES.includes(payload.adminRole as string));
                    } catch { /* invalid/forged JWT — not admin */ }
                }

                if (!isAdmin) {
                    // Strip HTML tags before reflecting into URL — prevents XSS via crafted config values
                    const safeMsg = cfg.maintenanceMessage.replace(/<[^>]*>/g, '');
                    const maintenanceUrl = new URL('/maintenance.html', request.url);
                    maintenanceUrl.searchParams.set('msg', safeMsg);
                    return Response.redirect(maintenanceUrl.toString(), 302);
                }
            }

            // US-ADM-3.2.1: Global AI kill switch — non-admin users on workspace see banner via JS;
            // the individual AI function handlers return 503 (fixes in get-assistant-context.ts,
            // provision-assistant-async.ts). No page-level redirect needed here.

            // Block registration if new_registration_lock is active.
            //
            // This branch was UNREACHABLE until 2026-08-05: '/register' sat in ALWAYS_ALLOWED and
            // returned context.next() long before the config was fetched, so the admin "lock
            // registrations" switch had never blocked a single signup. It is reachable now because
            // the ALWAYS_ALLOWED short-circuit above deliberately excludes /register.
            //
            // Turning a dead switch back on is only safe once you know what it is set to — a
            // lurking `true` would have shut off signups the instant this deployed. Checked against
            // production before enabling: the new_registration_lock row does not exist, and
            // platform-config-public.ts coerces with `=== true`, so absent reads as false and its
            // error fallback also returns false. There was no hidden `true` to enforce.
            if (cfg.registrationLocked && path === '/register') {
                return Response.redirect(new URL('/login.html?locked=1', request.url), 302);
            }
        }
    } catch (err) {
        // Config check failed — fail open and let the request proceed
        console.warn('[auth-guard] Platform config check failed (fail open):', err);
    }

    // ── Session guard — protected pages require a valid, signature-verified JWT ─
    if (protectedPaths.includes(path)) {
        // US-ONB-2.1.2 AC9: preserve the current URL as the post-login destination. Built from
        // the RAW pathname, not the normalised one, so the visitor returns to the spelling they
        // actually used. The suppression test is normalised, though: /workspace is the default
        // landing page and does not need to be passed as an explicit redirect, and that was true
        // of only the .html spelling before.
        const redirectTarget = url.pathname + url.search;
        const isDefaultDestination = path === '/workspace' && !url.search;

        const sessionCookie = context.cookies.get("aura_session");
        if (!sessionCookie) {
            console.log(`[auth-guard] Blocked unauthorized access to ${url.pathname}`);
            const loginUrl = new URL('/login.html', request.url);
            if (!isDefaultDestination) loginUrl.searchParams.set('redirect', redirectTarget);
            return Response.redirect(loginUrl);
        }

        // BUG-P0-1: Verify JWT signature — forged tokens are rejected here before any claim is trusted
        let verifiedUserId: number | null = null;
        try {
            const { payload } = await jose.jwtVerify(sessionCookie, jwtSecretBytes);
            if (typeof payload.userId === 'number') verifiedUserId = payload.userId;
        } catch {
            // Invalid signature or expired token — redirect to login
            console.log(`[auth-guard] Rejected invalid/forged JWT for ${url.pathname}`);
            const loginUrl = new URL('/login.html', request.url);
            if (!isDefaultDestination) loginUrl.searchParams.set('redirect', redirectTarget);
            return Response.redirect(loginUrl);
        }

        // US-ADM-1.3.2: Check JWT blocklist — reject erased/revoked user sessions immediately
        if (verifiedUserId !== null) {
            try {
                const revokeCheckUrl = `${url.origin}/.netlify/functions/check-token-revoked?userId=${verifiedUserId}`;
                const revokeRes = await fetch(revokeCheckUrl, { signal: AbortSignal.timeout(1500) });
                if (revokeRes.ok) {
                    const { revoked } = await revokeRes.json() as { revoked: boolean };
                    if (revoked) {
                        console.log(`[auth-guard] Blocked revoked session for userId=${verifiedUserId}`);
                        const logoutUrl = new URL('/login.html', request.url);
                        logoutUrl.searchParams.set('error', 'session_revoked');
                        const response = Response.redirect(logoutUrl.toString(), 302);
                        // Clear the stale cookie
                        response.headers.append('Set-Cookie', 'aura_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
                        return response;
                    }
                }
            } catch {
                // Blocklist check failed — fail open so a DB outage doesn't lock out all users
            }
        }
    }

    return context.next();
};
