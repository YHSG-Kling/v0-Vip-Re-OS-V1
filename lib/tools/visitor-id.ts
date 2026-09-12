// lib/tools/visitor-id.ts
//
// THE IDENTITY A SAVED CALCULATION IS FILED UNDER.
//
// saved_calculations rows are keyed by visitor_id, and getSavedCalculations
// reads them back by that same key. The calculators screen used to mint the key
// with `useState(() => crypto.randomUUID())` — separately in each of its three
// tabs — so:
//
//   · the id died with the component. Nothing could ever be read back, which is
//     why the retrieval action had no caller: there was no id to call it with.
//   · the three tabs disagreed WITHIN a single page load, so a visitor's Seller
//     Net save and their Rent-vs-Buy save were filed under different people.
//
// One id, persisted, shared by every tool on the page. Deliberately NOT a
// login: these are the public, zero-friction calculators, and the point is that
// someone can save a result and come back to it without creating an account.
//
// Client-safe on purpose — ZERO imports, no `server-only` anywhere in its graph,
// because the components that need it are "use client".

const STORAGE_KEY = "vip-re-os.tools.visitor-id"

function randomId(): string {
  // crypto.randomUUID needs a secure context; fall back rather than throw on
  // plain-http previews or older embedded browsers.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The browser's stable tools identity, created on first use.
 *
 * Returns a fresh id when there is no browser or no readable storage (SSR, a
 * blocked-cookies/private-mode profile). That degrades honestly: the save still
 * works, it just cannot be retrieved later — which is exactly what the UI must
 * say in that case, rather than promising a retrieval that will not happen.
 * Use `isVisitorIdPersistent()` to tell the two apart.
 */
export function getOrCreateVisitorId(): string {
  if (typeof window === "undefined") return randomId()

  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const created = randomId()
    window.localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    // localStorage can throw outright (Safari private mode, storage disabled).
    return randomId()
  }
}

/** True when a saved calculation will still be findable on the next visit. */
export function isVisitorIdPersistent(): boolean {
  if (typeof window === "undefined") return false
  try {
    const probe = `${STORAGE_KEY}.probe`
    window.localStorage.setItem(probe, "1")
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}
