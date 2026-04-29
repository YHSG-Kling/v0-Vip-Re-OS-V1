import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export interface AuthContext {
  ok: true
  user: { id: string; email: string }
  agentId: string | null
  brokerageId: string | null
  userType: string | null
}

interface AuthFailure {
  ok: false
  response: NextResponse
}

export type AuthResult = AuthContext | AuthFailure

export async function requireAuth(supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AuthResult> {
  const client = supabase ?? (await createClient())
  const { data: { user }, error } = await client.auth.getUser()

  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  const { data: userData } = await client
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const { data: agentRow } = await client
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  return {
    ok: true,
    user: { id: user.id, email: user.email ?? "" },
    agentId: agentRow?.id ?? null,
    brokerageId: userData?.brokerage_id ?? null,
    userType: userData?.user_type ?? null,
  }
}

export async function requireSuperadminAuth(supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AuthResult> {
  const result = await requireAuth(supabase)
  if (!result.ok) return result

  if (result.userType !== "superadmin") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden: superadmin only" }, { status: 403 }),
    }
  }

  return result
}
