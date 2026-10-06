// src/public/content-pillars.d.ts — types for the shared pillar splitter (see content-pillars.js).
export function parsePillars(raw: unknown): string[];
export function pillarWarnings(raw: unknown): string[];
export const MAX_PILLARS: number;
export const MAX_PILLAR_CHARS: number;
