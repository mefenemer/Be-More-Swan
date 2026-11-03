// Shared set-up for the Playwright smoke tests.
//
// Pages are served by e2e/static-server.mjs, which has no functions: every /.netlify/functions/* call
// is answered here instead. `api` holds a handler per function name. The defaults below are the
// smallest answers that get the workspace past its gates (onboarding finished, set-up wizard
// dismissed), and a spec overrides the ones it is about with api.set(). Anything not listed answers
// `{}` and is recorded in api.calls, so a spec can assert what the page asked for.
//
// Signed-in pages get an `aura_session` cookie. auth-check.js only reads the JWT's `exp` in the
// browser; the signature is checked by the functions, which are all stubbed, so it is unsigned.

import { test as base, expect, type Page, type Route } from '@playwright/test';

type Handler = (route: Route, body: unknown) => unknown | Promise<unknown>;
type Answer = Record<string, unknown> | unknown[] | Handler | { status: number; json?: unknown };

const DEFAULTS: Record<string, Answer> = {
    'get-onboarding-status': { isComplete: true },
    'get-wizard-state': { allDone: true, dismissed: true, steps: [] },
    'get-social-drafts': { drafts: [], total: 0, hasMore: false },
    'get-assistants': { assistants: [] },
    'notifications': { notifications: [], unread: 0 },
};

export interface ApiCall { name: string; method: string; url: string; body: unknown }

export class ApiStub {
    private answers = new Map<string, Answer>(Object.entries(DEFAULTS));
    readonly calls: ApiCall[] = [];

    set(name: string, answer: Answer) { this.answers.set(name, answer); }
    called(name: string) { return this.calls.filter((c) => c.name === name); }

    async attach(page: Page) {
        await page.route('**/.netlify/functions/**', async (route) => {
            const req = route.request();
            const url = new URL(req.url());
            const name = url.pathname.split('/').pop() || '';
            let body: unknown = null;
            try { body = req.postDataJSON(); } catch { body = req.postData(); }
            this.calls.push({ name, method: req.method(), url: req.url(), body });

            const answer = this.answers.get(name);
            if (typeof answer === 'function') {
                const out = await answer(route, body);
                if (out !== undefined) await route.fulfill({ json: out });
                return;
            }
            if (answer && !Array.isArray(answer) && typeof (answer as { status?: unknown }).status === 'number') {
                const { status, json } = answer as { status: number; json?: unknown };
                await route.fulfill({ status, json: json ?? { error: 'stubbed failure' } });
                return;
            }
            await route.fulfill({ json: answer ?? {} });
        });
    }
}

function sessionCookie() {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 1, activeOrganisationId: 1, exp })}.e2e`;
}

export const test = base.extend<{ api: ApiStub; signedIn: void; pageErrors: string[] }>({
    // auto: every test gets the stubs, named or not. Without them each function answers 501, the
    // onboarding check fails closed and Review and the Calendar redirect to the dashboard.
    api: [async ({ page }, use) => {
        const api = new ApiStub();
        await api.attach(page);
        await use(api);
    }, { auto: true }],
    // A test is signed in when it names this fixture in its arguments.
    signedIn: async ({ context, baseURL }, use) => {
        await context.addCookies([{ name: 'aura_session', value: sessionCookie(), url: baseURL! }]);
        await use();
    },
    // Uncaught exceptions on the page. Specs assert this stays empty: a broken script in one of the
    // workspace's ~60 modules is exactly what the tsx tests cannot see.
    pageErrors: async ({ page }, use) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await use(errors);
    },
});

/**
 * Open the workspace, wait for its own landing view, then (optionally) switch to `view`.
 *
 * The landing load must finish first: Review and the Calendar await the onboarding check before
 * swapping in, so a loadView() fired straight after page load lost the race to the landing
 * dashboard, which then painted over it.
 */
export async function openWorkspace(page: Page, view?: string) {
    await page.goto('/workspace.html');
    await expect(page.locator('#nav-dashboard')).toBeVisible();
    await page.waitForFunction(() => !!(window as any)._currentViewKey);
    if (view) {
        await page.evaluate((v) => (window as any).loadView(v), view);
        await page.waitForFunction((v) => (window as any)._currentViewKey === v, view);
    }
}

export { expect };
