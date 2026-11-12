// src/utils/system-registry.ts
// The ONE list of external systems that run Be More Swan, with a cheap non-destructive health check
// where one exists. Moved here from admin-system-status.ts on 2026-11-12 so the System Map
// (admin-system-map.ts, docs/system-map-plan.md), the old status endpoint and the Systems chat all
// read the same registry. Secrets are never returned — only whether a variable is set and its last 4.

import { sql } from 'drizzle-orm';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { FAL_BILLING_URL, readElevenLabsBalance, readStabilityBalance } from './provider-balance';
import { remotionConfigured } from '../lib/remotion-lambda';
import { ELEVENLABS_MODEL, TRANSCRIBE_MODEL, TTS_MODEL } from '../lib/tts';
import { MUSIC_MODEL } from '../lib/stability-audio';

export type Health = 'ok' | 'error' | 'n/a';
// tier drives the launch-readiness verdict:
//   critical  — app is broken or insecure without it (auth, DB, billing, LLM, credential vault).
//   core      — a headline feature silently degrades to mock/disabled without it (storage, AI media…).
//   connector — one optional OAuth integration; absence only means that connector can't be offered.
//   infra     — operational hardening (cron/worker secrets); not user-visible but should be set.
export type Tier = 'critical' | 'core' | 'connector' | 'infra';
export interface ServiceDef {
    key: string;
    name: string;
    purpose: string;
    category: string;
    tier: Tier;
    consoleUrl: string;
    envVars: string[];                 // env var names this service uses (empty = console-only)
    check?: () => Promise<Health>;     // optional non-destructive reachability check
}

/**
 * What version of each system we talk to: `api` = the API version / models the code calls, `sdk` =
 * the npm client and its INSTALLED version. tests/system-map-page.test.ts fails when an sdk version
 * here drifts from node_modules or the Stripe version from src/utils/stripe.ts STRIPE_API_VERSION.
 * Most SaaS APIs report no version, so this is what we call, not what they run.
 */
export const SYSTEM_VERSIONS: Record<string, { api?: string; sdk?: string }> = {
    anthropic: { api: 'Messages API 2023-06-01', sdk: '@anthropic-ai/sdk 0.104.1' },
    stripe: { api: '2026-05-27.dahlia', sdk: 'stripe 22.2.0' },
    neon: { sdk: 'postgres 3.4.9 · drizzle-orm 1.0.0-beta.22' },
    r2: { api: 'S3-compatible', sdk: '@aws-sdk/client-s3 3.1069.0' },
    resend: { api: 'REST', sdk: 'resend 6.12.4' },
    remotion: { sdk: '@remotion/lambda 4.0.498' },
    elevenlabs: { api: `v1 · ${ELEVENLABS_MODEL}` },
    openai: { api: `v1 · ${TTS_MODEL}, ${TRANSCRIBE_MODEL}, omni-moderation-latest` },
    stability: { api: `v2beta · ${MUSIC_MODEL}` },
    embeddings: { api: 'v1 · voyage-3.5-lite' },
    fal: { api: 'Queue API · models listed below' },
    pexels: { api: 'v1' },
    serper: { api: 'v1 search' },
    hunter: { api: 'v2' },
    'companies-house': { api: 'Public Data API' },
};

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

export const SERVICES: ServiceDef[] = [
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
        key: 'newsletter-domains', name: 'Email sending domains', category: 'Email', tier: 'core',
        purpose: 'Registers and verifies each tenant\'s own sending domain, so newsletters send from their address rather than ours. '
            + 'Needs a FULL-ACCESS Resend key — the least-privilege sending key is rejected on /domains.',
        consoleUrl: 'https://resend.com/api-keys', envVars: ['RESEND_DOMAINS_API_KEY'],
        // Deliberately probes /domains rather than pinging a generic endpoint: the whole point of
        // this entry is to catch a key that CAN send but CANNOT manage domains, which every other
        // check in this file would report as perfectly healthy.
        check: async () => {
            const key = process.env.RESEND_DOMAINS_API_KEY;
            if (!key) return 'n/a';
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3500);
                const res = await fetch('https://api.resend.com/domains', {
                    headers: { Authorization: `Bearer ${key}` },
                    signal: ctrl.signal,
                });
                clearTimeout(t);
                if (res.ok) return 'ok';
                // The one failure worth distinguishing: a valid key with the wrong permission.
                const body: any = await res.json().catch(() => ({}));
                if (body?.name === 'restricted_api_key') return 'error';
                return 'error';
            } catch { return 'error'; }
        },
    },
    {
        key: 'newsletter-webhook', name: 'Email delivery events', category: 'Email', tier: 'core',
        purpose: 'Svix signing secret for Resend delivery events. Without it every bounce and spam complaint is rejected 401 — '
            + 'the audience never learns an address is dead and the list degrades silently.',
        consoleUrl: 'https://resend.com/webhooks', envVars: ['RESEND_WEBHOOK_SECRET'],
        // No reachability check possible: the value is write-only on Netlify and only the provider
        // can prove it matches. Presence is all this can honestly report — see the endpoint's own
        // "Recent deliveries" for the authoritative answer.
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
        // GET /v1/models is free and read-only: proves the key and that the API answers, spends nothing.
        check: async () => process.env.ANTHROPIC_API_KEY
            ? pingOk('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' })
            : 'n/a',
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
        key: 'fal-billing', name: 'Fal.ai balance alerts', category: 'AI', tier: 'infra',
        purpose: 'Admin key that lets check-provider-balances read the fal balance and warn BEFORE it runs out. Without it, the alert only fires after fal has locked the account and AI images are already failing.',
        consoleUrl: 'https://fal.ai/dashboard/keys', envVars: ['FAL_ADMIN_KEY'],
        // The same read-only billing call the balance check makes; an ordinary (non-admin) key answers 401/403.
        check: async () => process.env.FAL_ADMIN_KEY
            ? pingOk(FAL_BILLING_URL, { Authorization: `Key ${process.env.FAL_ADMIN_KEY}` })
            : 'n/a',
    },
    {
        key: 'embeddings', name: 'Voyage AI', category: 'AI', tier: 'core',
        purpose: 'Vector embeddings (voyage-3.5-lite) for Knowledge Base search. Spend is logged per call.',
        consoleUrl: 'https://dashboard.voyageai.com', envVars: ['VOYAGE_API_KEY'],
    },
    {
        key: 'openai', name: 'OpenAI', category: 'AI', tier: 'core',
        purpose: 'Voiceovers when ElevenLabs is off or fails (gpt-4o-mini-tts), word timings (whisper-1), content moderation, '
            + 'tour narration and the AI Visibility checks. Without it voiceovers and captions stop and moderation fails open.',
        consoleUrl: 'https://platform.openai.com/usage', envVars: ['OPENAI_API_KEY'],
        // GET /v1/models is free and read-only: proves the key without spending anything.
        check: async () => process.env.OPENAI_API_KEY
            ? pingOk('https://api.openai.com/v1/models', { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` })
            : 'n/a',
    },
    {
        key: 'gemini', name: 'Google Gemini', category: 'AI', tier: 'infra',
        purpose: 'Used only by the monthly AI Visibility check ("do AI assistants name us"). Its spend is NOT logged yet.',
        consoleUrl: 'https://aistudio.google.com/apikey', envVars: ['GEMINI_API_KEY'],
    },
    {
        key: 'elevenlabs', name: 'ElevenLabs', category: 'AI', tier: 'core',
        purpose: 'British voiceovers (the Pepper voice and the voice catalogue). Falls back to OpenAI voices when missing or out of characters.',
        consoleUrl: 'https://elevenlabs.io/app/subscription', envVars: ['ELEVENLABS_API_KEY'],
        // The same free subscription read the balance check makes.
        check: async () => {
            const b = await readElevenLabsBalance();
            return b.status === 'ok' ? 'ok' : b.status === 'not_configured' ? 'n/a' : 'error';
        },
    },
    {
        key: 'stability', name: 'Stability AI', category: 'AI', tier: 'core',
        purpose: 'AI music (Stable Audio) for video moods and the music generator. Without it, AI music cannot be made.',
        consoleUrl: 'https://platform.stability.ai/account/credits', envVars: ['STABILITY_API_KEY'],
        check: async () => {
            const b = await readStabilityBalance();
            return b.status === 'ok' ? 'ok' : b.status === 'not_configured' ? 'n/a' : 'error';
        },
    },
    {
        key: 'remotion', name: 'Remotion Lambda (AWS)', category: 'Media', tier: 'core',
        purpose: 'Renders finished videos (post videos, Video Producer) on AWS Lambda. Needs the function, the deployed site, '
            + 'the region and the REMOTION_AWS_* keys; without them videos cannot render. Render cost is logged per render.',
        consoleUrl: 'https://console.aws.amazon.com/lambda',
        envVars: ['REMOTION_LAMBDA_FUNCTION_NAME', 'REMOTION_SERVE_URL', 'REMOTION_REGION', 'REMOTION_AWS_ACCESS_KEY_ID', 'REMOTION_AWS_SECRET_ACCESS_KEY'],
        // Every part must be present, not just one — remotionConfigured() is the app's own guard.
        check: async () => remotionConfigured() ? 'n/a' : 'error',
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
    {
        key: 'hunter', name: 'Hunter', category: 'Search', tier: 'core',
        purpose: 'Finds contact email addresses for discovered leads. Charged per email found; spend is logged per lookup.',
        consoleUrl: 'https://hunter.io/dashboard', envVars: ['HUNTER_API_KEY'],
    },
    {
        key: 'companies-house', name: 'Companies House', category: 'Search', tier: 'core',
        purpose: 'UK company register lookups for Lead Generator (free API).',
        consoleUrl: 'https://developer.company-information.service.gov.uk', envVars: ['COMPANIES_HOUSE_API_KEY'],
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
    connector('canva', 'Canva', 'Connector · Design', 'https://www.canva.com/developers', 'CANVA'),
    connector('googlecalendar', 'Google Calendar (Meet links)', 'Connector · Booking', 'https://console.cloud.google.com', 'GOOGLE_CALENDAR'),
    connector('outlook', 'Microsoft Outlook / Teams', 'Connector · Booking', 'https://portal.azure.com', 'OUTLOOK'),
];

// Mask: only ever reveal that a value exists + its last 4 chars, never the secret itself.
function maskedHint(varName: string): string | null {
    const v = process.env[varName];
    if (!v) return null;
    return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}


export type SystemStatusResult = Awaited<ReturnType<typeof systemStatus>>;

/** Live status of every system for THIS deployment. `hostHeader` decides production vs staging. */
export async function systemStatus(hostHeader: string | null | undefined) {
    // Deployment environment. CONTEXT/BRANCH are build-time Netlify vars and are often absent
    // at function RUNTIME, so we also derive from the request host, which IS available at
    // runtime. Production is served from bemoreswan.com; every other host (netlify.app
    // branch/preview subdomains) is treated as staging.
    const host = String(hostHeader || '').toLowerCase();
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
            version: s.key === 'netlify' ? { api: `Functions on Node ${process.version}` } : (SYSTEM_VERSIONS[s.key] ?? null),
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

    // The runtime this function is ACTUALLY executing on, reported because it is otherwise
    // unobservable — and the gap between it and a developer's local Node is what let a static
    // import of an ESM-only package crash publish-blog-posts for a day while every local check
    // passed (Node 22.12+ allows require() of ESM; older versions throw at module load).
    // Pinned in netlify.toml [build.environment] NODE_VERSION, .nvmrc and package.json engines —
    // `pinnedMatches` is false when the deploy silently drifted from all three.
    const runtime = {
        node: process.version,
        pinned: process.env.NODE_VERSION ?? null,
        pinnedMatches: process.env.NODE_VERSION
            ? process.version.replace(/^v/, '').startsWith(String(process.env.NODE_VERSION).replace(/^v/, '').split('.')[0])
            : null,
    };

    return { environment, runtime, readiness, services };
}
