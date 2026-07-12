// admin-system-status.ts
// GET — super_admin only.
// Returns a registry of the infrastructure services that run the platform (Netlify, Neon,
// R2, Porkbun, Resend, Pexels, Stripe, Anthropic) with, for the CURRENT deployment
// environment, whether each is configured (env var present — value never returned) and a
// cheap, non-destructive health check where one exists. Secrets are NOT stored in the DB:
// "edit" in the UI deep-links to the provider console + the Netlify env-vars settings.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── super_admin gate (mirrors admin-api requireAdmin, but super_admin only) ──
async function requireSuperAdmin(event: Parameters<Handler>[0]): Promise<boolean> {
    if (!jwtSecret) return false;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return false;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return false; }
    try {
        const db = getDb();
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
        return row?.role === 'super_admin';
    } catch { return false; }
}

type Health = 'ok' | 'error' | 'n/a';
// tier drives the launch-readiness verdict:
//   critical  — app is broken or insecure without it (auth, DB, billing, LLM, credential vault).
//   core      — a headline feature silently degrades to mock/disabled without it (storage, AI media…).
//   connector — one optional OAuth integration; absence only means that connector can't be offered.
//   infra     — operational hardening (cron/worker secrets); not user-visible but should be set.
type Tier = 'critical' | 'core' | 'connector' | 'infra';
interface ServiceDef {
    key: string;
    name: string;
    purpose: string;
    category: string;
    tier: Tier;
    consoleUrl: string;
    envVars: string[];                 // env var names this service uses (empty = console-only)
    check?: () => Promise<Health>;     // optional non-destructive reachability check
}

// Fetch with a short timeout so a hung provider can never hang the endpoint.
async function pingOk(url: string, headers: Record<string, string>): Promise<Health> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(url, { headers, signal: ctrl.signal });
        clearTimeout(t);
        return res.ok ? 'ok' : 'error';
    } catch { return 'error'; }
}

// Bound a promise that doesn't accept an AbortSignal (e.g. the S3 SDK) so a hung provider
// can never stall the endpoint.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

// One OAuth connector entry (client id + secret pair). Absence just means that integration
// can't be offered — never a launch blocker on its own.
function connector(key: string, name: string, category: string, consoleUrl: string, prefix: string): ServiceDef {
    return {
        key, name, category, tier: 'connector',
        purpose: `OAuth connector — lets users link their ${name} account.`,
        consoleUrl, envVars: [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`],
    };
}

const SERVICES: ServiceDef[] = [
    // ── critical: app is broken or insecure without these ──────────────────────
    {
        key: 'auth', name: 'Session signing', category: 'Security', tier: 'critical',
        purpose: 'JWT secret that signs every login session and admin/impersonation token. No fallback — auth fails closed without it.',
        consoleUrl: 'https://app.netlify.com', envVars: ['JWT_SECRET'],
    },
    {
        key: 'neon', name: 'Neon', category: 'Database', tier: 'critical',
        purpose: 'Serverless PostgreSQL — the primary application database.',
        consoleUrl: 'https://console.neon.tech',
        envVars: ['NETLIFY_DATABASE_URL', 'DATABASE_URL', 'APP_DATABASE_URL'],
        check: async () => {
            try { const db = getDb(); await db.execute(sql`select 1`); return 'ok'; }
            catch { return 'error'; }
        },
    },
    {
        key: 'vault', name: 'Credential vault', category: 'Security', tier: 'critical',
        purpose: 'Key-encryption key for stored OAuth tokens & connection secrets. Without it, saved integrations cannot be decrypted.',
        consoleUrl: 'https://app.netlify.com', envVars: ['VAULT_KEK', 'VAULT_KEK_VERSION'],
    },
    {
        key: 'anthropic', name: 'Anthropic', category: 'AI', tier: 'critical',
        purpose: 'Claude models powering the assistants — the product does nothing useful without it.',
        consoleUrl: 'https://console.anthropic.com', envVars: ['ANTHROPIC_API_KEY'],
    },
    {
        key: 'stripe', name: 'Stripe', category: 'Billing', tier: 'critical',
        purpose: 'Subscriptions, payments and billing. Needs the secret key, publishable key AND webhook secret to be complete.',
        consoleUrl: 'https://dashboard.stripe.com',
        envVars: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'],
        check: async () => process.env.STRIPE_SECRET_KEY
            ? pingOk('https://api.stripe.com/v1/balance', { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` })
            : 'n/a',
    },
    {
        key: 'resend', name: 'Resend', category: 'Email', tier: 'critical',
        purpose: 'Transactional email (verification, password reset, invites). Users cannot complete signup without it.',
        consoleUrl: 'https://resend.com/overview', envVars: ['RESEND_API_KEY', 'FROM_EMAIL'],
        // A least-privilege "Sending access" Resend key can send email but is rejected on /domains
        // with name 'restricted_api_key' — the key is valid, so treat that as reachable. Only a
        // genuinely invalid/expired key (any other 401/403) or a network failure is an error.
        check: async () => {
            if (!process.env.RESEND_API_KEY) return 'n/a';
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3500);
                const res = await fetch('https://api.resend.com/domains', {
                    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
                    signal: ctrl.signal,
                });
                clearTimeout(t);
                if (res.ok) return 'ok';
                if (res.status === 401 || res.status === 403) {
                    const body: any = await res.json().catch(() => ({}));
                    return body?.name === 'restricted_api_key' ? 'ok' : 'error';
                }
                return 'error';
            } catch { return 'error'; }
        },
    },
    {
        key: 'app-url', name: 'App base URL', category: 'Config', tier: 'critical',
        purpose: 'Public origin used to build links in outgoing emails & OAuth redirects. Falls back to empty → broken links if unset.',
        consoleUrl: 'https://app.netlify.com', envVars: ['BASE_URL'],
    },

    // ── core: a headline feature silently degrades to mock/disabled without it ──
    {
        key: 'r2', name: 'Cloudflare R2', category: 'Storage', tier: 'core',
        purpose: 'Object storage for media & uploads (S3-compatible). Without it, uploads return 501 and media falls back to mock.',
        consoleUrl: 'https://dash.cloudflare.com',
        envVars: ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'],
        // Non-destructive HeadBucket: validates the credentials AND that the bucket exists.
        check: async () => {
            if (!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME)) return 'n/a';
            try {
                const client = new S3Client({
                    region: 'auto',
                    endpoint: process.env.R2_ENDPOINT,
                    maxAttempts: 1,
                    credentials: {
                        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
                    },
                });
                await withTimeout(client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME! })), 3500);
                return 'ok';
            } catch { return 'error'; }
        },
    },
    {
        key: 'fal', name: 'Fal.ai', category: 'AI', tier: 'core',
        purpose: 'AI image & video generation. Without FAL_KEY the whole media-gen flow silently returns placeholder assets.',
        consoleUrl: 'https://fal.ai/dashboard', envVars: ['FAL_KEY'],
        // Non-destructive key check: poll the status of a nonexistent request. fal authenticates
        // first (bad/missing key → 401/403), so a valid key returns 404 — no model is ever run.
        check: async () => {
            if (!process.env.FAL_KEY) return 'n/a';
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3500);
                const res = await fetch(
                    'https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status',
                    { headers: { Authorization: `Key ${process.env.FAL_KEY}` }, signal: ctrl.signal },
                );
                clearTimeout(t);
                return (res.status === 401 || res.status === 403) ? 'error' : 'ok';
            } catch { return 'error'; }
        },
    },
    {
        key: 'embeddings', name: 'Embeddings & moderation', category: 'AI', tier: 'core',
        purpose: 'Vector embeddings for KB search and content moderation. At least one provider key must be set.',
        consoleUrl: 'https://dashboard.voyageai.com', envVars: ['VOYAGE_API_KEY', 'OPENAI_API_KEY'],
    },
    {
        key: 'pexels', name: 'Pexels', category: 'Media', tier: 'core',
        purpose: 'Stock photo & video search for content.',
        consoleUrl: 'https://www.pexels.com/api/', envVars: ['PEXELS_API_KEY'],
        check: async () => process.env.PEXELS_API_KEY
            ? pingOk('https://api.pexels.com/v1/search?query=test&per_page=1', { Authorization: process.env.PEXELS_API_KEY })
            : 'n/a',
    },
    {
        key: 'serper', name: 'Serper', category: 'Search', tier: 'core',
        purpose: 'Live web search powering Lead Generator outbound discovery. Without it, discovery cannot run.',
        consoleUrl: 'https://serper.dev/dashboard', envVars: ['SERPER_API_KEY'],
    },

    // ── infra: operational hardening (not user-visible, but should be set in prod) ─
    {
        key: 'netlify', name: 'Netlify', category: 'Hosting & CI', tier: 'infra',
        purpose: 'Hosting, serverless functions, builds and deploys.',
        consoleUrl: 'https://app.netlify.com', envVars: ['NETLIFY_CRON_SECRET'],
    },
    {
        key: 'cron-worker', name: 'Cron & worker secrets', category: 'Security', tier: 'infra',
        purpose: 'Shared secrets that authenticate internal cron triggers & background workers so the endpoints cannot be called publicly.',
        consoleUrl: 'https://app.netlify.com', envVars: ['CRON_TRIGGER_SECRET', 'WORKER_SECRET'],
    },
    {
        key: 'porkbun', name: 'Porkbun', category: 'DNS & Domains', tier: 'infra',
        purpose: 'Domain registrar and DNS for bemoreswan.com.',
        consoleUrl: 'https://porkbun.com/account/domainsSpeedy', envVars: [],
    },

    // ── connectors: optional OAuth integrations (one per linkable account) ──────
    connector('gmail', 'Gmail', 'Connector · Email', 'https://console.cloud.google.com', 'GMAIL'),
    connector('meta', 'Meta (Facebook/Instagram)', 'Connector · Social', 'https://developers.facebook.com', 'META'),
    connector('x', 'X (Twitter)', 'Connector · Social', 'https://developer.twitter.com', 'X'),
    connector('linkedin', 'LinkedIn', 'Connector · Social', 'https://www.linkedin.com/developers', 'LINKEDIN'),
    connector('tiktok', 'TikTok', 'Connector · Social', 'https://developers.tiktok.com', 'TIKTOK'),
    connector('threads', 'Threads', 'Connector · Social', 'https://developers.facebook.com', 'THREADS'),
    connector('youtube', 'YouTube', 'Connector · Social', 'https://console.cloud.google.com', 'YOUTUBE'),
    connector('slack', 'Slack', 'Connector · Messaging', 'https://api.slack.com/apps', 'SLACK'),
    connector('notion', 'Notion', 'Connector · Docs', 'https://www.notion.so/my-integrations', 'NOTION'),
    connector('hubspot', 'HubSpot', 'Connector · CRM', 'https://app.hubspot.com', 'HUBSPOT'),
    connector('salesforce', 'Salesforce', 'Connector · CRM', 'https://developer.salesforce.com', 'SALESFORCE'),
    connector('jira', 'Jira', 'Connector · PM', 'https://developer.atlassian.com', 'JIRA'),
    connector('asana', 'Asana', 'Connector · PM', 'https://app.asana.com', 'ASANA'),
    connector('zendesk', 'Zendesk', 'Connector · Support', 'https://www.zendesk.com', 'ZENDESK'),
    connector('intercom', 'Intercom', 'Connector · Support', 'https://developers.intercom.com', 'INTERCOM'),
    connector('xero', 'Xero', 'Connector · Finance', 'https://developer.xero.com', 'XERO'),
    connector('quickbooks', 'QuickBooks', 'Connector · Finance', 'https://developer.intuit.com', 'QUICKBOOKS'),
    connector('searchconsole', 'Google Search Console', 'Connector · SEO', 'https://console.cloud.google.com', 'SEARCHCONSOLE'),
    connector('wordpresscom', 'WordPress.com', 'Connector · Blog', 'https://developer.wordpress.com', 'WORDPRESSCOM'),
];

// Mask: only ever reveal that a value exists + its last 4 chars, never the secret itself.
function maskedHint(varName: string): string | null {
    const v = process.env[varName];
    if (!v) return null;
    return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    if (!(await requireSuperAdmin(event))) return json(403, { error: 'Forbidden' });

    // Deployment environment. CONTEXT/BRANCH are build-time Netlify vars and are often absent
    // at function RUNTIME, so we also derive from the request host, which IS available at
    // runtime. Production is served from bemoreswan.com; every other host (netlify.app
    // branch/preview subdomains) is treated as staging.
    const host = (event.headers?.host || event.headers?.['x-forwarded-host'] || '').toLowerCase();
    const isProdHost = host === 'bemoreswan.com' || host === 'www.bemoreswan.com';
    const environment =
        (process.env.CONTEXT === 'production' || process.env.BRANCH === 'main' || isProdHost)
            ? 'production'
            : 'staging';

    const services = await Promise.all(SERVICES.map(async (s) => {
        const configured = s.envVars.length === 0 ? null : s.envVars.some(v => Boolean(process.env[v]));
        const presentVar = s.envVars.find(v => process.env[v]);
        let health: Health = 'n/a';
        if (configured !== false && s.check) {
            try { health = await s.check(); } catch { health = 'error'; }
        }
        return {
            key: s.key,
            name: s.name,
            purpose: s.purpose,
            category: s.category,
            tier: s.tier,                                // 'critical' | 'core' | 'connector' | 'infra'
            consoleUrl: s.consoleUrl,
            envVars: s.envVars,
            configured,                                  // true | false | null (console-only)
            maskedHint: presentVar ? maskedHint(presentVar) : null,
            health,                                      // 'ok' | 'error' | 'n/a'
        };
    }));

    // Launch-readiness verdict: every 'critical' service must be configured (and, where a
    // health check exists, reachable). 'core' gaps are warnings; connectors never block.
    const missingCritical = services.filter(s => s.tier === 'critical' && s.configured === false).map(s => s.name);
    const unreachableCritical = services.filter(s => s.tier === 'critical' && s.health === 'error').map(s => s.name);
    const missingCore = services.filter(s => s.tier === 'core' && s.configured === false).map(s => s.name);
    const connectorsLive = services.filter(s => s.tier === 'connector' && s.configured === true).map(s => s.name);
    const readiness = {
        launchReady: missingCritical.length === 0 && unreachableCritical.length === 0,
        missingCritical,        // must be empty to launch
        unreachableCritical,    // configured but failing its health check
        missingCore,            // features that will silently run in mock/disabled mode
        connectorsLive,         // which optional OAuth integrations are actually wired in this env
    };

    return json(200, { environment, readiness, services });
});
