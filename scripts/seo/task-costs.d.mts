// Types for task-costs.mjs (plain ESM: the Netlify build runs build-seo-html.mjs with bare `node`).
export interface TaskCostFigures {
    weights: Record<string, number>;
    videoTasksPerSecond: number;
    chatMessagesPerTask: number;
    videoPricedBySecond: boolean;
    basicWorkCharged?: boolean;
}
export declare function taskCostText(key: string, figures: TaskCostFigures | null, seconds?: number): string | null;
export declare function bakeTaskCostSpans(html: string, figures: TaskCostFigures): { html: string; count: number; unknown: string[] };
export declare function pageFallbacks(html: string): Record<string, string>;
export declare function fillJsonLdTaskTokens(html: string, figures: TaskCostFigures | null): { html: string; count: number; unresolved: string[] };
