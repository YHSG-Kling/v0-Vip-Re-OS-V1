import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Users, ArrowRight } from "lucide-react"

// "Buyer Pulse" — AI-distilled, BUYER-SAFE community sentiment for home buyers. Sourced from the SAME
// national market_pulse row the seller card reads (ensureNationalMarketPulse distills home-buyer forum
// chatter once a week), but rendered through the BUYER lens (insight.buyerAngle): what other buyers are
// prioritizing and how to use it to search and compete with confidence. No competitor surfaces real
// buyer-community sentiment to buyers — this keeps the buyer engaged and ready to act. Pure display;
// renders nothing if absent. Falls back to `detail` for legacy pulse rows written before buyerAngle.

interface PulseInsight { priority?: string; detail?: string; buyerAngle?: string }
interface MarketPulse { headline?: string; insights?: PulseInsight[] }

export function BuyerPulseCard({ pulse }: { pulse: MarketPulse | null }) {
  const insights = (pulse?.insights ?? []).filter((i) => i.priority && i.detail)
  if (!pulse || insights.length === 0) return null
  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4 text-blue-600" />
          Buyer Pulse
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {pulse.headline || "What buyers like you are focused on right now"} — so you can search with confidence.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.map((i, idx) => (
          <div key={`${i.priority}-${idx}`} className="rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">{i.priority}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{i.detail}</p>
            <p className="text-xs text-blue-700 mt-1.5 flex items-start gap-1">
              <ArrowRight className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{i.buyerAngle || i.detail}</span>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
