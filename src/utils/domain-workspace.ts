// src/utils/domain-workspace.ts
// Security & Fair Usage — Multi-Account Abuse Prevention (US4: Corporate Domain Consolidation).
//
// When someone registers with a NON-public business email whose domain already belongs to a
// PAID Be More Swan workspace, we pause onboarding and offer to request to join that workspace
// instead of silently spinning up a duplicate free/trial account (AC4.2/4.3). This is the read
// model shared by register.ts (decide whether to prompt) and request-domain-join.ts (notify the
// existing workspace's owner). It is deliberately distinct from the silent domain AUTO-JOIN path
// (allow_domain_join && domain_verified) in register.ts, which takes precedence and never prompts.

import { and, eq, ne, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { organisations, plans, userOrganisations, users } from '../../db/schema';
import { businessDomainOf } from './email-domain';

export type DomainWorkspace = {
    orgId: number;
    orgName: string | null;
    ownerUserId: number;
    ownerEmail: string;
    ownerFirstName: string | null;
    allowDomainJoin: boolean;
    domainVerified: boolean;
};

// A workspace is "paid" once it holds a non-trial plan that is currently billing (active or in the
// past-due grace window). Trial / cancelled / expired plans never count, so a lapsed account on the
// domain won't trigger the consolidation prompt.
const PAID_PLAN_STATUSES = ['active', 'past_due'] as const;

/**
 * The paid workspace owning `businessDomain` (with its owner), or null when none exists.
 * `businessDomain` must already be a normalised non-public host (see businessDomainOf).
 * Returns the first match if several exist — only used to route a join request to one owner.
 */
export async function findPaidDomainWorkspace(
    db: PostgresJsDatabase<any>,
    businessDomain: string | null | undefined,
): Promise<DomainWorkspace | null> {
    if (!businessDomain) return null;

    const [row] = await db
        .select({
            orgId: organisations.id,
            orgName: organisations.name,
            allowDomainJoin: organisations.allowDomainJoin,
            domainVerified: organisations.domainVerified,
            ownerUserId: userOrganisations.userId,
            ownerEmail: users.email,
            ownerFirstName: users.firstName,
        })
        .from(organisations)
        .innerJoin(plans, eq(plans.organisationId, organisations.id))
        .innerJoin(userOrganisations, and(
            eq(userOrganisations.organisationId, organisations.id),
            eq(userOrganisations.role, 'owner'),
        ))
        .innerJoin(users, eq(users.id, userOrganisations.userId))
        .where(and(
            eq(organisations.businessDomain, businessDomain),
            ne(plans.planType, 'trial'),
            inArray(plans.status, [...PAID_PLAN_STATUSES]),
        ))
        .limit(1);

    return row ? { ...row } : null;
}

/** Convenience: resolve straight from an email address (null for public / invalid domains). */
export function consolidationDomainOf(email: string | null | undefined): string | null {
    return businessDomainOf(email);
}
