// app/api/agentic-os/resolve-capability/route.ts
// AI-API agent introspection endpoint. Given a business capability (+ optional
// brokerage), returns the live, budget-aware connector selection + business context.
// PLATFORM STAFF ONLY — the response names vendors and exposes the downgrade ladder,
// which are platform-internal (brokerage UIs never call this; their warning banner is
// vendor-anonymous). Internal AI-agent server code calls resolveVendorCapability()
// directly rather than over HTTP.
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requirePlatformStaffAuth } from "@/lib/kernel/api-auth"
import { resolveVendorCapability } from "@/lib/agentic-os/resolve-vendor-capability"
import { VENDOR_CAPABILITY_REGISTRY, type VendorCapability } from "@/lib/agentic-os/vendor-capability-registry"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const auth = await requirePlatformStaffAuth(supabase)
  if (!auth.ok) return auth.response

  let body: { capability?: string; brokerageId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const capability = body.capability as VendorCapability
  if (!capability || !(capability in VENDOR_CAPABILITY_REGISTRY)) {
    return NextResponse.json(
      { error: "Unknown capability", available: Object.keys(VENDOR_CAPABILITY_REGISTRY) },
      { status: 400 },
    )
  }

  const resolved = await resolveVendorCapability(capability, { brokerageId: body.brokerageId ?? auth.brokerageId })
  return NextResponse.json(resolved)
}

// Discovery: list all capabilities + their context (no live budget read).
export async function GET() {
  const supabase = await createClient()
  const auth = await requirePlatformStaffAuth(supabase)
  if (!auth.ok) return auth.response
  return NextResponse.json({ capabilities: VENDOR_CAPABILITY_REGISTRY })
}
