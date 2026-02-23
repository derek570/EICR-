/**
 * Client-side push notification subscription for EICR-oMatic 3000
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

/**
 * Convert a URL-safe base64 string to a Uint8Array (for PushManager)
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Subscribe the current browser to push notifications.
 * Returns true on success, false on failure or if unsupported.
 */
export async function subscribeToPush(): Promise<boolean> {
  try {
    // Check browser support
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("[Push] Browser does not support push notifications");
      return false;
    }

    // Fetch VAPID public key from backend
    const vapidRes = await fetch(`${API_BASE_URL}/api/push/vapid-key`);
    if (!vapidRes.ok) {
      console.warn("[Push] Push not configured on server:", vapidRes.status);
      return false;
    }
    const { publicKey } = await vapidRes.json();
    if (!publicKey) {
      console.warn("[Push] No VAPID public key returned");
      return false;
    }

    // Register the push service worker
    const registration = await navigator.serviceWorker.register("/sw-push.js");
    await navigator.serviceWorker.ready;

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.warn("[Push] Notification permission denied:", permission);
      return false;
    }

    // Subscribe via PushManager
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
    });

    // Send subscription to backend
    const token = localStorage.getItem("token");
    if (!token) {
      console.warn("[Push] No auth token available");
      return false;
    }

    const saveRes = await fetch(`${API_BASE_URL}/api/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    if (!saveRes.ok) {
      console.error("[Push] Failed to save subscription:", saveRes.status);
      return false;
    }

    console.log("[Push] Successfully subscribed to push notifications");
    return true;
  } catch (error) {
    console.error("[Push] Subscription failed:", error);
    return false;
  }
}
