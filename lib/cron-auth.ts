/**
 * lib/cron-auth.ts
 *
 * Shared cron-endpoint auth helper. Two bug classes this prevents:
 *
 *   1. `authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` — when the env
 *      var is unset, the template literal evaluates to "Bearer undefined" and
 *      an attacker can bypass auth with that literal header value. Verified:
 *         node -e "console.log(\`Bearer \${undefined}\`)"  // "Bearer undefined"
 *
 *   2. `if (cronSecret && authHeader !== ...)` — fail-OPEN. When the env var
 *      is unset, the whole check is skipped and the endpoint is public.
 *
 * Both classes are closed here: missing env var → 500, mismatch → 401.
 */

import { NextResponse } from "next/server"

export function verifyCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET not configured — rejecting request")
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 })
  }
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return null
}
