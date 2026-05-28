/**
 * <NegotiationMirrorPanel> — customer-facing view of the same negotiation
 * strategy the agent is looking at. Sprint 8.
 *
 * The kernel move: when a counter is in play, the customer sees the
 * AI's plain-language explanation of:
 *   - what's happening in the negotiation
 *   - what the agent is recommending and why
 *   - what the win probability is
 *
 * Reads from negotiation_strategies where contact_id = this contact AND
 * status = 'open'. RLS gates self-access (policy ns_contact_self).
 *
 * Hides on empty (no flash, no "nothing to show" copy).
 *
 * Server component. Wrap in <Suspense> upstream if you want streaming.
 */

import { getNegotiationStrategyForContactAction } from "@/app/actions/negotiation-strategy"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Handshake } from "lucide-react"

interface Props {
  contactId: string
}

export async function NegotiationMirrorPanel({ contactId }: Props) {
  const result = await getNegotiationStrategyForContactAction(contactId)
  if (!result.ok)         return null
  if (!result.strategy)   return null
  const s = result.strategy
  if (!s.customerExplanationMd) return null  // no mirror to show

  const winPct = s.winProbability != null ? Math.round(s.winProbability * 100) : null

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-blue-900">
          <Handshake className="h-4 w-4" />
          Where the negotiation stands
          {winPct != null && (
            <Badge variant="outline" className="ml-auto text-xs bg-white">
              {winPct}% likelihood
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-blue-950">
          {s.customerExplanationMd}
        </div>
        <p className="text-[11px] text-blue-700 mt-3">
          Your agent is seeing the same analysis. The recommended move on their side is
          <span className="font-medium"> &ldquo;{s.recommendedAction.replace(/_/g, " ")}&rdquo;</span>.
        </p>
      </CardContent>
    </Card>
  )
}
