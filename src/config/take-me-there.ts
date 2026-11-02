// src/config/take-me-there.ts
// The Business Mentor's "Take Me There" button (owner, 2026-11-02): when the user asks where something
// is in Be More Swan, the Mentor says where AND puts a card with one button that opens it.
//
// A CLOSED list. The model names a place key; the server checks it here and sends the card exactly
// where to go (a workspace view, a Business Information tab, or one assistant's page and tab). So a
// button can never open a page that doesn't exist, and the browser runs no navigation the model wrote.
// Views are the `routes` keys in workspace.html; Business Information tabs are window._bizinfoInitialTab
// values (assets.html); assistant tabs are the detail page's data-maintab / data-tab names, and an
// unknown one lands on the role's default tab (assistants.js), never a blank page.

export interface TakeMeTherePlace {
    /** What the place is called in the reply and on the card. */
    label: string;
    /** A workspace view (workspace.html `routes`). Absent for an assistant's page. */
    view?: string;
    /** Business Information's tab, with view 'assets'. */
    bizTab?: 'profile' | 'products' | 'assets';
    /** A Notifications tab. */
    notificationsTab?: 'messages';
    /** One assistant's page: the card needs an assistantId, and opens this tab on it. */
    assistantTab?: string;
}

export const TAKE_ME_THERE_PLACES: Readonly<Record<string, TakeMeTherePlace>> = {
    dashboard: { label: 'Workspace Overview', view: 'dashboard' },
    business_profile: { label: 'Business Information ▸ Business Profile', view: 'assets', bizTab: 'profile' },
    products: { label: 'Business Information ▸ Products & Services', view: 'assets', bizTab: 'products' },
    brand_assets: { label: 'Business Information ▸ Brand Assets', view: 'assets', bizTab: 'assets' },
    my_content: { label: 'My Content', view: 'my-content' },
    calendar: { label: 'Content Calendar', view: 'calendar' },
    review_queue: { label: 'Review', view: 'review-queue' },
    notifications: { label: 'Notifications', view: 'notifications' },
    team_chat: { label: 'Notifications ▸ Messages (Team Chat)', view: 'notifications', notificationsTab: 'messages' },
    audience: { label: 'Audience', view: 'audience' },
    orders: { label: 'Orders', view: 'orders' },
    my_assistants: { label: 'My Assistants', view: 'assistants' },
    hire: { label: 'Hire a New Assistant', view: 'catalog' },
    billing: { label: 'My Account ▸ Billing & Subscription', view: 'billing' },
    account_settings: { label: 'My Account', view: 'settings' },
    help: { label: 'Help & Support', view: 'help' },
    refer_a_friend: { label: 'Refer a Friend', view: 'referral' },
    getting_started: { label: 'Getting Started', view: 'getting-started' },
    // One assistant's page (needs assistantId).
    assistant: { label: 'the assistant\'s page', assistantTab: '' },
    assistant_review_queue: { label: 'the assistant\'s Review Queue tab', assistantTab: 'review-queue' },
    assistant_calendar: { label: 'the assistant\'s Calendar tab', assistantTab: 'calendar' },
    assistant_results: { label: 'the assistant\'s Results tab', assistantTab: 'goals' },
    assistant_what_i_post_about: { label: 'the assistant\'s What I post about card (content pillars, content mix, message)', assistantTab: 'strategy' },
    assistant_platforms: { label: 'the assistant\'s Platforms card', assistantTab: 'platforms' },
    assistant_rules: { label: 'the assistant\'s Rules (Do\'s and don\'ts)', assistantTab: 'rules' },
    assistant_how_i_work: { label: 'the assistant\'s How I work card (schedule and settings)', assistantTab: 'operation' },
    assistant_briefs: { label: 'the Brand Designer\'s Briefs tab', assistantTab: 'briefs' },
    assistant_inspo: { label: 'the assistant\'s Inspo tab', assistantTab: 'inspo' },
    assistant_website: { label: 'the Website Assistant\'s Website tab', assistantTab: 'sitebuilder' },
    assistant_videos: { label: 'the Video Producer\'s Videos tab', assistantTab: 'videos' },
    mentor_plan: { label: 'your Business Mentor\'s Plan tab', assistantTab: 'mentorplan' },
};

export type TakeMeThereKey = keyof typeof TAKE_ME_THERE_PLACES;

/** The card the browser draws: everything it needs to navigate, decided here — never by the model. */
export interface TakeMeThereCard {
    type: 'mentor_take_me_there';
    summary: string;
    place: string;
    label: string;
    view: string | null;
    bizTab: string | null;
    notificationsTab: string | null;
    assistantId: number | null;
    assistantTab: string | null;
}

/**
 * Pure: the model's request as a card, or an error. `team` = the assistants on this workspace (id and
 * name) — an assistant place must name one of them, and the card says its name.
 */
export function buildTakeMeThereCard(
    raw: { place?: unknown; summary?: unknown; assistantId?: unknown },
    team: Array<{ id: number; name: string }>,
): TakeMeThereCard | { error: string } {
    const key = String(raw.place ?? '');
    const place = Object.prototype.hasOwnProperty.call(TAKE_ME_THERE_PLACES, key) ? TAKE_ME_THERE_PLACES[key] : null;
    if (!place) return { error: 'I don\'t have a button for that page.' };
    const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : '';
    if (place.assistantTab !== undefined) {
        const id = Number(raw.assistantId);
        const who = team.find((t) => t.id === id);
        if (!who) return { error: 'I couldn\'t tell which assistant\'s page to open.' };
        return {
            type: 'mentor_take_me_there', summary, place: key,
            label: place.label.replace(/^the assistant's|^the Brand Designer's|^the Website Assistant's|^the Video Producer's|^your Business Mentor's/, `${who.name}'s`),
            view: null, bizTab: null, notificationsTab: null, assistantId: who.id, assistantTab: place.assistantTab || null,
        };
    }
    return {
        type: 'mentor_take_me_there', summary, place: key, label: place.label,
        view: place.view ?? null, bizTab: place.bizTab ?? null, notificationsTab: place.notificationsTab ?? null,
        assistantId: null, assistantTab: null,
    };
}

/** The card's line in the Mentor's prompt. */
export function takeMeTherePromptLine(): string {
    const keys = Object.entries(TAKE_ME_THERE_PLACES).map(([k, p]) => `"${k}" (${p.label})`).join(', ');
    return `Take Me There — WHENEVER the user asks where something is, how to find it, or how to get to a page in Be More Swan (and no other card is needed): say where it is in words, AND draw this card so they can go there with one click. "place" is one of: ${keys}. For a place on one assistant's page, also give "assistantId" (an assistant on your team, by its id). It changes nothing and is never a suggestion:
{"type":"mentor_take_me_there","summary":"<one short sentence: what they'll find there>","place":"<key>","assistantId":<id, only for an assistant's page>}`;
}
