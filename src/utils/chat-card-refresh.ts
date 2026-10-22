// src/utils/chat-card-refresh.ts
// Re-check stored confirm cards against their rows before they are shown again — ONE chain for every
// place a stored card reappears: a reopened conversation (get-chat-session.ts) and a model reply's
// card on the Team feed (team.ts `list`). A card already acted on (here, in the chat, or on the page)
// then says so instead of offering a button its endpoint would refuse or, worse, act on twice.
//
// Each refresher only touches its own card type and never throws.

import type { getDb } from '../../db/client';
import { refreshPostActionCards } from './chat-post-action';
import { refreshBlogActionCards } from './chat-blog-action';
import { refreshEmailActionCards } from './chat-email-action';
import { refreshLeadActionCards } from './chat-lead-action';
import { refreshAudienceCards } from './chat-audience';
import { refreshSettingsCards } from './chat-assistant-settings';
import { refreshRuleCards } from './chat-rules';
import { refreshGoalCards } from './chat-goals';
import { refreshScheduleCards } from './chat-schedule';
import { refreshPlatformsCards } from './chat-platforms';
import { refreshLibraryCards } from './chat-library';

type Db = ReturnType<typeof getDb>;

export async function refreshStoredCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, messages: M[],
): Promise<M[]> {
    let out = await refreshPostActionCards(db, organisationId, aiAssistantId, messages);
    out = await refreshBlogActionCards(db, organisationId, aiAssistantId, out);
    out = await refreshEmailActionCards(db, organisationId, aiAssistantId, out);
    out = await refreshLeadActionCards(db, organisationId, aiAssistantId, out);
    out = await refreshAudienceCards(db, organisationId, out);
    out = await refreshSettingsCards(db, organisationId, aiAssistantId, roleKey, out);
    out = await refreshRuleCards(db, organisationId, aiAssistantId, roleKey, out);
    out = await refreshGoalCards(db, organisationId, aiAssistantId, out);
    out = await refreshScheduleCards(db, organisationId, aiAssistantId, out);
    out = await refreshPlatformsCards(db, organisationId, aiAssistantId, out);
    return refreshLibraryCards(db, organisationId, aiAssistantId, out);
}
