// app/api/health/route.ts — THE LIVENESS ROUTE (wave 152, lane 152K — convergence row 93; finding F-4 in
// docs/architecture/PRODUCTION-ARCHITECTURE.md, spec 143H-OL-07 / 146I-OL-46).
//
// An external uptime monitor or a Vercel check needs ONE unauthenticated answer to "is the app serving?". The only
// health route before this was /api/admin/health-status, which is session-gated (correctly — it reads the database).
// This one is deliberately the opposite: anonymous, NO database call, NO secret, NO tenant data, never cached. It
// answers that the server rendered a response, and which build answered (the public 7-character commit prefix Vercel
// exposes — a build identifier, not a credential). It is PUBLIC BY NAME in app/constants/auth.ts PUBLIC_ROUTES and held
// by scripts/proxy-sessionless-doors-guard.ts (anonymous by design), so a sessionless monitor is never 307'd to /login.

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

function body() {
  return { ok: true, commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null }
}

export async function GET() {
  return NextResponse.json(body(), { headers: { "Cache-Control": "no-store" } })
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { "Cache-Control": "no-store" } })
}
