// push-sw.js — minimal service worker for browser push notifications.
// Registered by app/components/shared/push-permission-toggle.tsx; payloads are
// sent by lib/providers/web-push.ts as JSON { title, body, data }.

self.addEventListener("push", (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: "Notification", body: event.data ? event.data.text() : "" }
  }
  const title = payload.title || "Notification"
  const options = {
    body: payload.body || "",
    data: payload.data || {},
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
