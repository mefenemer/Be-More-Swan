// src/utils/audience-custom-fields.ts
// The org's own columns, read by everything that has to know what they are called.
//
// Four readers need this list and none of them may guess: the import (which keys may be written),
// the segment rules (which keys may be filtered on), the merge-tag scrub (which {{…}} tags survive
// the way to an inbox), and the editor's insert menu. A key nobody defined must be writable by
// none of them — see the allow-list in audience-contacts.ts for why.

import { asc, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceCustomFields } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export interface CustomFieldDef {
    key: string;
    label: string;
    type: string;
}

/**
 * Every field this organisation has defined.
 *
 * ⚠️ Returns [] when the table is not there (42P01) rather than throwing. An environment without
 * the migration has no custom fields, which is a true statement — and the alternative is that a
 * missing migration takes down drafting, importing and sending rather than just this feature.
 */
export async function loadCustomFieldDefs(db: Db, organisationId: number): Promise<CustomFieldDef[]> {
    try {
        return await db
            .select({
                key: audienceCustomFields.key,
                label: audienceCustomFields.label,
                type: audienceCustomFields.type,
            })
            .from(audienceCustomFields)
            .where(eq(audienceCustomFields.organisationId, organisationId))
            .orderBy(asc(audienceCustomFields.label));
    } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } })?.code
            ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code !== '42P01') throw err;
        console.error('[audience-custom-fields] table missing — db/audience-custom-fields.sql has not been applied here',
            { organisationId });
        return [];
    }
}

export async function loadCustomFieldKeys(db: Db, organisationId: number): Promise<string[]> {
    return (await loadCustomFieldDefs(db, organisationId)).map((f) => f.key);
}
