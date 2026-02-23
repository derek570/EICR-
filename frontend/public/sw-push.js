/**
 * Service Worker for push notifications — EICR-oMatic 3000
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "CertMate", body: event.data ? event.data.text() : "New notification" };
  }

  const title = data.title || "CertMate";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192x192.png",
    badge: data.badge || "/icons/icon-72x72.png",
    tag: data.tag || "certmate-notification",
    data: {
      url: data.url || "/dashboard",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const rawUrl = event.notification.data?.url || "/dashboard";

  // Validate URL is same-origin
  let targetUrl;
  try {
    targetUrl = new URL(rawUrl, self.location.origin);
    if (targetUrl.origin !== self.location.origin) {
      console.error("Blocked notification navigation to external URL:", rawUrl);
      targetUrl = new URL("/dashboard", self.location.origin);
    }
  } catch (e) {
    targetUrl = new URL("/dashboard", self.location.origin);
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          client.navigate(targetUrl.href);
          return;
        }
      }
      return clients.openWindow(targetUrl.href);
    })
  );
});
