"use client"

// Browser push enable/disable toggle — the capture UI for the web-push rail.
// Registers /push-sw.js, subscribes via PushManager with the platform VAPID
// public key (from getVapidPublicKey), and persists the subscription through
// app/actions/push-subscriptions.ts. Delivery happens server-side in
// lib/providers/web-push.ts (drained by /api/cron/queue-drain).

import { useCallback, useEffect, useState } from "react"
import {
  getVapidPublicKey,
  listMyPushDevices,
  subscribePush,
  unsubscribePush,
  type PushDeviceRow,
} from "@/app/actions/push-subscriptions"

type PushState =
  | "loading" // feature-detecting / reading current subscription
  | "unsupported" // browser has no service worker / Push API
  | "unconfigured" // platform has no VAPID public key
  | "denied" // Notification permission is denied at the browser level
  | "disabled" // supported + configured, not subscribed
  | "enabled" // active subscription exists
  | "working" // subscribe/unsubscribe in flight

/** Convert a base64url VAPID key to the Uint8Array PushManager expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

function subscriptionKeys(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const json = sub.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!p256dh || !auth) return null
  return { p256dh, auth }
}

/**
 * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF.
 *
 * `push_subscriptions.user_agent` was written and never read, so this renders
 * it — as a short device label rather than the 200-character UA string. Pure
 * string matching on the raw UA; wrong guesses degrade to "Browser", never to
 * a claim about a device the user does not own.
 */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device"
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser"
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : ""
  return os ? `${browser} on ${os}` : browser
}

/** The honest reason a device stopped receiving push, in the user's words. */
function deviceState(d: PushDeviceRow): { text: string; dead: boolean } {
  if (!d.disabledAt) {
    return {
      text: d.lastSeenAt ? `Active — last confirmed ${new Date(d.lastSeenAt).toLocaleDateString()}` : "Active",
      dead: false,
    }
  }
  const why =
    d.disabledReason === "endpoint_gone"
      ? "the browser dropped the subscription (cleared site data, or the app was removed)"
      : d.disabledReason === "user_unsubscribed"
        ? "you turned push off on that device"
        : d.disabledReason ?? "no reason was recorded"
  return { text: `Not receiving push — ${why}`, dead: true }
}

export function PushPermissionToggle() {
  const [state, setState] = useState<PushState>("loading")
  const [error, setError] = useState("")
  const [devices, setDevices] = useState<PushDeviceRow[] | null>(null)
  const [devicesError, setDevicesError] = useState("")

  const loadDevices = useCallback(async () => {
    const result = await listMyPushDevices()
    // Fail LOUD (§4): an unread refusal rendered as an empty list would read as
    // "no devices", the very false all-clear this panel exists to prevent.
    if (result.success) { setDevices(result.devices ?? []); setDevicesError("") }
    else { setDevices(null); setDevicesError(result.error ?? "Could not read your push devices.") }
  }, [])

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        if (!cancelled) setState("unsupported")
        return
      }
      try {
        const publicKey = await getVapidPublicKey()
        if (cancelled) return
        if (!publicKey) {
          setState("unconfigured")
          return
        }
        if (Notification.permission === "denied") {
          setState("denied")
          return
        }
        const registration = await navigator.serviceWorker.getRegistration("/push-sw.js")
        const existing = await registration?.pushManager.getSubscription()
        if (!cancelled) setState(existing ? "enabled" : "disabled")
      } catch (e) {
        console.error("[v0] push toggle init failed:", e)
        if (!cancelled) setState("disabled")
      }
    }
    init()
    return () => {
      cancelled = true
    }
  }, [])

  // The device list is about the ACCOUNT, not this browser, so it loads as soon
  // as the platform is known to have push at all — including when THIS browser
  // is unsubscribed or blocked, which is exactly when "…but my laptop still
  // gets them, right?" needs answering.
  useEffect(() => {
    if (state === "loading" || state === "unsupported" || state === "unconfigured") return
    void loadDevices()
  }, [state, loadDevices])

  const enable = useCallback(async () => {
    setState("working")
    setError("")
    try {
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "disabled")
        if (permission !== "denied") setError("Notification permission was not granted.")
        return
      }

      const publicKey = await getVapidPublicKey()
      if (!publicKey) {
        setState("unconfigured")
        return
      }

      const registration = await navigator.serviceWorker.register("/push-sw.js")
      await navigator.serviceWorker.ready
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
        }))

      const keys = subscriptionKeys(subscription)
      if (!keys) {
        setError("Browser returned a subscription without encryption keys.")
        setState("disabled")
        return
      }

      const result = await subscribePush({
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: navigator.userAgent,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to save push subscription.")
        setState("disabled")
        return
      }
      setState("enabled")
    } catch (e) {
      console.error("[v0] push subscribe failed:", e)
      setError(e instanceof Error ? e.message : "Failed to enable push notifications.")
      setState(Notification.permission === "denied" ? "denied" : "disabled")
    }
  }, [])

  const disable = useCallback(async () => {
    setState("working")
    setError("")
    try {
      const registration = await navigator.serviceWorker.getRegistration("/push-sw.js")
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        const result = await unsubscribePush({ endpoint: subscription.endpoint })
        if (!result.success) {
          setError(result.error ?? "Failed to unsubscribe.")
        }
        await subscription.unsubscribe()
      }
      setState("disabled")
    } catch (e) {
      console.error("[v0] push unsubscribe failed:", e)
      setError(e instanceof Error ? e.message : "Failed to disable push notifications.")
      setState("enabled")
    }
  }, [])

  if (state === "loading") {
    return <p className="text-sm text-gray-500">Checking push notification support…</p>
  }
  if (state === "unsupported") {
    return <p className="text-sm text-gray-500">This browser does not support push notifications.</p>
  }
  if (state === "unconfigured") {
    return (
      <p className="text-sm text-gray-500">
        Browser push is not configured on this platform yet (missing VAPID keys).
      </p>
    )
  }
  if (state === "denied") {
    return (
      <p className="text-sm text-gray-600">
        Notifications are blocked for this site. Allow notifications in your browser&apos;s site
        settings, then reload this page to enable push.
      </p>
    )
  }

  const enabled = state === "enabled"
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-900">Browser push notifications</p>
          <p className="text-sm text-gray-600">
            {enabled
              ? "Enabled on this browser — urgent alerts arrive even when the app is closed."
              : "Get urgent alerts on this device even when the app is closed."}
          </p>
        </div>
        <button
          type="button"
          onClick={enabled ? disable : enable}
          disabled={state === "working"}
          className={
            enabled
              ? "px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              : "px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          }
        >
          {state === "working" ? "Working…" : enabled ? "Disable push" : "Enable push"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="border-t border-gray-200 pt-2">
        <p className="text-xs font-medium text-gray-900">Your push devices</p>
        {devicesError ? (
          <p className="text-xs text-red-600">{devicesError}</p>
        ) : devices === null ? (
          <p className="text-xs text-gray-500">Reading your devices…</p>
        ) : devices.length === 0 ? (
          <p className="text-xs text-gray-500">
            No device has ever been registered for push on this account.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {devices.map((d) => {
              const s = deviceState(d)
              return (
                <li key={d.id} className="text-xs">
                  <span className="font-medium text-gray-900">{deviceLabel(d.userAgent)}</span>
                  <span className={s.dead ? " text-red-600" : " text-gray-600"}> — {s.text}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
