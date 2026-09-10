// Minimal service worker: enough for the browser to treat the site as an
// installable app. No offline caching on purpose — every screen shows live
// stock and approvals, and a cached yesterday shown as today is precisely
// the kind of quiet lie the rest of this system exists to prevent.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// No stock data caching. Only the browser's push service wakes this worker.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    const parsed = event.data ? event.data.json() : {};
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch {}
  const value = typeof payload.url === "string" ? payload.url : "/dashboard";
  let url = "/dashboard";
  try {
    const candidate = new URL(value, self.location.origin);
    if (candidate.origin === self.location.origin) url = candidate.pathname + candidate.search;
  } catch {}
  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title || "SLP Canteen Hub", {
      body: payload.body || "Naya update aaya hai. App khol kar dekhein.",
      icon: "/icon-192.png",
      badge: "/favicon-64.png",
      tag: "slp-" + (payload.id || "update"),
      // OS chooses the sound. Silent/DND and notification permissions still apply.
      silent: false,
      vibrate: [200, 100, 200],
      data: { url },
    });
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const tab of tabs) tab.postMessage({ type: "SLP_NOTIFICATION_RECEIVED" });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let url = new URL("/dashboard", self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
      if (candidate.origin === self.location.origin) url = candidate;
    } catch {}
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const tab of tabs) {
      if (new URL(tab.url).origin === self.location.origin && "focus" in tab) {
        await tab.navigate(url.href);
        await tab.focus();
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
