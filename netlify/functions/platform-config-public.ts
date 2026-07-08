// netlify/functions/platform-config-public.ts
//
// US-ADM-3.2.1: Lightweight public endpoint returning only the kill switch states
// that the edge function needs to enforce maintenance mode and registration lock.
// No authentication required — returns only boolean flags, no sensitive data.
//
// GET /.netlify/functions/platform-config-public
// → { maintenanceMode: bool, maintenanceMessage: string, registrationLocked: bool }

import { Handler } from '@netlify/functions';
import { warmPlatformConfigCache, CONFIG_KEYS, DEFAULT_SESSION_TIMEOUT_CONFIG } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async () => {
    try {
        const config = await warmPlatformConfigCache();
        const sessionTimeoutMinutes = Number(config[CONFIG_KEYS.SESSION_INACTIVITY_TIMEOUT_MINUTES]);
        const sessionCountdownMinutes = Number(config[CONFIG_KEYS.SESSION_COUNTDOWN_MINUTES]);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                // Cache for 25 seconds at the CDN — slightly less than the 30s process cache
                'Cache-Control': 'public, max-age=25',
            },
            body: JSON.stringify({
                maintenanceMode:      config[CONFIG_KEYS.MAINTENANCE_MODE]      === true,
                maintenanceMessage:   config[CONFIG_KEYS.MAINTENANCE_MESSAGE]    || 'We are performing scheduled maintenance. Please check back shortly.',
                registrationLocked:   config[CONFIG_KEYS.NEW_REGISTRATION_LOCK]  === true,
                globalAiDisabled:     config[CONFIG_KEYS.GLOBAL_AI_DISABLED]     === true,
                // issue #127: idle countdown timing, admin-configurable
                sessionInactivityTimeoutMinutes: sessionTimeoutMinutes > 0 ? sessionTimeoutMinutes : DEFAULT_SESSION_TIMEOUT_CONFIG.inactivityTimeoutMinutes,
                sessionCountdownMinutes:         sessionCountdownMinutes > 0 ? sessionCountdownMinutes : DEFAULT_SESSION_TIMEOUT_CONFIG.countdownMinutes,
            }),
        };
    } catch (err) {
        console.error('[platform-config-public] Error:', err);
        // Fail open — if config can't be read, allow access
        return {
            statusCode: 200,
            body: JSON.stringify({
                maintenanceMode: false, registrationLocked: false, globalAiDisabled: false,
                sessionInactivityTimeoutMinutes: DEFAULT_SESSION_TIMEOUT_CONFIG.inactivityTimeoutMinutes,
                sessionCountdownMinutes: DEFAULT_SESSION_TIMEOUT_CONFIG.countdownMinutes,
            }),
        };
    }
});
