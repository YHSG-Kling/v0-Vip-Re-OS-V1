import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { TrendingUp, Lightbulb } from "lucide-react"

// "Market Pulse" — AI-distilled, seller-safe buyer priorities (market_pulse.insights, written by
// ensureNationalMarketPulse from real-estate forum chatter). Pure display; renders nothing if absent.

interface PulseInsight { priority?: string; detail?: string; sellerAngle?: string }
interface MarketPulse { headline?: string; insights?: PulseInsight[] }

export function SellerMarketPulseCard({ pulse }: { pulse: MarketPulse | null }) {
  const insights = (pulse?.insights ?? []).filter((i) => i.priority && i.detail)
  if (!pulse || insights.length === 0) return null
  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-indigo-600" />
          Market Pulse
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {pulse.headline || "What buyers are focused on right now"} — so your home meets them where they are.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.map((i, idx) => (
          <div key={`${i.priority}-${idx}`} className="rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">{i.priority}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{i.detail}</p>
            {i.sellerAngle && (
              <p className="text-xs text-indigo-700 mt-1.5 flex items-start gap-1">
                <Lightbulb className="h-3 w-3 mt-0.5 shrink-0" />
                <span>{i.sellerAngle}</span>
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
