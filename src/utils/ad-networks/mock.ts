// src/utils/ad-networks/mock.ts
// A deterministic, in-memory ad network. Never reachable by a tenant — see registry.ts.
//
// ── What it is for ──────────────────────────────────────────────────────────────────────────────
// The real adapters cannot be written yet (no API access), but the machinery ABOVE them can be, and
// that machinery is where the expensive mistakes live: staging something active by accident,
// raising a budget, a kill switch that does not fire. Testing all of that against a real API we do
// not have would mean testing none of it, so it is tested against this.
//
// ── Deterministic, and it refuses rather than pretends ──────────────────────────────────────────
// No randomness and no clock of its own: given the same calls it returns the same answers, so a
// test asserting an optimiser decision is asserting the optimiser, not a coin flip. And it enforces
// the same rules a real network would — activating an unknown campaign throws, pausing a variant
// twice is a no-op, metrics for an unknown variant come back empty rather than as zeroes. A mock
// that always succeeds tests nothing except that the code compiles.

import type {
    AdNetworkAdapter, StageCampaignInput, StageCampaignResult, VariantMetrics,
} from './types';

interface MockVariant {
    externalId: string;
    variantId: number;
    status: 'paused' | 'active';
    /** Daily rows, oldest first. Seeded by seedMetrics() in tests. */
    metrics: VariantMetrics[];
}

interface MockCampaign {
    externalId: string;
    status: 'paused' | 'active';
    dailyBudgetGbp: number;
    variants: Map<number, MockVariant>;
    controlOk: boolean;
}

const store = new Map<string, MockCampaign>();
let seq = 0;

/** Test helper: wipe everything between cases so one test cannot leak into the next. */
export function _resetMock(): void {
    store.clear();
    seq = 0;
}

/** Test helper: hand a variant a performance history. */
export function _seedMetrics(externalVariantId: string, rows: Omit<VariantMetrics, 'externalVariantId'>[]): void {
    for (const c of store.values()) {
        for (const v of c.variants.values()) {
            if (v.externalId === externalVariantId) {
                v.metrics = rows.map((r) => ({ ...r, externalVariantId }));
                return;
            }
        }
    }
    throw new Error(`mock: unknown variant ${externalVariantId}`);
}

/** Test helper: simulate the ad account becoming unreachable mid-flight. */
export function _breakControl(externalCampaignId: string): void {
    const c = store.get(externalCampaignId);
    if (!c) throw new Error(`mock: unknown campaign ${externalCampaignId}`);
    c.controlOk = false;
}

/** Test helper: read the true state, to assert what the adapter actually did. */
export function _inspect(externalCampaignId: string) {
    const c = store.get(externalCampaignId);
    if (!c) return null;
    return {
        status: c.status,
        dailyBudgetGbp: c.dailyBudgetGbp,
        variants: [...c.variants.values()].map((v) => ({ externalId: v.externalId, status: v.status })),
    };
}

export const mockAdapter: AdNetworkAdapter = {
    key: 'mock',
    label: 'Mock network (development only)',

    async stageCampaign(input: StageCampaignInput): Promise<StageCampaignResult> {
        if (!input.variants.length) throw new Error('mock: a campaign needs at least one variant');
        if (!(input.dailyBudgetGbp > 0)) throw new Error('mock: a paid campaign needs a positive daily budget');

        const externalId = `mock_c_${++seq}`;
        const variants = new Map<number, MockVariant>();
        const externalVariantIds: Record<number, string> = {};
        for (const v of input.variants) {
            const vid = `mock_v_${++seq}`;
            // ⚠️ PAUSED. A real adapter that staged anything else would be a spend nobody approved,
            // and this mock exists partly so a test can prove the caller never assumes otherwise.
            variants.set(v.variantId, { externalId: vid, variantId: v.variantId, status: 'paused', metrics: [] });
            externalVariantIds[v.variantId] = vid;
        }
        store.set(externalId, {
            externalId, status: 'paused', dailyBudgetGbp: input.dailyBudgetGbp, variants, controlOk: true,
        });
        return { externalCampaignId: externalId, externalVariantIds, status: 'paused' };
    },

    async activateCampaign(externalCampaignId: string): Promise<void> {
        const c = store.get(externalCampaignId);
        if (!c) throw new Error(`mock: unknown campaign ${externalCampaignId}`);
        if (!c.controlOk) throw new Error('mock: control lost — cannot activate');
        c.status = 'active';
        // Only variants that are still staged go live. One a human rejected before launch stays
        // paused, which is the behaviour a real network would need to be told about explicitly.
        for (const v of c.variants.values()) if (v.status === 'paused') v.status = 'active';
    },

    async pauseVariant(externalVariantId: string, _reason: string): Promise<void> {
        for (const c of store.values()) {
            for (const v of c.variants.values()) {
                if (v.externalId === externalVariantId) {
                    if (!c.controlOk) throw new Error('mock: control lost — cannot pause');
                    v.status = 'paused';
                    return;
                }
            }
        }
        throw new Error(`mock: unknown variant ${externalVariantId}`);
    },

    async pauseCampaign(externalCampaignId: string): Promise<void> {
        const c = store.get(externalCampaignId);
        if (!c) throw new Error(`mock: unknown campaign ${externalCampaignId}`);
        if (!c.controlOk) throw new Error('mock: control lost — cannot pause');
        c.status = 'paused';
        for (const v of c.variants.values()) v.status = 'paused';
    },

    async fetchMetrics(externalVariantIds: string[], days: number): Promise<VariantMetrics[]> {
        const wanted = new Set(externalVariantIds);
        const out: VariantMetrics[] = [];
        for (const c of store.values()) {
            for (const v of c.variants.values()) {
                if (!wanted.has(v.externalId)) continue;
                // Newest `days` rows. An unknown variant contributes NOTHING rather than a row of
                // zeroes — zeroes would read as "it ran and got nothing", which is a different and
                // much more alarming fact than "we have no data".
                out.push(...v.metrics.slice(-days));
            }
        }
        return out;
    },

    async checkControl(externalCampaignId: string): Promise<{ ok: boolean; detail?: string }> {
        const c = store.get(externalCampaignId);
        if (!c) return { ok: false, detail: 'Campaign not found on the network.' };
        return c.controlOk ? { ok: true } : { ok: false, detail: 'The ad account is no longer reachable.' };
    },
};
