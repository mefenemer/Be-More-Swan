// scripts/seo/task-costs.mjs — task costs in the HTML the build publishes (build-seo-html.mjs, Job 10).
//
// Pages tag each cost as <span data-task-cost="ai_image">1 task</span> and /task-costs.js swaps in today's
// figure after load. A crawler that doesn't run JavaScript, and the FAQ JSON-LD the build generates from the
// page's own text, would only ever see the fallback inside the span. So at build the span text becomes the
// figure from /task-costs (Admin → Money → Task costs), and hand-written JSON-LD — which can hold no span —
// says {{tasks.<key>}}, filled here too.
//
// Pure: no fetching, no files. Worded exactly as task-costs.js label() and taskCostLabel() in
// src/config/task-weights.ts (tests/seo-task-costs.test.ts holds the three together).

const plural = (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/**
 * A cost as a customer reads it, from the /task-costs payload
 * ({ weights, videoTasksPerSecond, chatMessagesPerTask, videoPricedBySecond }). Null for an unknown key.
 * `seconds` (data-task-seconds) gives a clip of that length at the per-second rate.
 */
export function taskCostText(key, figures, seconds) {
    if (!figures) return null;
    if (seconds > 0 && typeof figures.videoTasksPerSecond === 'number') return plural(Math.ceil(seconds) * figures.videoTasksPerSecond);
    if (key === 'ai_video' && figures.videoPricedBySecond) return `${plural(figures.videoTasksPerSecond)} a second`;
    if (key === 'ai_video_per_second' && typeof figures.videoTasksPerSecond === 'number') return `${plural(figures.videoTasksPerSecond)} a second`;
    if (key === 'chat_messages_per_task' && typeof figures.chatMessagesPerTask === 'number') {
        return `every ${figures.chatMessagesPerTask} message${figures.chatMessagesPerTask === 1 ? '' : 's'}`;
    }
    const n = figures.weights && figures.weights[key];
    if (typeof n !== 'number') return null;
    return n === 0 ? 'no tasks' : plural(n);
}

const SPAN = /(<span\b[^>]*\bdata-task-cost="([a-z_]+)"[^>]*>)([^<]*)(<\/span>)/g;
const SECONDS = /\bdata-task-seconds="(\d+(?:\.\d+)?)"/;

/** Every tagged cost's text becomes today's figure. Returns the page and any key /task-costs doesn't know. */
export function bakeTaskCostSpans(html, figures) {
    const unknown = [];
    let count = 0;
    const out = html.replace(SPAN, (whole, open, key, text, close) => {
        const secs = Number((open.match(SECONDS) || [])[1]);
        const live = taskCostText(key, figures, secs);
        if (live === null) { unknown.push(key); return whole; }
        count++;
        return `${open}${live}${close}`;
    });
    return { html: out, count, unknown };
}

/** The text each key already shows on the page — the fallback when /task-costs can't be read. */
export function pageFallbacks(html) {
    const out = {};
    for (const m of html.matchAll(SPAN)) if (!SECONDS.test(m[1]) && !(m[2] in out)) out[m[2]] = m[3].trim();
    return out;
}

const LD = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g;
const TOKEN = /\{\{\s*tasks\.([a-z_]+)\s*\}\}/g;

/**
 * Fill {{tasks.<key>}} inside JSON-LD blocks only. `figures` null = /task-costs couldn't be read: each token
 * takes the text the page already shows for that key. A token neither can fill is reported, never left in.
 */
export function fillJsonLdTaskTokens(html, figures) {
    const fallbacks = figures ? {} : pageFallbacks(html);
    const unresolved = [];
    let count = 0;
    const out = html.replace(LD, (whole, open, body, close) => {
        const filled = body.replace(TOKEN, (tok, key) => {
            const text = figures ? taskCostText(key, figures) : fallbacks[key] ?? null;
            if (text === null) { unresolved.push(key); return tok; }
            count++;
            return text;
        });
        return `${open}${filled}${close}`;
    });
    return { html: out, count, unresolved };
}
