// db/relations.ts
// Drizzle relational-query definitions (drizzle-orm v2 `defineRelations` API).
//
// getDb()/getAppDb() are intentionally schema-less (PostgresJsDatabase<Record<string,
// never>>) and every existing function uses the plain query builder, so these relations
// are OPT-IN: bind them where a relational query is genuinely clearer, e.g.
//
//   import { drizzle } from 'drizzle-orm/postgres-js';
//   import { relations } from '../db/relations';
//   const db = drizzle({ client, relations });
//   await db.query.chatSessions.findFirst({ where: ..., with: { messages: true } });
//
// Currently only the chat-persistence tables are configured; extend the config object
// as other tables adopt the relational API.

import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
    chatSessions: {
        organisation: r.one.organisations({
            from: r.chatSessions.organisationId,
            to: r.organisations.id,
        }),
        user: r.one.users({
            from: r.chatSessions.userId,
            to: r.users.id,
        }),
        aiAssistant: r.one.aiAssistants({
            from: r.chatSessions.aiAssistantId,
            to: r.aiAssistants.id,
        }),
        messages: r.many.chatMessages({
            from: r.chatSessions.id,
            to: r.chatMessages.chatSessionId,
        }),
    },
    chatMessages: {
        session: r.one.chatSessions({
            from: r.chatMessages.chatSessionId,
            to: r.chatSessions.id,
        }),
    },
}));
