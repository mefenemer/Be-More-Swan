// src/config/assistant-features.ts
//
// SINGLE SOURCE OF TRUTH for the per-assistant feature catalogue.
//
// Each entry is a capability an admin can switch on/off per assistant TYPE (master_assistants
// row) from the admin "Assistant Features" page. The enabled/disabled state is stored per
// (master_assistant, feature_key) in the `assistant_features` table; this file defines which
// keys exist, how they're labelled, and how they're grouped.
//
// Consumers:
//   - admin-api.ts `assistant-features` resource — renders columns, validates PATCH keys.
//   - src/utils/assistant-capabilities.ts — resolves whether an org can use a feature.
//   - user-facing gates (generate-ai-image/video, get-ai-credit-balance, My Content modal).
//
// Adding a feature = add an entry here, surface a checkbox (automatic in the admin matrix),
// and gate the relevant call site on `orgHasAssistantFeature(orgId, key)`.

export interface AssistantFeature {
    key: string;
    label: string;
    description: string;
    category: string;
}

export const ASSISTANT_FEATURES: readonly AssistantFeature[] = [
    {
        key: 'ai_image_generation',
        label: 'AI Image Generation',
        description: 'Generate images with AI in My Content.',
        category: 'Media',
    },
    {
        key: 'ai_video_generation',
        label: 'AI Video Generation',
        description: 'Generate videos with AI in My Content (a premium plan is also required).',
        category: 'Media',
    },
    {
        key: 'relationship_building_checklist',
        label: 'Relationship Building Checklist',
        description: 'Daily AI-generated checklist of engagement, outreach, and community tasks. Reserved for a future assistant type — not available for Social Media Manager.',
        category: 'Engagement',
    },
] as const;

export const ASSISTANT_FEATURE_KEYS = ASSISTANT_FEATURES.map(f => f.key);

export function isAssistantFeatureKey(key: string): boolean {
    return ASSISTANT_FEATURE_KEYS.includes(key);
}
