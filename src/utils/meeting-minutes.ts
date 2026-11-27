// Meeting Note Taker: ONE way to turn meeting notes into minutes (docs/meeting-note-taker-finish-plan.md
// step 5). The chat (chat-orchestrator.ts, route meeting_note_taker) and the "New meeting" form
// (netlify/functions/meeting-minutes.ts) both build their instructions with buildMeetingMinutesPrompt,
// clean the model's card with normaliseMinutesCard and file it with meetingHubRecord, so a meeting
// written up in either place comes out the same. tests/meeting-minutes.test.ts holds them together.

/**
 * Meetings may mention health, beliefs or other special category data (DPA 1.2 clause 13, "Meetings the Note Taker
 * joins"; docs/note-taker-bot-legal.md §9). The minutes are still written, but such details are used only as far as the
 * minutes need and are never inferred or labelled. Today it goes only into the channel block for meetings the BOT joined
 * (meeting-bot.ts BOT_CHANNEL_BLOCK), which a workspace can only have after accepting DPA 1.2. Pasted meetings keep the
 * DPA 1.1 rule until 1.2 is published. tests/meeting-bot.test.ts holds this.
 */
export const MEETING_SPECIAL_CATEGORY_CLAUSE = 'SPECIAL-CATEGORY DATA IN MEETINGS: What people say in a meeting may mention health, disability, religion, ethnicity, sexuality, politics, union membership or criminal matters. Still write the minutes. Include such a detail only where a decision, risk or task cannot be understood without it, in neutral words. Never infer a special category that was not stated, never label a person by one, and never add one to an attendee, a task or the follow-up email unless the task itself is about it.';

/** The meeting model and reply size, for chat and the form alike (Admin can still pick a model per role). */
export const MEETING_MINUTES_MODEL = 'claude-haiku-5-5';
// A 60-minute transcript's minutes, attendees and follow-up outgrew 2048 (finish plan step 4).
export const MEETING_MINUTES_MAX_TOKENS = 4096;

/**
 * Display labels for the set-up answer taskDestination (assistant-onboarding-schemas.js). Since Fix pipeline #69
 * (owner, 2026-11-16) the answer is 'be_more_swan' or 'external'; the older tool answers stay readable, and a named
 * tool is still an external system.
 */
export const MEETING_DESTINATION_LABELS: Record<string, string> = {
    be_more_swan: 'Be More Swan (Meeting Notes)',
    external: 'your connected task tool',
    notion: 'Notion',
    jira: 'Jira',
    asana: 'Asana',
    monday: 'Monday.com',
};

export function meetingDestinationLabel(taskDestination: unknown): string {
    return MEETING_DESTINATION_LABELS[String(taskDestination)]
        ?? (taskDestination ? String(taskDestination) : 'your task tracker');
}

/** True when action items stay in Be More Swan rather than going to an external system. */
export function actionItemsStayInBeMoreSwan(taskDestination: unknown): boolean {
    return String(taskDestination) === 'be_more_swan';
}

export interface MeetingPromptOptions {
    meetingPlatform: unknown;
    taskDestination: unknown;
    summaryFormat: unknown;
    /** What this place adds about how the notes arrive: the chat's paste/attach rules, or the form's. */
    channelBlock: string;
    /** Placed after the field rules, before the JSON shape (the chat's spreadsheet fallback). */
    trailingBlock?: string | null;
}

/** The minutes instructions: the same rules and JSON shape for chat and the form. */
export function buildMeetingMinutesPrompt(o: MeetingPromptOptions): string {
    const destinationLabel = meetingDestinationLabel(o.taskDestination);
    return `You are an executive assistant who turns raw meeting transcripts and messy meeting notes into crisp minutes. When the user gives you a transcript, notes, or a recap, extract four things: a concise executive summary, the concrete decisions the meeting reached, any risks or blockers raised, and every specific action item with its implied owner. Work only from the text the user provides; you cannot join a call or listen to a recording.

Nothing leaves the workspace until the user approves the meeting — in the Inbox tab, or with Approve on your card. Approving sends it to the connections switched on for this assistant (for example the follow-up email to attendees, a Slack summary, a Notion page, or one ticket per action item in Jira or Asana). So never say the minutes, the email or the tasks HAVE been sent, posted or synced: say they are waiting for the user's approval. Attendees with no email address will not get the follow-up until the user adds one in the Inbox.

Note-taking policy (from setup):
- Meeting platform: ${o.meetingPlatform ?? 'not specified'} — refer to it by name when talking about where meetings and recordings live.
- Task destination: ${actionItemsStayInBeMoreSwan(o.taskDestination)
    ? 'Be More Swan — action items stay in the Meeting Notes tab, where the user ticks them off; nothing is sent to another tool unless they switch one on in Connections.'
    : `${destinationLabel} — extracted action items are prepared for sync there (the Asana, Jira or Notion connection switched on for this assistant); use its terminology when discussing tasks.`}
- Summary format: ${o.summaryFormat === 'paragraph_narrative'
    ? 'Paragraph narrative — meetingSummary must be one flowing prose paragraph that reads like formal minutes, with no bullet points.'
    : 'Executive bullet points — meetingSummary must be 3-6 crisp bullet lines (each starting with "• "), leading with decisions and outcomes.'}

Attribution rules: assignee is the person the meeting content implies owns the task ("I'll send the deck" → that speaker; "Sarah to chase legal" → Sarah). Use "Unassigned" when no owner is implied. dueDate is the deadline stated or clearly implied ("by Friday", "before the next call"), echoed as plain text; use null when none was given. Never invent owners, dates, or action items that are not in the source material.

Decisions are firm conclusions the group agreed on ("we're going with vendor A", "launch slips to Q4") — not open discussion or individual opinions; return an empty array when the meeting reached none. Risks are threats, blockers, or concerns raised ("legal sign-off may not land in time", "the API rate limit could break at scale") — return an empty array when none surfaced. Never invent decisions or risks that are not in the source material.

${o.channelBlock}

meetingTitle names this meeting in the user's Meeting Notes library — derive it from the content ("Q3 pipeline review", "Weekly ops sync") plus the meeting date when one is stated; never leave it generic when the content names the meeting.

attendees lists every person the transcript shows was present or is named as an owner, as { name, email }. Transcripts rarely include email addresses, so set email to null unless it appears verbatim — the user fills the missing addresses in before the follow-up is sent. Return an empty array when no people are named.

followupEmail is a ready-to-review recap the user can send to the attendees: a warm one-line opener, the key decisions, and the action items with their owners and due dates, in the configured summary tone. Keep it under ~180 words, no placeholders or brackets. List every task from tasks in the email, one line each, with its owner ("owner to be agreed" when Unassigned) and its due date when one was given. Never say action items will be shared separately, later or once confirmed: they belong in this email. When tasks is empty, say that no action items were agreed. Set followupEmail to null only when there is no meeting content yet.
${o.trailingBlock ? `\n${o.trailingBlock}\n` : ''}
Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is no meeting content yet
    "type": "action_item_assignment",
    "meetingTitle": "<short name for this meeting, e.g. 'Q3 pipeline review — 4 Jul'>",
    "meetingSummary": "<the executive summary, in the configured format>",
    "decisionsMade": ["<a firm decision the meeting reached>", ...],   // [] when none were reached
    "identifiedRisks": ["<a risk, blocker, or concern raised>", ...],  // [] when none surfaced
    "targetDestination": ${JSON.stringify(destinationLabel)},
    "attendees": [ { "name": "<attendee name>", "email": "<email if stated verbatim>" | null }, ... ],  // [] when none named
    "followupEmail": {                  // or null when there is no meeting content yet
      "subject": "<a concise follow-up subject line>",
      "body": "<the ready-to-review recap email to attendees>"
    },
    "tasks": [
      { "description": "<specific action item>", "assignee": "<owner name, or 'Unassigned'>", "dueDate": "<deadline as stated>" | null },
      ...
    ]
  }
}`;
}

/** The form's channel block: the notes arrive whole, in one message, and always get a card. */
export const FORM_CHANNEL_BLOCK = 'The user\'s message is the whole meeting — pasted notes or an attached transcript, sent from the "New meeting" form, not a chat. Write the minutes from all of it at once and always include the card; set uiElement to null only when the text holds no meeting at all, and then say in "reply" what is missing.';

export interface MinutesCard {
    type: 'action_item_assignment';
    meetingTitle: string | null;
    meetingSummary: string;
    decisionsMade: string[];
    identifiedRisks: string[];
    targetDestination: string | null;
    attendees: { name: string; email: string | null }[];
    followupEmail: { subject: string; body: string } | null;
    tasks: { description: string; assignee: string; dueDate: string | null }[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Whether one sentence of the email puts the action items off ("…will be shared separately once confirmed", "We will share
 * the action items later"): it names action items, says they WILL BE shared/sent/circulated (or we will share/send them),
 * and says when ("separately", "later", "once confirmed"…). A line that lists items ("Action items: Sam to send the deck
 * later") or introduces a list (ends with ":") is never one. Review of #938. Pure.
 */
function defersActionItems(sentence: string): boolean {
    const s = sentence.trim();
    if (!/\baction items?\b/i.test(s) || /\baction items?\s*:/i.test(s) || s.endsWith(':')) return false;
    const willShare = /\b(?:will|shall|would|to|are to|is to)\s+be\s+(?:shared|sent|circulated|confirmed)\b|\b(?:will|we'll|i'll|shall|we will|i will)\s+(?:share|send|circulate)\b/i;
    const when = /\b(?:separately|later|once (?:they are |they're |they have been )?confirmed|in due course|shortly|to follow|in a separate)\b/i;
    return willShare.test(s) && when.test(s);
}

/** The tasks as the email's list: "• description (owner, due …)". Pure. */
export function actionItemLines(tasks: readonly { description: string; assignee: string; dueDate: string | null }[]): string {
    return tasks.map((t) => {
        const owner = !t.assignee || /^unassigned$/i.test(t.assignee) ? 'owner to be agreed' : t.assignee;
        return `• ${t.description} (${owner}${t.dueDate ? `, due ${t.dueDate}` : ''})`;
    }).join('\n');
}

/**
 * The follow-up email must carry the action items (owner, staging test 2026-11-27: "Action items were noted during the
 * meeting and will be shared separately once confirmed" with one task on the card). When the model puts them off and the
 * card has tasks, that sentence becomes the list. Anything else is left as written. Pure.
 */
export function withActionItems(body: string, tasks: readonly { description: string; assignee: string; dueDate: string | null }[]): string {
    if (!tasks.length) return body;
    let replaced = false;
    // Sentence by sentence (a sentence never crosses a line break): the first deferring sentence becomes the list, any
    // later one is dropped (the list is already there).
    const out = body.replace(/[^.!?\n]+[.!?]?/g, (sentence) => {
        if (!defersActionItems(sentence)) return sentence;
        if (replaced) return '';
        replaced = true;
        const lead = sentence.match(/^\s*/)?.[0] ?? '';
        return `${lead}Action items:\n${actionItemLines(tasks)}`;
    });
    return out;
}

/**
 * The model's card, cleaned: lists are lists of text, attendees carry a real address or null, tasks
 * have a description. Other keys the chat stamps on later (recordId, hubLink) are added after this.
 * Null when it is not a minutes card, or nothing was extracted (the chat then shows its reply alone).
 */
export function normaliseMinutesCard(ui: unknown): MinutesCard | null {
    if (!ui || typeof ui !== 'object') return null;
    const u = ui as Record<string, unknown>;
    if (u.type !== 'action_item_assignment' && u.type !== 'ActionItemAssignmentCard') return null;
    const list = (v: unknown, max = 500) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, 50);
    const attendees = (Array.isArray(u.attendees) ? u.attendees : []).flatMap((a) => {
        if (!a || typeof a !== 'object') return [];
        const r = a as Record<string, unknown>;
        const name = str(r.name, 120);
        const email = str(r.email, 254);
        return name || EMAIL.test(email) ? [{ name, email: EMAIL.test(email) ? email : null }] : [];
    }).slice(0, 50);
    const tasks = (Array.isArray(u.tasks) ? u.tasks : []).flatMap((t) => {
        if (!t || typeof t !== 'object') return [];
        const r = t as Record<string, unknown>;
        const description = str(r.description, 2000);
        if (!description) return [];
        return [{ description, assignee: str(r.assignee, 200) || 'Unassigned', dueDate: str(r.dueDate, 200) || null }];
    }).slice(0, 100);
    const fe = u.followupEmail && typeof u.followupEmail === 'object' ? u.followupEmail as Record<string, unknown> : null;
    const followupEmail = fe && (str(fe.subject, 300) || str(fe.body, 10000))
        ? { subject: str(fe.subject, 300), body: withActionItems(str(fe.body, 10000), tasks) } : null;
    const card: MinutesCard = {
        type: 'action_item_assignment',
        meetingTitle: str(u.meetingTitle, 300) || null,
        meetingSummary: str(u.meetingSummary, 10000),
        decisionsMade: list(u.decisionsMade),
        identifiedRisks: list(u.identifiedRisks),
        targetDestination: str(u.targetDestination, 120) || null,
        attendees,
        followupEmail,
        tasks,
    };
    if (!card.meetingSummary && !card.decisionsMade.length && !card.identifiedRisks.length && !card.tasks.length) return null;
    return card;
}

export interface MeetingHubRecord { recordType: 'meeting'; title: string; status: string; data: unknown }

/** The meeting record a card is filed as (Inbox / Meeting Notes). How a same-titled meeting is filed: hub-records.ts. */
export function meetingHubRecord(ui: Record<string, unknown>, today: Date = new Date()): MeetingHubRecord {
    const title = str(ui.meetingTitle, 300) || `Meeting notes — ${today.toISOString().slice(0, 10)}`;
    const open = Array.isArray(ui.tasks) ? ui.tasks.length : 0;
    return { recordType: 'meeting', title, status: open ? 'open' : 'no actions', data: ui };
}
