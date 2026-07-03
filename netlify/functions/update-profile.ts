// netlify/functions/update-profile.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles, userOrganisations } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';

const jwtSecret = process.env.JWT_SECRET;

// Removed the unused 'context' parameter to satisfy TS6133
export const handler = async (event: HandlerEvent) => {
    if (!jwtSecret) {
        console.error("CRITICAL: JWT_SECRET is missing.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    // 1. Authenticate the User via Native Cookie Parsing (Fixes TS2307)
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '') // Filter out empty strings
    );

    const sessionToken = cookies['aura_session'];

    if (!sessionToken) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in.' }) };
    }

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();

    // -------------------------------------------------------------
    // GET: Hydrate the Account Settings page fields
    // -------------------------------------------------------------
    if (event.httpMethod === 'GET') {
        try {
            const [user] = await db.select().from(users).where(eq(users.id, userId));
            const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
            const [orgMembership] = await db.select({ role: userOrganisations.role })
                .from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);

            const prefs = (profile?.preferences as Record<string, any>) || {};
            return {
                statusCode: 200,
                body: JSON.stringify({
                    firstName: user?.firstName || '',
                    lastName: user?.lastName || '',
                    email: user?.email || '',
                    timezone: profile?.timezone || 'Europe/London',
                    hourlyRateGbp: prefs.hourlyRateGbp ?? '',
                    upgradeExperimentVariant: prefs.upgradeExperimentVariant ?? 'break_even',
                    // Sound preferences (default-on when unset).
                    soundOnLogin: prefs.soundOnLogin !== false,
                    soundOnMilestone: prefs.soundOnMilestone !== false,
                    // US-UX-1.1 SC1: role fields for header badges and settings display
                    platformRole: user?.role || 'user',
                    organisationRole: orgMembership?.role || 'member',
                    language: profile?.language || 'en',
                    firstLoginWelcomeSeen: profile?.firstLoginWelcomeSeen ?? false,
                    // Onboarding Wizard Step 3 — null until the user sets their hours.
                    workingHours: profile?.workingHours ?? null,
                })
            };
        } catch (error) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch profile data.' }) };
        }
    }

    // -------------------------------------------------------------
    // PATCH: Auto-Save Profile Changes & Trigger Audit Log
    // -------------------------------------------------------------
    if (event.httpMethod === 'PATCH') {
        try {
            const body = JSON.parse(event.body || '{}');
            const { fieldKey, value } = body;

            if (!fieldKey) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Field key is missing.' }) };
            }

            // US-UX-1.1 SC5: reject attempts to self-assign roles
            if (['role', 'platformRole', 'organisationRole'].includes(fieldKey)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Role changes must be made by an admin.' }) };
            }

            // Fetch the current state for the Before/After Audit Log
            const [currentUser] = await db.select().from(users).where(eq(users.id, userId));
            const [currentProfile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));

            let targetTable = '';
            let oldState = {};
            let newState = {};

            // Determine which table handles the incoming field
            if (['firstName', 'lastName', 'email'].includes(fieldKey)) {

                targetTable = 'users';
                oldState = { [fieldKey]: currentUser[fieldKey as keyof typeof currentUser] };
                newState = { [fieldKey]: value };

                await db.update(users)
                    .set({ [fieldKey]: value, updatedAt: new Date() })
                    .where(eq(users.id, userId));

            } else if (['timezone'].includes(fieldKey)) {

                targetTable = 'user_profiles';
                oldState = { [fieldKey]: currentProfile[fieldKey as keyof typeof currentProfile] };
                newState = { [fieldKey]: value };

                await db.update(userProfiles)
                    .set({ [fieldKey]: value, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else if (fieldKey === 'language') {

                const SUPPORTED_LANGS = ['en', 'fr', 'de', 'es', 'pt'];
                if (!SUPPORTED_LANGS.includes(value)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Unsupported language.' }) };
                }
                targetTable = 'user_profiles';
                oldState = { language: currentProfile?.language || 'en' };
                newState = { language: value };
                await db.update(userProfiles)
                    .set({ language: value, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else if (fieldKey === 'firstLoginWelcomeSeen') {
                // US-ONB-2.2.1: mark welcome modal as seen — client fires this on dismiss
                targetTable = 'user_profiles';
                oldState = { firstLoginWelcomeSeen: currentProfile?.firstLoginWelcomeSeen ?? false };
                newState = { firstLoginWelcomeSeen: true };
                await db.update(userProfiles)
                    .set({ firstLoginWelcomeSeen: true, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else if (fieldKey === 'hourlyRateGbp') {
                // US-AUD-1.1.2 SC2/SC3: stored in userProfiles.preferences.hourlyRateGbp
                targetTable = 'user_profiles';
                const currentPrefs = (currentProfile?.preferences as Record<string, any>) || {};
                oldState = { hourlyRateGbp: currentPrefs.hourlyRateGbp ?? null };
                const rateVal = value === '' || value === null ? null : Number(value);
                newState = { hourlyRateGbp: rateVal };

                await db.update(userProfiles)
                    .set({ preferences: { ...currentPrefs, hourlyRateGbp: rateVal }, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else if (fieldKey === 'workingHours') {
                // Onboarding Wizard Step 3 (US5 AC2) — stored as a jsonb object on the profile.
                // Shape: { preset, start, end, days[] }. A non-null value marks the step done.
                targetTable = 'user_profiles';
                oldState = { workingHours: currentProfile?.workingHours ?? null };
                const whVal = value && typeof value === 'object' ? value : null;
                newState = { workingHours: whVal };

                await db.update(userProfiles)
                    .set({ workingHours: whVal, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else if (fieldKey === 'soundOnLogin' || fieldKey === 'soundOnMilestone') {
                // Sound preferences — stored in userProfiles.preferences (boolean, default-on).
                targetTable = 'user_profiles';
                const currentPrefs = (currentProfile?.preferences as Record<string, any>) || {};
                const boolVal = value === true || value === 'true';
                oldState = { [fieldKey]: currentPrefs[fieldKey] !== false };
                newState = { [fieldKey]: boolVal };

                await db.update(userProfiles)
                    .set({ preferences: { ...currentPrefs, [fieldKey]: boolVal }, updatedAt: new Date() })
                    .where(eq(userProfiles.userId, userId));

            } else {
                return { statusCode: 400, body: JSON.stringify({ error: 'Invalid field key provided.' }) };
            }

            // Dispatch the asynchronous, non-blocking Audit Log
            logAuditEvent({
                userId: userId,
                actionType: 'UPDATE',
                resourceType: targetTable,
                resourceId: userId,
                previousState: oldState,
                newState: newState,
                ipAddress: event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown',
                userAgent: event.headers['user-agent'] || 'unknown'
            });

            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'Profile updated.' }) };

        } catch (error) {
            console.error('Update Profile Error:', error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update profile.' }) };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};