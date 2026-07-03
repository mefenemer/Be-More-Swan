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
import { getDb } from '../../db/client';
import { users } from '../../db/schema';

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
interface ServiceDef {
    key: string;
    name: string;
    purpose: string;
    category: string;
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

const SERVICES: ServiceDef[] = [
    {
        key: 'netlify', name: 'Netlify', category: 'Hosting & CI',
        purpose: 'Hosting, serverless functions, builds and deploys.',
        consoleUrl: 'https://app.netlify.com', envVars: ['NETLIFY_CRON_SECRET'],
    },
    {
        key: 'neon', name: 'Neon', category: 'Database',
        purpose: 'Serverless PostgreSQL — the primary application database.',
        consoleUrl: 'https://console.neon.tech',
        envVars: ['NETLIFY_DATABASE_URL', 'DATABASE_URL', 'APP_DATABASE_URL'],
        check: async () => {
            try { const db = getDb(); await db.execute(sql`select 1`); return 'ok'; }
            catch { return 'error'; }
        },
    },
    {
        key: 'r2', name: 'Cloudflare R2', category: 'Storage',
        purpose: 'Object storage for media and uploads (S3-compatible).',
        consoleUrl: 'https://dash.cloudflare.com',
        envVars: ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'],
    },
    {
        key: 'porkbun', name: 'Porkbun', category: 'DNS & Domains',
        purpose: 'Domain registrar and DNS for bemoreswan.com.',
        consoleUrl: 'https://porkbun.com/account/domainsSpeedy', envVars: [],
    },
    {
        key: 'resend', name: 'Resend', category: 'Email',
        purpose: 'Transactional and templated email delivery.',
        consoleUrl: 'https://resend.com/overview', envVars: ['RESEND_API_KEY'],
        check: async () => process.env.RESEND_API_KEY
            ? pingOk('https://api.resend.com/domains', { Authorization: `Bearer ${process.env.RESEND_API_KEY}` })
            : 'n/a',
    },
    {
        key: 'pexels', name: 'Pexels', category: 'Media',
        purpose: 'Stock photo and video search for content.',
        consoleUrl: 'https://www.pexels.com/api/', envVars: ['PEXELS_API_KEY'],
        check: async () => process.env.PEXELS_API_KEY
            ? pingOk('https://api.pexels.com/v1/search?query=test&per_page=1', { Authorization: process.env.PEXELS_API_KEY })
            : 'n/a',
    },
    {
        key: 'stripe', name: 'Stripe', category: 'Billing',
        purpose: 'Subscriptions, payments and billing.',
        consoleUrl: 'https://dashboard.stripe.com', envVars: ['STRIPE_SECRET_KEY'],
        check: async () => process.env.STRIPE_SECRET_KEY
            ? pingOk('https://api.stripe.com/v1/balance', { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` })
            : 'n/a',
    },
    {
        key: 'anthropic', name: 'Anthropic', category: 'AI',
        purpose: 'Claude models powering the assistants.',
        consoleUrl: 'https://console.anthropic.com', envVars: ['ANTHROPIC_API_KEY'],
    },
];

// Mask: only ever reveal that a value exists + its last 4 chars, never the secret itself.
function maskedHint(varName: string): string | null {
    const v = process.env[varName];
    if (!v) return null;
    return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    if (!(await requireSuperAdmin(event))) return json(403, { error: 'Forbidden' });

    // Deployment environment (Netlify): CONTEXT='production' on the production deploy;
    // branch/preview deploys (e.g. the staging branch) are everything else.
    const context = process.env.CONTEXT || '';
    const branch = process.env.BRANCH || '';
    const environment = (context === 'production' || branch === 'main') ? 'production' : 'staging';

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
            consoleUrl: s.consoleUrl,
            envVars: s.envVars,
            configured,                                  // true | false | null (console-only)
            maskedHint: presentVar ? maskedHint(presentVar) : null,
            health,                                      // 'ok' | 'error' | 'n/a'
        };
    }));

    return json(200, { environment, services });
};
