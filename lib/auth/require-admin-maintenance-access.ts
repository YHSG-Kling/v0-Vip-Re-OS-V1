"use server"
import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function requireAdminMaintenanceAccess(request: Request): Promise<
  { authorized: true } | { authorized: false; response: NextResponse }
> {
  // Block in production unless explicitly enabled
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PROD_MAINTENANCE_ROUTES !== "true"
  ) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    }
  }

  // Require maintenance secret header when key is configured
  const maintenanceKey = request.headers.get("x-admin-maintenance-key")
  const expectedKey = process.env.ADMIN_MAINTENANCE_KEY
  if (expectedKey && maintenanceKey !== expectedKey) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  // Require authenticated session
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  // Require admin or broker role
  const { data: profile } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.id)
    .single()

  // TRUE ADMIN GATE (operational maintenance): repointed to the ONE tenant
  // roster. 'superadmin' was dead here — 0 live rows store that user_type.
  if (!profile || !isAdminOrBroker({ user_type: profile.user_type })) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    }
  }

  // Audit log to activities table. This is the record of WHO reached an
  // operational maintenance endpoint and from where — the row a security
  // review would ask for. Non-blocking, but not unobserved.
  const { error: maintenanceAuditError } = await supabase
    .from("activities")
    .insert({
      activity_type: "maintenance.access",
      agent_user_id: user.id,
      metadata: {
        endpoint: "maintenance",
        timestamp: new Date().toISOString(),
        ip: request.headers.get("x-forwarded-for") || "unknown",
      },
    })
  if (maintenanceAuditError) {
    console.error("[require-admin-maintenance-access] maintenance.access audit REJECTED — this admin's access is unlogged:", maintenanceAuditError.message)
  }

  return { authorized: true }
}
