// The settings a recipe actually needs, in plain words, chosen from a list rather than typed — defined
// in CODE for the recipes the code reads settings from (owner, 2026-11-17, Meeting Note Taker step 8).
//
// The catalogue's field_schema (integration_scenarios) is a CRM-style "map a Be More Swan field to an
// external field" form. For these recipes that form was wrong in three ways the real-account run hit:
//   • Slack asked for a summary, a time and tasks — nothing reads them — and never for the channel,
//     the one setting the code does read.
//   • Jira asked for an issue type the user had no reason to change, and a project key typed by hand
//     ("Scrum" for SCRUM) with nothing to stop a wrong one.
//   • Asana asked for a project ID copied out of an address bar.
// So these recipes carry their real settings here, each one a picker filled from the connected tool
// (integration-scenarios.ts GET /options), and cleanRecipeSettings() keeps only these keys on save.
// Recipes not listed keep their catalogue field_schema.

export type RecipePicker = 'jira_projects' | 'asana_projects' | 'slack_channels';

export interface RecipeSetting {
    /** The key the handler reads from the active scenario's fieldMappings. */
    key: string;
    label: string;
    picker: RecipePicker;
    required: boolean;
    /** One line under the picker. */
    help: string;
}

export const RECIPE_SETTINGS: Record<string, RecipeSetting[]> = {
    jira_create_tasks: [{
        key: 'projectKey', label: 'Jira project', picker: 'jira_projects', required: true,
        help: 'Each action item becomes a task in this project.',
    }],
    asana_create_tasks: [{
        key: 'asanaProjectGid', label: 'Asana project', picker: 'asana_projects', required: true,
        help: 'Each action item becomes a task in this project.',
    }],
    slack_meeting_summary: [{
        key: 'channel', label: 'Slack channel', picker: 'slack_channels', required: false,
        help: 'Leave it on your main channel, or pick another public channel.',
    }],
};

/** What each of these recipes does, in the words the settings now mean. Replaces the catalogue text. */
export const RECIPE_DESCRIPTIONS: Record<string, string> = {
    jira_create_tasks: 'When you approve a meeting, each action item becomes a Jira task (issue type: Task) in the project you choose, with its owner and due date.',
    asana_create_tasks: 'When you approve a meeting, each action item becomes an Asana task in the project you choose, with its owner and due date.',
    slack_meeting_summary: 'When you approve a meeting, its summary and action items are posted to the Slack channel you choose.',
};

/**
 * Task tools: ONE per assistant (owner, 2026-11-17). Both on split a meeting's action items between them
 * (they share one action_items ledger), so switching one on switches the others off — like email, where
 * one inbox sends.
 */
export const TASK_TOOL_RECIPES: readonly string[] = ['jira_create_tasks', 'asana_create_tasks'];

/** The provider whose connection fills a picker. */
export const PICKER_PROVIDER: Record<RecipePicker, 'jira' | 'asana' | 'slack'> = {
    jira_projects: 'jira',
    asana_projects: 'asana',
    slack_channels: 'slack',
};

/** A Jira project key as Jira stores it: upper case, letters/digits/underscore, starting with a letter. */
export function normaliseJiraKey(v: string): string {
    return v.trim().toUpperCase();
}
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;

/**
 * The saved settings for a recipe listed above: only its own keys (plus `<key>Label`, the name shown
 * for a picked value), trimmed, a Jira key upper-cased. Anything else the form or an old catalogue
 * mapping sent is dropped. Pure.
 */
export function cleanRecipeSettings(scenarioKey: string, input: unknown): { ok: true; mappings: Record<string, string> } | { ok: false; error: string } {
    const defs = RECIPE_SETTINGS[scenarioKey];
    if (!defs) return { ok: false, error: 'This recipe has no settings of its own.' };
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const out: Record<string, string> = {};
    for (const d of defs) {
        let v = typeof src[d.key] === 'string' ? (src[d.key] as string).trim() : '';
        if (d.picker === 'jira_projects' && v) {
            v = normaliseJiraKey(v);
            if (!JIRA_KEY.test(v)) return { ok: false, error: `“${v}” isn’t a Jira project key. Pick the project from the list.` };
        }
        if (d.required && !v) return { ok: false, error: `Choose the ${d.label} first.` };
        if (v) {
            out[d.key] = v.slice(0, 200);
            const label = typeof src[`${d.key}Label`] === 'string' ? (src[`${d.key}Label`] as string).trim().slice(0, 200) : '';
            if (label) out[`${d.key}Label`] = label;
        }
    }
    return { ok: true, mappings: out };
}

/** True when a recipe's required settings are missing — the form opens itself after connecting. Pure. */
export function needsRecipeSettings(scenarioKey: string, mappings: unknown): boolean {
    const defs = RECIPE_SETTINGS[scenarioKey];
    if (!defs) return false;
    const m = mappings && typeof mappings === 'object' ? mappings as Record<string, unknown> : {};
    return defs.some((d) => d.required && !(typeof m[d.key] === 'string' && (m[d.key] as string).trim()));
}
