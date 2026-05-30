"use client"

/**
 * ContactPulsePanel — Consolidated relationship-health card.
 *
 * Replaces the trio of overlapping panels (RelationshipRadar +
 * ContactOSSummary + ReferralLikelihoodPanel). Single source of truth
 * for: engagement, last contact recency, message temperature,
 * referral likelihood, open thread count, and an AI-generated headline.
 *
 * Used at the top of the Contact detail Overview tab.
 */

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Loader2, ArrowRight } from "lucide-react"

interface ContactPulsePanelProps {
  /** AI / engagement score 0-100 */
  engagementScore?: number | null
  /** Days since last touch */
  daysSinceContact?: number | null
  /** Sentiment classification */
  messageTemperature?: "hot" | "warm" | "cold" | "unknown" | null
  /** AI-classified referral potential */
  referralPotential?: "high" | "medium" | "low" | null
  /** Number of active comm threads */
  openThreadCount?: number
  /** Optional last-contact ISO string for absolute date display */
  lastContactedAt?: string | null
  /** Onclick for the "Generate referral ask" CTA */
  onGenerateReferralAsk?: () => Promise<void> | void
  /** Whether the referral ask is being generated */
  generatingReferralAsk?: boolean
  /** Onclick for opening the conversation thread */
  onOpenInbox?: () => void
}

export function ContactPulsePanel({
  engagementScore,
  daysSinceContact,
  messageTemperature,
  referralPotential,
  openThreadCount = 0,
  lastContactedAt,
  onGenerateReferralAsk,
  generatingReferralAsk = false,
  onOpenInbox,
}: ContactPulsePanelProps) {
  // --- Derive the headline + tone ----------------------------------
  const headline = deriveHeadline({
    engagementScore,
    daysSinceContact,
    messageTemperature,
    openThreadCount,
    referralPotential,
  })

  // --- Color helpers -----------------------------------------------
  const recencyTone = getRecencyTone(daysSinceContact)
  const tempTone = getTempTone(messageTemperature)
  const refTone = getReferralTone(referralPotential)
  const engTone = getEngagementTone(engagementScore)

  return (
    <Card className="border-l-4 border-l-primary">
      <CardContent className="p-4 space-y-3">
        {/* AI Headline */}
        <p className="text-sm font-medium text-foreground">{headline}</p>

        {/* 4 KPI tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Kpi
            label="Engagement"
            value={engagementScore != null ? `${engagementScore}` : "—"}
            sublabel={engagementScore != null ? scoreBand(engagementScore) : null}
            tone={engTone}
          />
          <Kpi
            label="Last Touch"
            value={daysSinceContact != null ? `${daysSinceContact}d` : "Never"}
            sublabel={
              lastContactedAt
                ? new Date(lastContactedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                : daysSinceContact == null
                ? "no contact yet"
                : daysSinceContact < 7
                ? "recent"
                : daysSinceContact < 30
                ? "warming"
                : "stale"
            }
            tone={recencyTone}
          />
          <Kpi
            label="Temperature"
            value={messageTemperature ? cap(messageTemperature) : "—"}
            sublabel={tempSubtitle(messageTemperature)}
            tone={tempTone}
          />
          <Kpi
            label="Referral"
            value={referralPotential ? cap(referralPotential) : "—"}
            sublabel={referralSubtitle(referralPotential)}
            tone={refTone}
          />
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
          <Badge variant="outline" className="font-normal text-xs">
            {openThreadCount} {openThreadCount === 1 ? "open thread" : "open threads"}
          </Badge>
          {openThreadCount > 0 && onOpenInbox && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={onOpenInbox}>
              View inbox
              <ArrowRight className="h-3 w-3" />
            </Button>
          )}
          <div className="ml-auto" />
          {referralPotential === "high" && onGenerateReferralAsk && (
            <Button
              size="sm"
              variant="default"
              className="h-7 gap-1 text-xs"
              onClick={() => onGenerateReferralAsk()}
              disabled={generatingReferralAsk}
            >
              {generatingReferralAsk ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {generatingReferralAsk ? "Drafting…" : "Draft referral ask"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type Tone = "good" | "warning" | "bad" | "neutral"

function Kpi({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string
  value: string
  sublabel?: string | null
  tone: Tone
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5 space-y-0.5",
        tone === "good" && "bg-emerald-50/40 border-emerald-200",
        tone === "warning" && "bg-amber-50/40 border-amber-200",
        tone === "bad" && "bg-red-50/40 border-red-200",
        tone === "neutral" && "bg-muted/20"
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
      <p className="text-lg font-bold leading-none">{value}</p>
      {sublabel && <p className="text-[10px] text-muted-foreground">{sublabel}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tone derivers
// ---------------------------------------------------------------------------

function getEngagementTone(score?: number | null): Tone {
  if (score == null) return "neutral"
  if (score >= 70) return "good"
  if (score >= 40) return "warning"
  return "bad"
}

function getRecencyTone(days?: number | null): Tone {
  if (days == null) return "neutral"
  if (days < 7) return "good"
  if (days < 30) return "warning"
  return "bad"
}

function getTempTone(temp?: "hot" | "warm" | "cold" | "unknown" | null): Tone {
  if (temp === "hot") return "good"
  if (temp === "warm") return "warning"
  if (temp === "cold") return "bad"
  return "neutral"
}

function getReferralTone(potential?: "high" | "medium" | "low" | null): Tone {
  if (potential === "high") return "good"
  if (potential === "medium") return "warning"
  return "neutral"
}

function scoreBand(s: number): string {
  if (s >= 70) return "strong"
  if (s >= 40) return "moderate"
  return "weak"
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function tempSubtitle(t?: "hot" | "warm" | "cold" | "unknown" | null): string | null {
  if (t === "hot") return "buy signals"
  if (t === "warm") return "interested"
  if (t === "cold") return "low signal"
  return null
}

function referralSubtitle(p?: "high" | "medium" | "low" | null): string | null {
  if (p === "high") return "ask now"
  if (p === "medium") return "build rapport"
  if (p === "low") return "keep nurturing"
  return null
}

// ---------------------------------------------------------------------------
// AI Headline (rule-based; future: server-generated)
// ---------------------------------------------------------------------------

function deriveHeadline(input: {
  engagementScore?: number | null
  daysSinceContact?: number | null
  messageTemperature?: "hot" | "warm" | "cold" | "unknown" | null
  openThreadCount: number
  referralPotential?: "high" | "medium" | "low" | null
}): string {
  const { engagementScore, daysSinceContact, messageTemperature, openThreadCount, referralPotential } = input

  // 1. Hot + recent → urgent
  if (messageTemperature === "hot" && (daysSinceContact ?? 0) < 7) {
    return openThreadCount > 0
      ? "🔥 Hot signal — reply to the open thread today."
      : "🔥 Hot signal — reach out today while interest is high."
  }

  // 2. Stale (>30d)
  if (daysSinceContact != null && daysSinceContact >= 30) {
    return `Cooling — ${daysSinceContact} days since last touch. Re-engage with a personalized message.`
  }

  // 3. High referral potential
  if (referralPotential === "high") {
    return "Strong referral candidate — ask for an introduction."
  }

  // 4. Open thread waiting
  if (openThreadCount > 0) {
    return `${openThreadCount} ${openThreadCount === 1 ? "thread is" : "threads are"} open — respond to keep momentum.`
  }

  // 5. High engagement
  if ((engagementScore ?? 0) >= 70) {
    return "Strong engagement — schedule the next touchpoint."
  }

  // 6. Cold
  if (messageTemperature === "cold") {
    return "Quiet relationship — try a value-first re-engagement."
  }

  // 7. Default
  return "Relationship steady — maintain regular cadence."
}
