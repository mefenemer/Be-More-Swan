// src/public/brand-contrast.d.ts
// Types for the shared brand colour maths. The implementation is deliberately plain .js so the SAME
// artifact runs in the browser (the newsletter canvas) and on the server (brand cards, and the
// newsletter theme resolver) — see brand-contrast.js's header for why a second copy is not an option.

/** A colour the renderer can actually paint with: #rgb / #rrggbb, normalized to lowercase #rrggbb. */
export function normalizeHex(raw: unknown): string | null;

/** WCAG 2.1 relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number;

/** HSL saturation, 0…1. Tells a brand accent apart from a grey/canvas/ink colour. */
export function saturation(hex: string): number;

/** WCAG contrast ratio between two colours, 1:1 … 21:1. */
export function contrastRatio(a: string, b: string): number;

/** White when it is legible on `background`, otherwise the dark ink. */
export function readableInkOn(background: string, ink?: string): string;

/** Blend two hex colours; `t` is how much of `b` to mix in. */
export function mixHex(a: string, b: string, t: number): string;

/** `colour`, walked toward black or white until it clears `min` on `against`. */
export function ensureContrast(colour: string, against: string, min?: number): string | null;

/** Large display type only needs 3:1 under WCAG. */
export const MIN_DISPLAY_CONTRAST: number;

/** WCAG AA for body text. A link is body text. */
export const MIN_BODY_CONTRAST: number;
