// lib/security/public-rate-limit.ts
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC-SURFACE RATE LIMITER — the keep-one throttle for the handful of
// UNAUTHENTICATED write surfaces (self-serve signup, the public funnel's
// coupon check, the embed widget's session mint + chat). Webhooks don't need
// it (signature-gated); portal OTP doesn't need it (Supabase Auth applies its
// own OTP rate limits); authenticated surfaces are gated by auth + usage caps.
//
// HONESTY NOTE — PER-INSTANCE ONLY: this is a fixed-window counter in process
// memory. On serverless (Vercel) each warm instance keeps its own counters, so
// the real ceiling is (limit × concurrent instances) and a cold start resets
// the window. That is the honest, dependency-free posture for beta: it stops
// tight abuse loops (one client hammering one instance) and costs nothing.
// A DISTRIBUTED limiter (Upstash/Redis or a Postgres counter) is the stated
// v2 when signup volume justifies a shared ledger. No values are logged; keys
// are IPs or opaque session tokens, kept only in memory for the window.
//
// Zero deps, no env vars, no DB. Used by:
//   - app/actions/auth/signup-brokerage.ts   (per-IP, tight)
//   - app/get-started/actions.ts             (per-IP coupon probing)
//   - app/api/widget/session/route.ts        (per-IP session mint)
//   - app/api/widget/message/route.ts        (per-session-token LLM spend)

import "server-only"
import { headers } from "next/headers"

export interface PublicRateVerdict {
  allowed: boolean
  /** Seconds until the window resets — for Retry-After / friendly copy. */
  retryAfterSeconds: number
}

interface WindowEntry {
  count: number
  resetAt: number
}

// One shared map across all surfaces; keys are namespaced by surface.
const windows = new Map<string, WindowEntry>()

// Bounded memory: past this size, drop expired entries; if still over, drop
// oldest-reset first. Public abuse can't balloon a serverless instance's heap.
const MAX_ENTRIES = 5000

function prune(now: number): void {
  if (windows.size < MAX_ENTRIES) return
  for (const [k, v] of windows) {
    if (v.resetAt <= now) windows.delete(k)
  }
  if (windows.size >= MAX_ENTRIES) {
    const oldest = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (const [k] of oldest.slice(0, Math.ceil(MAX_ENTRIES / 10))) windows.delete(k)
  }
}

/**
 * Fixed-window check. `surface` namespaces the counter ("signup", "widget-message"),
 * `key` is the caller identity (IP or opaque session token).
 * Returns allowed=false once `limit` calls have landed inside `windowMs`.
 */
export function checkPublicRateLimit(
  surface: string,
  key: string,
  opts: { limit: number; windowMs: number },
): PublicRateVerdict {
  const now = Date.now()
  const mapKey = `${surface}:${key}`
  const entry = windows.get(mapKey)

  if (!entry || now > entry.resetAt) {
    prune(now)
    windows.set(mapKey, { count: 1, resetAt: now + opts.windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (entry.count >= opts.limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }

  entry.count++
  return { allowed: true, retryAfterSeconds: 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PUBLIC-DOOR DECISION (wave 155, lane 155R18 — the decisions lane 155R5 established, named once).
// A door a visitor must reach without signing in is never put behind a login wall. It decides from two facts, in this order,
// BEFORE the caller writes or spends anything:
//   1. the per-surface CAP (checkPublicRateLimit above) — evaluated first, so a flood never reaches the database read;
//   2. the TENANT'S OWN OPT-IN, read by the caller's `optIn` function: a row the tenant itself published (an event, a blog
//      post, a landing page, a publicly visible listing), a sealed one-time credential the tenant issued (an intake token, a
//      collaborator token, a widget-minted session id), or the live tenant a public slug names. The read returns the tenant
//      it proves (the brokerage of THAT row — never a body field) and the basis in words, or null.
// Fail closed: no opt-in, a tenant-less opt-in on a tenant door, or a read that throws → refused. Only the platform's OWN
// funnel (no tenant exists) passes `platform: true`. The verdict carries the proven tenant so the write uses it.
export interface PublicDoorOptIn {
  /** The tenant the opt-in row proves (that row's brokerage_id). Null only on the platform's own funnel. */
  brokerageId: string | null
  /** What was read, in words — e.g. "open_house_events.is_published". */
  basis: string
  /** The platform's own public funnel (no tenant exists). Never set on a tenant's door. */
  platform?: boolean
}
export type PublicDoorVerdict =
  | { allowed: true; brokerageId: string | null; basis: string; retryAfterSeconds: 0 }
  | { allowed: false; reason: "rate_limited" | "not_opted_in"; status: 404 | 429; retryAfterSeconds: number; basis: string | null }

export async function decidePublicDoor(input: {
  surface: string
  callerKey: string
  cap: { limit: number; windowMs: number }
  optIn: () => Promise<PublicDoorOptIn | null>
}): Promise<PublicDoorVerdict> {
  const rate = checkPublicRateLimit(input.surface, input.callerKey || "unknown", input.cap)
  if (!rate.allowed) return { allowed: false, reason: "rate_limited", status: 429, retryAfterSeconds: rate.retryAfterSeconds, basis: null }
  let o: PublicDoorOptIn | null = null
  try { o = await input.optIn() } catch { o = null }
  if (!o || !o.basis || (!o.brokerageId && o.platform !== true)) {
    return { allowed: false, reason: "not_opted_in", status: 404, retryAfterSeconds: 0, basis: o?.basis ?? null }
  }
  return { allowed: true, brokerageId: o.brokerageId ?? null, basis: o.basis, retryAfterSeconds: 0 }
}

/** The caller IP from a route handler's own request headers (no `headers()` call — a route already holds its request). */
export function callerIpFrom(h: { get(name: string): string | null }): string {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown"
}

/**
 * Best-effort caller IP for server actions / route handlers behind Vercel's
 * proxy. Falls back to "unknown" (still throttled — as ONE shared bucket —
 * rather than unthrottled) when no forwarding header exists.
 */
export async function publicCallerIp(): Promise<string> {
  try {
    const h = await headers()
    const fwd = h.get("x-forwarded-for")
    if (fwd) return fwd.split(",")[0]!.trim()
    return h.get("x-real-ip")?.trim() || "unknown"
  } catch {
    return "unknown"
  }
}
