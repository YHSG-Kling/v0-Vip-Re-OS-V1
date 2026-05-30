import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { scanOfferPacketCompleteness } from "@/lib/workflow/intelligence/scan-offer-packet"

export async function POST(_req: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const result = await scanOfferPacketCompleteness({ offerId, raiserUserId: user.id })
  if (!result.success) {
    return NextResponse.json(result, { status: 400 })
  }
  return NextResponse.json(result)
}
