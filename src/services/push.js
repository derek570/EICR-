/**
 * Web Push Notifications for EICR-oMatic 3000
 * Sends push notifications to subscribed browsers when jobs complete/fail.
 */

import webPush from "web-push";
import logger from "../logger.js";
import { getPushSubscriptions, deletePushSubscription } from "../db.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

let configured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    "mailto:derek@certmate.uk",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  logger.info("Web push notifications configured");
} else {
  logger.warn("VAPID keys not set — web push notifications disabled");
}

/**
 * Returns the VAPID public key (for frontend subscription)
 */
export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/**
 * Returns whether push notifications are configured
 */
export function isConfigured() {
  return configured;
}

/**
 * Send a push notification to all subscriptions for a user.
 * Automatically removes stale subscriptions (410/404).
 *
 * @param {string} userId
 * @param {object} payload - { title, body, url, tag }
 */
export async function sendPushToUser(userId, payload) {
  if (!configured) return;

  let subscriptions;
  try {
    subscriptions = await getPushSubscriptions(userId);
  } catch (err) {
    logger.error("Failed to get push subscriptions", { userId, error: err.message });
    return;
  }

  if (!subscriptions || subscriptions.length === 0) return;

  const payloadStr = JSON.stringify(payload);

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await webPush.sendNotification(pushSubscription, payloadStr);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        logger.info("Removing stale push subscription", { userId, endpoint: sub.endpoint });
        try {
          await deletePushSubscription(userId, sub.endpoint);
        } catch (delErr) {
          logger.error("Failed to delete stale subscription", { error: delErr.message });
        }
      } else {
        logger.error("Push notification failed", {
          userId,
          endpoint: sub.endpoint,
          error: err.message,
          statusCode: err.statusCode,
        });
      }
    }
  }
}
