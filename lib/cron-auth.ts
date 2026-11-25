/**
 * lib/cron-auth.ts
 *
 * Shared cron-endpoint auth helper. Three bug classes this prevents:
 *
 *   1. `authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` — when the env
 *      var is unset, the template literal evaluates to "Bearer undefined" and
 *      an attacker can bypass auth with that literal header value. Verified:
 *         node -e "console.log(\`Bearer \${undefined}\`)"  // "Bearer undefined"
 *
 *   2. `if (cronSecret && authHeader !== ...)` — fail-OPEN. When the env var
 *      is unset, the whole check is skipped and the endpoint is public.
 *
 *   3. `if (presented !== process.env.CRON_SECRET)` where `presented` can be
 *      `undefined` (e.g. `headers.get("authorization")?.replace(...)` with no
 *      header) — unset env + no credential is `undefined !== undefined`, which
 *      is false, so the request passes. (lane 86G: app/api/fatigue/calculate.)
 *
 * All three are closed here: missing env var → 500, missing/mismatched
 * credential → 401. scripts/cron-auth-fail-closed-guard.ts holds every
 * app/api route to this (census over stripped source, with positive controls).
 */

import { NextResponse } from "next/server"; import { enterOriginTrust } from "@/lib/kernel/causation" // 156M: a verified scheduler run states its origin trust once

/**
 * The ONE alternate credential header. A few internal callers (a server action
 * that triggers a cron by hand — app/actions/system-health.ts) send the raw
 * secret here instead of `Authorization: Bearer`. A route admits it only by
 * opting in through verifyCronAuth's `acceptCronSecretHeader`; there is no
 * second spelling and no query-string credential.
 */
export const CRON_SECRET_HEADER = "x-cron-secret"

export interface CronAuthOptions {
  /** Also accept the raw secret in the `x-cron-secret` header. Default false. */
  acceptCronSecretHeader?: boolean
}

export function verifyCronAuth(request: Request, opts: CronAuthOptions = {}): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET not configured — rejecting request")
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 })
  }
  const authHeader = request.headers.get("authorization")
  if (authHeader === `Bearer ${secret}`) { enterOriginTrust("tenant_policy", "cron_scheduler"); return null }
  if (opts.acceptCronSecretHeader && request.headers.get(CRON_SECRET_HEADER) === secret) { enterOriginTrust("tenant_policy", "cron_scheduler"); return null }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

/**
 * WHO IS ASKING FOR A MANUAL RUN — the scheduler, or a signed-in person? (wave 155)
 *
 * Two cron routes carried a POST "manual rescan" beside their scheduled GET (app/api/cron/deal-health-scan and
 * app/api/cron/listing-health-scan) and neither POST had ANY gate: no credential, no session. Anyone on the internet could name
 * a transaction or a listing of any tenant, have it re-scored with the service client, read the score back, and — on the deal
 * route — raise at-risk events and an intervention row for that tenant. scripts/cron-auth-fail-closed-guard.ts did not see it
 * because it looks for a BADLY written credential check; a handler with no check at all has nothing to find (G7 closes that).
 *
 * This is the one answer to "who is calling" for such a door. It AUTHENTICATES only; each route still decides whether that
 * caller may act on the one record named (the deal-work rule, the listing page's rule):
 *   · a request that PRESENTS an Authorization header is held to verifyCronAuth — unset secret → 500, wrong → 401. A bad
 *     credential is never rescued by a session cookie that happens to ride along;
 *   · otherwise the SESSION decides (lib/auth/require-caller.ts — tenant from the session, CLAUDE.md §4). No session → 401;
 *     a session whose profile cannot be read → 503 (the gate could not run, so it refuses); no workspace → 403;
 *   · a gate that throws refuses (401). "Nobody checked" never reads as "allowed".
 * `x-cron-secret` is not consulted here: no manual-run door has opted in to it (one spelling, §6).
 */
export type CronOrSessionCaller =
  | { kind: "scheduler" }
  | {
      kind: "session"
      /** The SESSION user (users.id). */
      userId: string
      /** The SESSION's tenant — never a body field. */
      brokerageId: string
      /** users.user_type as stored (not defaulted). */
      userType: string | null
      /** The session (row-security-bound) client that resolved the caller, for the route's own scoped read. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: any
    }

/** What the session read answers (the shape of lib/auth/require-caller.ts requireCaller — restated structurally so this
 *  module does not import the session reader at load time). */
type SessionCallerRead =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { ok: true; userId: string; brokerageId: string; userType: string | null; supabase: any }
  | { ok: false; reason: "unauthenticated" | "unreadable" | "no_brokerage" | "tenant_mismatch"; error: string }

export async function requireCronOrSessionCaller(
  request: Request,
  /** Proof seam (scripts/cron-auth-fail-closed-guard.ts G7): the session read. Routes never pass it. */
  deps: { requireCaller?: () => Promise<SessionCallerRead> } = {},
): Promise<{ ok: true; caller: CronOrSessionCaller } | { ok: false; response: NextResponse }> {
  if (request.headers.get("authorization")) {
    const unauth = verifyCronAuth(request)
    return unauth ? { ok: false, response: unauth } : { ok: true, caller: { kind: "scheduler" } }
  }
  try {
    // Dynamic: this module is imported by every cron route; the session reader (cookies) is needed only on this path.
    const requireCaller = deps.requireCaller ?? (await import("@/lib/auth/require-caller")).requireCaller
    const who = await requireCaller()
    if (!who.ok) {
      if (who.reason === "unauthenticated") return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
      if (who.reason === "unreadable") return { ok: false, response: NextResponse.json({ error: "Your access could not be confirmed. Try again in a moment." }, { status: 503 }) }
      return { ok: false, response: NextResponse.json({ error: "Your account is not linked to a workspace" }, { status: 403 }) }
    }
    return { ok: true, caller: { kind: "session", userId: who.userId, brokerageId: who.brokerageId, userType: who.userType, supabase: who.supabase } }
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
}
