// Types for ai-readability.mjs, which stays plain ESM because the Netlify build runs
// scripts/build-seo-html.mjs with bare `node`, where a compile step would be in the way.
type Data = Record<string, any>;
export interface AssistantPage { slug: string; name: string }

export declare const SITE_ORIGIN: string;
export declare function escHtml(s: unknown): string;
export declare function escAttr(s: unknown): string;
export declare function formatGbp(amount: number | string): string;

export declare function bakePlanPriceSlots(html: string, plans: Data[]): { html: string; filled: number; missing: string[] };
export declare function pricingCardTexts(plans: Data[], enterprisePlan?: Data | null): Record<string, string>;
export declare function applyTextById(html: string, texts: Record<string, string>): { html: string; applied: string[]; skipped: string[] };
export declare function pricingJsonLd(plans: Data[]): string;

export declare const ASSISTANT_PAGE_SLUGS: Record<string, string>;
export declare function slugForRole(roleKey: string, name?: string): { slug: string; pinned: boolean };
export declare function isLiveRole(a: Data | null | undefined): boolean;
export declare function assistantStaticHtml(c: Data, sc: Data | null, pages: Record<string, AssistantPage>): string;
export declare function assistantJsonLd(c: Data, sc: Data | null, slug: string): string;
export declare function buildAssistantPage(template: string, opts: {
    roleKey: string; slug: string; c: Data; sc: Data | null; pages: Record<string, AssistantPage>; ogImage?: string | null;
}): { html: string; errors: string[] };
export declare function assistantPagesJs(pages: Record<string, AssistantPage>): string;
export declare function libraryStaticCards(assistants: Data[], pages: Record<string, AssistantPage>): string;
export declare function sitemapEntries(pages: Record<string, AssistantPage>): string;
export declare function llmsGeneratedSections(input: {
    assistants: Data[]; showcases: Record<string, Data | null>; pages: Record<string, AssistantPage>;
    plans: Data[]; enterprisePlan?: Data | null; articles: Array<{ title: string }>;
}): string;
