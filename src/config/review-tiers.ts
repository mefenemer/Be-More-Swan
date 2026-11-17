// src/config/review-tiers.ts — every PR gets a risk tier worked out from the FILES it changes (owner,
// 2026-11-17; docs/review-tiers-plan.md). The author never picks the tier, so a change can't be talked down.
//
//   high   → second-opinion review + full evidence pack; the owner approves it as its own PR
//   medium → second-opinion review, then the owner's Approve
//   low    → merges to staging once CI passes (phase 4); the owner sees it in the release PR
//
// Rules are checked high first; the first match wins for a file and the highest file wins for the PR.
// ⚠️ Anything no rule names is MEDIUM, never low: low is only ever an explicit rule below.
// SQL files are special: additive SQL (src/utils/issue-sql.ts) is medium, anything else is high.

import { classifySql } from '../utils/issue-sql';

export type ReviewTier = 'low' | 'medium' | 'high';
export const TIER_RANK: Record<ReviewTier, number> = { low: 0, medium: 1, high: 2 };

export interface TierRule { tier: ReviewTier; key: string; label: string; match: RegExp[] }

const fn = (re: string) => new RegExp(`^netlify/functions/(?:${re})`);
const util = (re: string) => new RegExp(`^src/utils/(?:${re})`);

export const TIER_RULES: TierRule[] = [
    // ── HIGH ────────────────────────────────────────────────────────────────────────────────────
    {
        tier: 'high', key: 'billing', label: 'billing, Stripe, plans, coupons, task costs',
        match: [
            fn('billing-|stripe-webhook|reconcile-billing|create-subscription|create-plan-checkout|create-x-credit-checkout|invoice-|get-plans|activate-scheduled-prices|admin-billing-override|admin-coupons|admin-plan-moves|admin-task-costs|admin-ai-credits|task-cost'),
            util('stripe|billing-|plan-(?:pricing|price-tokens|stripe-refs|change-schedule|moves|products|features)|coupon-rules|subscription-|task-cost|org-plan-value|next-plan|restore-after-new-plan|site-plan-prices'),
            /^src\/config\/task-weights\.ts$/, /^src\/config\/beta-plan\.ts$/, /^db\/z-task-costs\.sql$/,
            /^(?:billing|checkout|plan-prices|task-costs)\.(?:js|html)$/,
        ],
    },
    {
        tier: 'high', key: 'payouts', label: 'Stripe Connect, shop payments, partner payouts',
        match: [fn('stripe-connect-webhook|shop\\.ts|admin-partners\\.ts'), util('partner-payout|shop-settings|site-shop')],
    },
    {
        tier: 'high', key: 'auth', label: 'auth, invites, roles, members, workspace (orgId) checks, impersonation',
        match: [
            fn('login|register|review-login|resend-verification|accept-invite|invite-|manage-members|request-domain-join|admin-impersonate|check-token-revoked'),
            util('session\\.ts|tenant|worker-auth|invite-|domain-workspace|assistant-role\\.ts|referral-tokens'),
            /^netlify\/edge-functions\//, /^src\/auth-guard\.ts$/, /^src\/config\/team-features\.ts$/,
            /^(?:auth-check|session-timeout)\.js$/, /^(?:login|register|accept-invite|invite)\.html$/,
        ],
    },
    {
        tier: 'high', key: 'tokens', label: 'token vault, encryption, OAuth connectors, connection moves',
        match: [
            fn('.*oauth|.*-callbacks?\\.ts|authorize-integration|check-integration-authorization|revoke-|emergency-revoke-tokens|migrate-vault-kek|refresh-.*tokens|move-connection'),
            util('vault|encryption|disconnect-revoke|connection-(?:move|collision|recovery)|webhook-verify'),
            /^src\/config\/x-scopes\.ts$/,
        ],
    },
    {
        tier: 'high', key: 'publish-send', label: 'publishes or sends on a customer\'s behalf (posts, blogs, email, Email Assistant)',
        match: [
            fn('publish-|unpublish-|scheduled-posts|copy-post-to-platform|social-publish|send-|process-(?:newsletter|sequence)-sends|run-sequence-sends|admin-broadcast|admin-send-notification|newsletter-sending-domain|mailbox|poll-mailboxes|run-poll-mailboxes'),
            util('social-publish|blog-publish|auto-publish-runtime|trigger-publish-now|publish-policy|newsletter-send|newsletter-resend|meeting-followup-send|mailbox-actions|sending-domain|sender-identity'),
        ],
    },
    {
        tier: 'high', key: 'data', label: 'deletion, data export, GDPR',
        match: [fn('account-delete-|admin-delete-record|delete-|data-export|admin-gdpr-erase|admin-sar-export|sar-download'), util('delete-tiers|workspace-export')],
    },
    {
        tier: 'high', key: 'own-domain', label: 'own-domain connect',
        match: [fn('check-site-domains|run-site-domain-checks'), util('site-domains|email-domain')],
    },
    {
        tier: 'high', key: 'platform', label: 'RLS, redirects/headers, workflows, migrations runner, secrets, these review rules',
        // The review rules themselves are high: otherwise a PR could lower its own tier.
        match: [/^db\/rls\//, /^netlify\.toml$/, /^\.github\//, /^scripts\/migrate/, /^db\/schema\.ts$/, /^db\/client\.ts$/, /^\.env/,
            /^src\/config\/review-tiers\.ts$/, /^src\/utils\/(?:pr-evidence|pr-approval|issue-sql)\.ts$/, /^scripts\/pr-tier\.ts$/],
    },
    // ── LOW (explicit only) ─────────────────────────────────────────────────────────────────────
    {
        tier: 'low', key: 'docs-tests', label: 'docs, tests, notes',
        match: [/^docs\//, /^tests\//, /^e2e\//, /\.md$/, /^THIRD-PARTY-NOTICES$/],
    },
    {
        tier: 'low', key: 'styles-media', label: 'styles, copy files, images, sounds, fonts',
        match: [/^(?:style|input)\.css$/, /^locales\//, /^images\//, /^favicon\//, /^audio\//, /^site-fonts\//, /\.(?:png|jpe?g|webp|svg|ico|mp3|wav|woff2?)$/i],
    },
];

const DEFAULT_RULE = { tier: 'medium' as ReviewTier, key: 'default', label: 'code with no specific rule' };

export interface FileTier { path: string; tier: ReviewTier; key: string; label: string; note?: string }

/** One file. `sqlText` = the SQL a db/*.sql change adds (added lines), when known. */
export function tierForFile(path: string, sqlText?: string | null): FileTier {
    const p = path.replace(/^\.\//, '');
    for (const r of TIER_RULES) {
        if (r.tier === 'high' && r.match.some((re) => re.test(p))) return { path: p, tier: 'high', key: r.key, label: r.label };
    }
    if (/^db\/.*\.sql$/.test(p)) {
        const c = classifySql(sqlText);
        if (sqlText == null) return { path: p, tier: 'high', key: 'sql', label: 'SQL', note: 'SQL text unknown — treated as non-additive' };
        if (c.safety === 'manual') return { path: p, tier: 'high', key: 'sql', label: 'non-additive SQL', note: c.refused[0] };
        return { path: p, tier: 'medium', key: 'sql', label: c.safety === 'none' ? 'SQL file (no statements added)' : 'additive SQL' };
    }
    for (const r of TIER_RULES) {
        if (r.tier === 'low' && r.match.some((re) => re.test(p))) return { path: p, tier: 'low', key: r.key, label: r.label };
    }
    return { path: p, ...DEFAULT_RULE };
}

export interface ChangeTier { tier: ReviewTier; files: FileTier[]; reasons: FileTier[] }

/** A whole change: the highest file wins. `reasons` = the files at that tier. An empty change is medium. */
export function tierForChange(files: Array<{ path: string; sqlText?: string | null }>): ChangeTier {
    const out = files.map((f) => tierForFile(f.path, f.sqlText));
    if (!out.length) return { tier: 'medium', files: out, reasons: [] };
    const tier = out.reduce<ReviewTier>((t, f) => (TIER_RANK[f.tier] > TIER_RANK[t] ? f.tier : t), 'low');
    return { tier, files: out, reasons: out.filter((f) => f.tier === tier) };
}

/** The first rule that made the change its tier, for one-line summaries ("High (billing — src/utils/stripe.ts)"). */
export function tierSummary(t: ChangeTier): string {
    const name = t.tier[0].toUpperCase() + t.tier.slice(1);
    const r = t.reasons[0];
    if (!r) return name;
    const more = t.reasons.length > 1 ? ` +${t.reasons.length - 1} more` : '';
    return `${name} (${r.label} — ${r.path}${more})`;
}
