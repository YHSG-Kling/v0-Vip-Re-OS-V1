import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { NextResponse } from "next/server"

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ wakeWord: null }, { status: 200 })

  const service = createServiceClient()
  const { data } = await service
    .from("users")
    .select("assistant_wake_name")
    .eq("id", user.id)
    .maybeSingle()

  return NextResponse.json({ wakeWord: data?.assistant_wake_name ?? null })
}
