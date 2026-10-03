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

import { NextResponse } from "next/server"

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
  if (authHeader === `Bearer ${secret}`) return null
  if (opts.acceptCronSecretHeader && request.headers.get(CRON_SECRET_HEADER) === secret) return null
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
