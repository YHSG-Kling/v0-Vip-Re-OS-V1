// app/api/v1/[resource]/route.ts — the versioned DOMAIN API (wave 137A).
//
// A door, not a service: credential auth, tenant, rate limit, scope, entitlement, the domain
// read / capability request and the evidence row all live in lib/kernel/domain-api.ts. Reachable
// by design from OUTSIDE the repo (an integration holding a vos_ credential minted at
// app/settings/developers) — recorded in scripts/opposite-missing-census.ts QUALIFIED_EXTERNAL_ROUTES.
import { serveDomainApi } from "@/lib/kernel/domain-api"

export const dynamic = "force-dynamic"

export async function GET(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  const { resource } = await ctx.params
  return serveDomainApi(req, resource)
}

export async function POST(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  const { resource } = await ctx.params
  return serveDomainApi(req, resource)
}
