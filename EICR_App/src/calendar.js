/**
 * Google Calendar integration for CertMate / EICR-oMatic 3000
 * Provides OAuth2 flow and event fetching for inspection scheduling.
 */

import { google } from "googleapis";
import logger from "./logger.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

/**
 * Check whether Google Calendar OAuth credentials are configured.
 */
export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Create an OAuth2 client instance.
 */
function createOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/**
 * Generate the Google OAuth consent URL the user should visit.
 * @param {string} redirectUri - Where Google should redirect after consent
 * @returns {string} OAuth consent URL
 */
export function getAuthUrl(redirectUri) {
  const client = createOAuth2Client(redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // always show consent so we get a refresh_token
  });
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * @param {string} code - Authorization code from the OAuth callback
 * @param {string} redirectUri - Must match the URI used when generating the auth URL
 * @returns {Promise<object>} Token set { access_token, refresh_token, expiry_date, ... }
 */
export async function getTokens(code, redirectUri) {
  const client = createOAuth2Client(redirectUri);
  const { tokens } = await client.getToken(code);
  logger.info("Google Calendar tokens obtained", {
    hasRefreshToken: !!tokens.refresh_token,
  });
  return tokens;
}

/**
 * Fetch upcoming calendar events that look like electrical inspections.
 * Filters for events whose summary, description, or location contain
 * keywords such as EICR, EIC, inspection, electrical, certificate, or test.
 *
 * @param {object} tokens - Google OAuth tokens (access_token, refresh_token, etc.)
 * @returns {Promise<Array<{id,summary,start,end,location,description}>>}
 */
export async function getUpcomingInspections(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: "v3", auth: client });

  // Fetch events from now to 30 days ahead
  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: thirtyDaysLater.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });

  const events = response.data.items || [];

  // Filter for inspection-related keywords
  const keywords = /\b(eicr|eic|inspection|electrical|certificate|test|pir|periodic)\b/i;

  const inspectionEvents = events.filter((evt) => {
    const text = [evt.summary, evt.description, evt.location]
      .filter(Boolean)
      .join(" ");
    return keywords.test(text);
  });

  // Return normalised shape
  return inspectionEvents.map((evt) => ({
    id: evt.id,
    summary: evt.summary || "",
    start: evt.start?.dateTime || evt.start?.date || "",
    end: evt.end?.dateTime || evt.end?.date || "",
    location: evt.location || "",
    description: evt.description || "",
  }));
}

/**
 * Refresh tokens if needed and return the latest credential set.
 * Useful for automatically refreshing expired access tokens using the refresh_token.
 *
 * @param {object} tokens - Existing token set
 * @returns {Promise<object>} Potentially refreshed token set
 */
export async function refreshTokensIfNeeded(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);

  // Force a refresh by requesting a new access token
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}
