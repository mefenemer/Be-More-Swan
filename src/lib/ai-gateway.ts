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
    /**
     * Total wall-clock budget for the whole call, in ms — including failover and any `pause_turn`
     * resumes. Optional, and unbounded when omitted, which is right for a worker that may run for
     * minutes.
     *
     * It matters for a call made inside a REQUEST. A Netlify synchronous function is killed at 26s,
     * and the platform's kill produces a response with NO BODY — so a handler that overruns cannot
     * report anything, however careful its own try/catch is. The browser gets an unexplained failure
     * and the user gets a generic message. Callers on a request path must pass a budget that leaves
     * room to serialise a reply.
     */
    deadlineMs?: number;
}

export interface GatewayResponse {
    /**
     * Why the model stopped. 'max_tokens' means the reply was CUT OFF — the single most useful
     * thing to know when a structured reply fails to parse, and previously invisible to callers,
     * which is why process-content-jobs could only report "likely truncated" as a guess.
     */
    stopReason: string | null;
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

/**
 * Did this call run out of time? Callers on a request path need to tell a timeout apart from a real
 * failure, and they cannot do it by name: the SDK never sets `.name` on its error classes, so
 * `err.name === 'APIConnectionTimeoutError'` is inherited `'Error'` and never matches. Ask the
 * class itself, here, so the SDK stays behind this module.
 */
export function isTimeoutError(err: unknown): boolean {
    return err instanceof Anthropic.APIConnectionTimeoutError;
}

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
        stopReason: response.stop_reason ?? null,
        model: response.model,
        usedFallback,
        tokensInput:  response.usage?.input_tokens  ?? null,
        tokensOutput: response.usage?.output_tokens ?? null,
    };
}

// ── Web search ───────────────────────────────────────────────────────────────────────────────
// A second entry point rather than a flag on gatewayGenerate, because the caller needs something
// gatewayGenerate deliberately does not return: the URLs the SEARCH TOOL actually returned, as
// distinct from URLs the model wrote in its prose.
//
// That distinction is the whole point. A model asked to "verify this statistic" with no search
// ability will happily produce a confident, plausible, non-existent citation — and in a compliance
// control a fabricated source is worse than no source, because it launders an unverified claim into
// a filed one. Callers must check a proposed URL against `searchedUrls` and reject anything that
// isn't there.

export interface GroundedResponse extends GatewayResponse {
    /** Every URL returned by the search tool itself. The allow-list for any citation. */
    searchedUrls: string[];
    /** How many searches actually ran. Zero means the model answered without looking anything up. */
    searchCount: number;
}

/**
 * The tool spec differs by model generation, and sending the wrong one is a 400 rather than a
 * graceful degrade — so pick it from the model id.
 */
function webSearchTool(model: string): Anthropic.Messages.ToolUnion {
    const dynamicFiltering = /opus-4-(6|7|8)|sonnet-5|sonnet-4-6|fable-5/.test(model);
    return {
        type: dynamicFiltering ? 'web_search_20260209' : 'web_search_20250305',
        name: 'web_search',
        max_uses: 4,
    } as Anthropic.Messages.ToolUnion;
}

/** Pull the URLs out of the search tool's own result blocks — never out of the model's text. */
function collectSearchedUrls(content: Anthropic.ContentBlock[]): { urls: string[]; searches: number } {
    const urls: string[] = [];
    let searches = 0;
    for (const block of content as any[]) {
        if (block?.type === 'server_tool_use' && block?.name === 'web_search') searches++;
        if (block?.type !== 'web_search_tool_result') continue;
        // An ERROR result is an object, a success is an array. Indexing an error object silently
        // yields undefined, which would read as "no sources found" instead of "the search failed".
        const results = block.content;
        if (!Array.isArray(results)) continue;
        for (const r of results) if (typeof r?.url === 'string') urls.push(r.url);
    }
    return { urls: [...new Set(urls)], searches };
}

/**
 * Generate with the server-side web search tool available. Same failover rules as gatewayGenerate.
 *
 * `pause_turn` is handled by resuming: a search-heavy turn can hit the server-side iteration cap,
 * and treating that as a finished answer would silently truncate the verification mid-search.
 */
export async function gatewayGenerateGrounded(req: GatewayRequest): Promise<GroundedResponse> {
    let model = PRIMARY_MODEL;
    let usedFallback = false;

    // ── Staying inside the caller's budget ──────────────────────────────────────────────────────
    // This function can make FIVE model calls: the primary, a failover, and up to three pause_turn
    // resumes. At the client's 24s ceiling that is ~120s of wall clock — against a 26s cap on the
    // request paths that call it. Overrunning is not a slow answer, it is a BODYLESS platform 502
    // the handler never gets to explain (see deadlineMs).
    //
    // So each call is given only the time that actually remains, and an optional extra call is only
    // started when there is enough left to be worth starting. Running out returns what has been
    // gathered so far — a real, if thinner, answer — rather than throwing away a paid-for search.
    const startedAt = Date.now();
    const remaining = () => (req.deadlineMs === undefined ? Infinity : req.deadlineMs - (Date.now() - startedAt));
    // Below this there is not enough time for a search round trip to return anything useful, and
    // starting one only risks the overrun this budget exists to prevent.
    const MIN_CALL_MS = 6_000;

    const run = (m: string, messages: Anthropic.MessageParam[]) => {
        const left = remaining();
        return client.messages.create({
            model: m,
            max_tokens: req.maxTokens ?? 1024,
            system: req.system,
            messages,
            tools: [webSearchTool(m)],
        }, left === Infinity ? undefined : {
            timeout: Math.max(MIN_CALL_MS, left),
            // A `timeout` is per ATTEMPT, not per call: the SDK retries a connection timeout
            // maxRetries times (default 2) before it ever throws, so a 20s budget silently became
            // ~61s of wall clock — past the 26s function cap, which is a BODYLESS kill the caller
            // cannot report. When a deadline is given, the deadline has to be the whole story.
            maxRetries: 0,
        });
    };

    let messages = [...req.messages];
    let response: Anthropic.Message;
    try {
        response = await run(model, messages);
    } catch (primaryErr) {
        if (!isFailoverError(primaryErr)) throw primaryErr;
        // A failover is a second full call. With no room for one, the caller is better served by the
        // original error than by an overrun that reports nothing at all.
        if (remaining() < MIN_CALL_MS) {
            console.warn('[ai-gateway] grounded call: no budget left to fail over, surfacing primary error');
            throw primaryErr;
        }
        console.warn('[ai-gateway] primary model error on grounded call, failing over to', FALLBACK_MODEL);
        model = FALLBACK_MODEL;
        usedFallback = true;
        response = await run(model, messages);
    }

    const allContent: Anthropic.ContentBlock[] = [...response.content];
    // Resume a paused turn rather than accepting a half-finished search. Bounded twice — by a fixed
    // iteration cap so a runaway loop cannot burn search quota on one click, and by the time budget
    // so a legitimate resume cannot push the request past its deadline.
    for (let i = 0; i < 3 && response.stop_reason === 'pause_turn'; i++) {
        if (remaining() < MIN_CALL_MS) {
            console.warn('[ai-gateway] grounded call: budget spent, returning a paused turn unresumed');
            break;
        }
        messages = [...messages, { role: 'assistant', content: response.content as any }];
        response = await run(model, messages);
        allContent.push(...response.content);
    }

    const { urls, searches } = collectSearchedUrls(allContent);
    const text = allContent.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();

    return {
        text,
        stopReason: response.stop_reason ?? null,
        model: response.model,
        usedFallback,
        tokensInput:  response.usage?.input_tokens  ?? null,
        tokensOutput: response.usage?.output_tokens ?? null,
        searchedUrls: urls,
        searchCount: searches,
    };
}
