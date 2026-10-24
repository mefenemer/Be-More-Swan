// src/config/model-options.ts
// The Claude models an admin can choose for an assistant role (Admin ▸ Assistants ▸ Model & rules),
// and the one adapter every role-model call goes through. Pure — no database, no SDK client.
//
// Why an adapter, not just a model string (owner asked 2026-10-24 to move roles between Haiku,
// Sonnet and Opus): the current generation is NOT a drop-in swap for the models this codebase was
// written against.
//   • They think before answering — Opus 5.5 always, and thinking can't be switched off — and the
//     thinking counts against max_tokens. Calls here ask for 400–2,000 tokens; on a thinking model
//     those come back cut off or empty.
//   • The reply starts with a thinking block, so `content[0].text` (the reading in newsletter,
//     blog, chat and lead generation) is '' — every draft would fail as "empty".
//   • A non-default temperature is a 400 on them (voice-preview, discovery scoring set one).
// So a call made with a role's model goes through adaptForModel() and reads replyText().
//
// Prices are Anthropic list prices per million tokens (claude-api reference, cached 2026-10-06);
// ai-usage.ts LIST_PRICE_PER_1K is what COGS records and must carry the same figures.

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export interface ModelOption {
    id: string;
    label: string;
    /** 'current' = the newest generation; 'previous' = what the code was written against. */
    generation: 'current' | 'previous';
    inPerM: number;
    outPerM: number;
    /** 'none' = never thinks here; 'optional' = can be switched off; 'always' = cannot. */
    thinking: 'none' | 'optional' | 'always';
    /** How 'off' is sent, for a model whose thinking is optional and on by default. */
    offMode?: 'disabled' | 'between_tools';
    /** Accepts temperature / top_p / top_k. */
    sampling: boolean;
    summary: string;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', generation: 'current', inPerM: 0.10, outPerM: 0.50, thinking: 'optional', offMode: 'disabled', sampling: false,
      summary: 'Fastest and cheapest. In the 2026-10-24 head-to-head it wrote close to Sonnet 5.5 quality at a tenth of today\'s cost.' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', generation: 'current', inPerM: 2, outPerM: 10, thinking: 'optional', offMode: 'between_tools', sampling: false,
      summary: 'Strong all-rounder. Near Opus quality in the head-to-head; cheaper per token than Sonnet 4.6.' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', generation: 'current', inPerM: 4, outPerM: 20, thinking: 'always', sampling: false,
      summary: 'Best writing and most accurate specialist detail, and the slowest. Always thinks, so it cannot be set to Off.' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', generation: 'previous', inPerM: 3, outPerM: 15, thinking: 'none', sampling: true,
      summary: 'Previous generation. Today\'s social drafting model.' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', generation: 'previous', inPerM: 1, outPerM: 5, thinking: 'none', sampling: true,
      summary: 'Previous generation. Today\'s chat, email, blog and lead model.' },
];

export function modelOption(id: string | null | undefined): ModelOption | null {
    return MODEL_OPTIONS.find((m) => m.id === id) ?? null;
}

/** The thinking level a model can actually run at: Opus can't be Off; previous-generation models are always Off. */
export function effectiveThinking(model: string, level: ThinkingLevel | null | undefined): ThinkingLevel {
    const m = modelOption(model);
    if (!m || m.thinking === 'none') return 'off';
    const l = THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : 'low';
    return m.thinking === 'always' && l === 'off' ? 'low' : l;
}

// Room for the thinking on top of the reply the caller asked for. Capped at 16,000 total: above
// ~21k the SDK refuses a non-streaming call outright ("streaming is strongly recommended").
const THINKING_HEADROOM: Record<ThinkingLevel, number> = { off: 0, low: 4000, medium: 8000, high: 12000 };
const MAX_NON_STREAMING_TOKENS = 16_000;

interface CallParams { model: string; max_tokens: number; temperature?: number; top_p?: number; top_k?: number; [k: string]: unknown }

/**
 * The request for `model`, made safe for it. Previous-generation models get the params untouched,
 * so a role left on its default behaves byte-for-byte as before. Pure — returns a new object.
 */
export function adaptForModel<T extends CallParams>(params: T, model: string, level: ThinkingLevel | null | undefined): T {
    const m = modelOption(model);
    const out: CallParams = { ...params, model };
    if (!m || m.thinking === 'none') return out as T;
    if (!m.sampling) { delete out.temperature; delete out.top_p; delete out.top_k; }
    const t = effectiveThinking(model, level);
    if (t === 'off') {
        out.thinking = { type: m.offMode ?? 'disabled' };
        return out as T;
    }
    out.thinking = { type: 'adaptive' };
    out.output_config = { ...(out.output_config as object | undefined), effort: t };
    out.max_tokens = Math.min(MAX_NON_STREAMING_TOKENS, params.max_tokens + THINKING_HEADROOM[t]);
    return out as T;
}

/** All the text in a reply, whatever blocks come first. Replaces `content[0].text`. Pure. */
export function replyText(content: ReadonlyArray<{ type: string; text?: string }> | null | undefined): string {
    return (content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

// ── Cost estimates for the admin page ────────────────────────────────────────────────────────────
// Measured in the 2026-10-24 head-to-head (18 drafts × 4 setups, same prompts): the current
// generation's tokenizer counted ~1.38× the input tokens of Sonnet 4.6 / Haiku 4.5 for the same
// prompt, and thinking at the default effort added ~850 output tokens to a social post and ~1,100 to
// an email. Low effort is estimated at half that. Estimates, labelled as such on the page.
const NEW_TOKENIZER_FACTOR = 1.38;
const THINKING_OUTPUT_ESTIMATE: Record<ThinkingLevel, number> = { off: 0, low: 450, medium: 900, high: 1500 };

/** Estimated USD for one call that took `inTok`/`outTok` on `fromModel`, if made on `toModel`. Pure. */
export function estimateCallUsd(fromModel: string, toModel: string, inTok: number, outTok: number, level: ThinkingLevel = 'low'): number | null {
    const from = modelOption(fromModel);
    const to = modelOption(toModel);
    if (!to) return null;
    const factor = from?.generation === 'previous' && to.generation === 'current' ? NEW_TOKENIZER_FACTOR
        : from?.generation === 'current' && to.generation === 'previous' ? 1 / NEW_TOKENIZER_FACTOR : 1;
    const thinkingOut = THINKING_OUTPUT_ESTIMATE[effectiveThinking(toModel, level)];
    return (inTok * factor * to.inPerM + (outTok + thinkingOut) * to.outPerM) / 1e6;
}
