// seed/schemas.ts
// Epic: Superadmin Environment Management — US6.2 (Schema Validation).
//
// Zod schemas for the version-controlled master-data JSON files in seed/data/.
// run-seed.ts validates every file against these BEFORE any database INSERT, so a
// typo in JSON fails fast with a readable error instead of crashing mid-seed.

import { z } from 'zod';

// Numeric money columns are stored as strings (Drizzle `numeric`). Accept a string
// or number in JSON and normalise to a 2dp string.
const Money = z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2));

export const MasterPlanSchema = z.object({
    tierKey: z.string().min(1),
    name: z.string().min(1),
    monthlyPriceGbp: Money,
    assistantLimit: z.number().int().nullable().optional(),
    monthlyTaskLimit: z.number().int().nullable().optional(),
    monthlyTokenLimit: z.number().int().nullable().optional(),
    appConnectionLimit: z.number().int().nullable().optional(),
    seatLimit: z.number().int().nullable().optional(),
    storageLimitBytes: z.number().int().nullable().optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    isActive: z.boolean().default(true),
});

export const PlanPriceSchema = z.object({
    // Natural key: plan tier + currency. masterPlanId is resolved at seed time so the
    // JSON stays portable across environments (never references numeric PKs — US6/db-seed).
    planTierKey: z.string().min(1),
    currency: z.string().length(3),
    monthlyPriceMajorUnit: Money,
    isActive: z.boolean().default(true),
});

export const MasterAssistantSchema = z.object({
    roleKey: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.string().optional(),
    iconKey: z.string().optional(),
    iconColor: z.string().optional(),
    comingSoon: z.boolean().default(false),
    isActive: z.boolean().default(true),
    lifecycleState: z.enum(['draft', 'review', 'beta', 'live', 'deprecated', 'archived']).optional(),
    riskClassification: z.enum(['minimal', 'limited', 'high_risk_borderline', 'high_risk']).optional(),
});

export const BenchmarkSchema = z.object({
    key: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    categories: z.array(z.string()).min(1),
});

export const MasterPlansFile = z.array(MasterPlanSchema);
export const PlanPricesFile = z.array(PlanPriceSchema);
export const MasterAssistantsFile = z.array(MasterAssistantSchema);
export const BenchmarksFile = z.array(BenchmarkSchema);

export type MasterPlan = z.infer<typeof MasterPlanSchema>;
export type PlanPrice = z.infer<typeof PlanPriceSchema>;
export type MasterAssistant = z.infer<typeof MasterAssistantSchema>;
export type Benchmark = z.infer<typeof BenchmarkSchema>;
