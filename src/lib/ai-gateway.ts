// src/lib/ai-gateway.ts
// Centralized AI Gateway for all LLM calls in Be More Swan.
// US-AI-GW-1 (centralized routing) + US-AI-GW-2 (failover on 429/503).
//
// Config:
//   AI_GATEWAY_PRIMARY_MODEL   — defaults to claude-sonnet-4-6
//   AI_GATEWAY_FALLBACK_MODEL  — defaults to claude-haiku-4-5-20251001
//
// Changing the target model requires only an env-var update; no business logic changes needed.

import Anthropic from '@anthropic-ai/sdk';

export interface GatewayRequest {
    system: string;
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
}

export interface GatewayResponse {
    text: string;
    model: string;
    usedFallback: boolean;
    tokensInput: number | null;
    tokensOutput: number | null;
}

const PRIMARY_MODEL  = process.env.AI_GATEWAY_PRIMARY_MODEL  ?? 'claude-sonnet-4-6';
const FALLBACK_MODEL = process.env.AI_GATEWAY_FALLBACK_MODEL ?? 'claude-haiku-4-5-20251001';

const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 24_000,
});

function isFailoverError(err: unknown): boolean {
    if (err instanceof Anthropic.RateLimitError)     return true;  // 429
    if (err instanceof Anthropic.APIError && err.status === 503) return true;
    return false;
}

async function callModel(model: string, req: GatewayRequest): Promise<Anthropic.Message> {
    return client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: req.messages,
    });
}

export async function gatewayGenerate(req: GatewayRequest): Promise<GatewayResponse> {
    let response: Anthropic.Message;
    let usedFallback = false;

    try {
        response = await callModel(PRIMARY_MODEL, req);
    } catch (primaryErr) {
        if (!isFailoverError(primaryErr)) {
            // 400 Bad Request and other non-retriable errors are NOT falled over (AC4)
            throw primaryErr;
        }
        // AC2: 429 or 503 → route to fallback transparently (AC3)
        console.warn('[ai-gateway] primary model error, failing over to', FALLBACK_MODEL, primaryErr instanceof Error ? primaryErr.message : primaryErr);
        response = await callModel(FALLBACK_MODEL, req);
        usedFallback = true;
    }

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return {
        text,
        model: response.model,
        usedFallback,
        tokensInput:  response.usage?.input_tokens  ?? null,
        tokensOutput: response.usage?.output_tokens ?? null,
    };
}
