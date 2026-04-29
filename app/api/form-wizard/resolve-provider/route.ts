import { NextRequest, NextResponse } from "next/server"
import { resolveTransactionProvider } from "@/lib/integrations/transaction-providers/resolve-transaction-provider"
import { getTransactionProviderEmbedUrl } from "@/lib/integrations/transaction-providers/embed-url"
import { getConnectedEsignProvider } from "@/app/actions/buyer-offers"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

  const { searchParams } = req.nextUrl
  const agentUserId = searchParams.get("agentUserId") ?? user.id
  const teamId = searchParams.get("teamId") || null
  const brokerageId = searchParams.get("brokerageId") ?? ""

  if (!brokerageId) return NextResponse.json({ error: "brokerageId required" }, { status: 400 })

  const [resolved, esignResult] = await Promise.all([
    resolveTransactionProvider({ agentUserId, teamId, brokerageId }),
    getConnectedEsignProvider(brokerageId),
  ])

  return NextResponse.json({
    provider: resolved?.provider ?? null,
    credentialsId: resolved?.credentialsId ?? null,
    embedUrl: resolved?.provider ? getTransactionProviderEmbedUrl(resolved.provider) : null,
    esignProvider: esignResult?.provider ?? null,
  })
}
