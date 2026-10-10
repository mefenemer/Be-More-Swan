// src/utils/org-products.ts
// The business's Products & Services, as one prompt block every assistant reads.
//
// Before this, the only thing any assistant knew about what a business sells was the one free-text
// "What your business does" box — so a post, an article, an email or an outreach message could only
// ever name a product the model guessed at, at a price it guessed at. Products are recorded once on
// Business Information ▸ Products & Services and read here by EVERY drafting seam:
//   chat (every role)            netlify/functions/chat-orchestrator.ts
//   social drafting (autopilot)  netlify/functions/process-content-jobs.ts
//   articles + topic ideas       src/utils/blog-generate.ts, src/utils/blog-topic-ideation.ts
//   emails + email campaigns     src/utils/newsletter-generate.ts, src/utils/newsletter-campaign-generate.ts
//   lead outreach (4 prompts)    src/utils/sender-identity.ts → senderIdentityBlock()
//   the quality review           src/utils/post-quality-review.ts — so an invented price is caught
// One loader and one renderer, so the seams cannot drift on what "the products" are.
//
// ⚠️ Never throws. A missing table (code deployed before db/z-org-products.sql) or a failed read
// yields no block, and every caller carries on exactly as it did before products existed.

import { and, asc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgProducts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export type ProductKind = 'product' | 'service';
export interface OrgProduct {
    kind: ProductKind | string;
    name: string;
    description?: string | null;
    benefits?: string | null;
    price?: string | null;
    audience?: string | null;
    url?: string | null;
}

/** Field limits — shared with the endpoint so what can be saved is what can be shown. */
export const PRODUCT_LIMITS = { name: 120, description: 1200, benefits: 1200, price: 120, audience: 400, url: 500 } as const;
/** How many products a prompt carries, and its character budget. A catalogue past this is cut, and the block says so. */
export const PRODUCT_PROMPT_MAX = 40;
const BLOCK_CHAR_BUDGET = 9000;

const oneLine = (s: string | null | undefined, max: number) =>
    String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function renderOne(p: OrgProduct): string {
    const head = `• ${oneLine(p.name, PRODUCT_LIMITS.name)} (${p.kind === 'service' ? 'service' : 'product'})`;
    const lines = [head];
    const add = (label: string, v: string | null | undefined, max: number) => {
        const t = oneLine(v, max);
        if (t) lines.push(`  ${label}: ${t}`);
    };
    add('What it is', p.description, PRODUCT_LIMITS.description);
    add('Key benefits', p.benefits, PRODUCT_LIMITS.benefits);
    add('Price', p.price, PRODUCT_LIMITS.price);
    add('Who it is for', p.audience, PRODUCT_LIMITS.audience);
    add('Link', p.url, PRODUCT_LIMITS.url);
    return lines.join('\n');
}

/**
 * Render the catalogue for a prompt, or null when there is none. Pure — tested without a database.
 *
 * The rules are the point: a model told "here are the products" will happily round a price, add a
 * discount, or invent a feature that sounds like the rest. A price that is not listed must not be
 * stated; a product not listed must not be offered.
 */
export function renderProductsBlock(products: OrgProduct[] | null | undefined, businessName?: string | null): string | null {
    const list = (products ?? []).filter((p) => oneLine(p?.name, PRODUCT_LIMITS.name));
    if (!list.length) return null;
    const who = oneLine(businessName, 120) || 'this business';
    const shown: string[] = [];
    let used = 0;
    for (const p of list.slice(0, PRODUCT_PROMPT_MAX)) {
        const r = renderOne(p);
        if (used + r.length > BLOCK_CHAR_BUDGET) break;
        shown.push(r);
        used += r.length + 1;
    }
    const hidden = list.length - shown.length;
    return [
        `<products_and_services>`,
        `What ${who} sells, exactly as the business recorded it (Business Information ▸ Products & Services). These are FACTS — use them as written:`,
        `- Name products and services exactly as listed. Never invent one that is not listed, and never describe a feature, result or guarantee the entry does not state.`,
        `- Quote a price ONLY when it is listed below, and quote it exactly — never round it, convert it or add a discount, offer or deadline. If a price is not listed, do not state one.`,
        `- Bring a product in only where it genuinely fits the task. Not every piece of work is a sales pitch; most should not mention a product at all.`,
        `- When linking to a product, use its listed link and no other.`,
        '',
        ...shown,
        hidden > 0 ? `\n(${hidden} more not shown here. If the user asks about one that is not listed, ask them rather than guessing.)` : '',
        `</products_and_services>`,
    ].filter((l) => l !== '').join('\n');
}

/**
 * The catalogue as bare FACTS — no writing rules — for a reviewer checking a claim, not writing one
 * (src/utils/post-quality-review.ts). Name, kind and price only: a reviewer needs to know a listed
 * price is the real one, and a long description would crowd the caption out of its prompt.
 */
export function renderProductFacts(products: OrgProduct[] | null | undefined, maxChars = 2500): string {
    const lines = (products ?? [])
        .filter((p) => oneLine(p?.name, PRODUCT_LIMITS.name))
        .map((p) => `- ${oneLine(p.name, PRODUCT_LIMITS.name)} (${p.kind === 'service' ? 'service' : 'product'})${oneLine(p.price, PRODUCT_LIMITS.price) ? ` — ${oneLine(p.price, PRODUCT_LIMITS.price)}` : ' — no price listed'}${oneLine(p.url, PRODUCT_LIMITS.url) ? ` — ${oneLine(p.url, PRODUCT_LIMITS.url)}` : ''}`);
    if (!lines.length) return '';
    return `Products and services the business lists (Business Information), with their only valid prices:\n${lines.join('\n')}`.slice(0, maxChars);
}

/** The ACTIVE catalogue, in the business's own order. [] on any failure. */
export async function loadOrgProducts(db: Db, organisationId: number): Promise<OrgProduct[]> {
    try {
        return await db
            .select({
                kind: orgProducts.kind, name: orgProducts.name, description: orgProducts.description,
                benefits: orgProducts.benefits, price: orgProducts.price, audience: orgProducts.audience, url: orgProducts.url,
            })
            .from(orgProducts)
            .where(and(eq(orgProducts.organisationId, organisationId), eq(orgProducts.status, 'active')))
            .orderBy(asc(orgProducts.sortOrder), asc(orgProducts.id))
            .limit(PRODUCT_PROMPT_MAX + 1);
    } catch (err) {
        console.error('[org-products] could not read products (continuing without them):', (err as Error)?.message ?? err);
        return [];
    }
}

/** Load + render in one call — what most seams want. Never throws; null when there is nothing to add. */
export async function loadProductsBlock(db: Db, organisationId: number, businessName?: string | null): Promise<string | null> {
    return renderProductsBlock(await loadOrgProducts(db, organisationId), businessName);
}
