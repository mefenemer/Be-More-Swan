// src/public/site-theme-core.d.ts
// Types for the shared site-theme core. The implementation is plain .js so the SAME artifact runs on
// the server (netlify/functions/site-theme.ts) and in the admin editor — see its header.

export type SiteTheme = Record<string, string | null>;

export interface ThemeToken {
    key: string;
    label: string;
    type: 'color' | 'font' | 'select';
    default: string | null;
    help?: string;
    options?: { value: string; label: string }[];
}

export const GROUPS: { id: string; title: string; button?: string; tokens: ThemeToken[] }[];
export const TOKENS: ThemeToken[];
export const FONTS: { value: string; label: string; google: string | null }[];
export const BY_KEY: Record<string, ThemeToken>;
export function defaults(): SiteTheme;
/** Every key present and type-checked; unknown keys dropped. Nothing free-form survives. */
export function normalizeTheme(raw: unknown): SiteTheme;
/** The theme as CSS — only CHANGED tokens produce rules. '' for the default theme. */
export function themeCss(theme: unknown): string;
export function fontUrl(theme: unknown): string | null;
