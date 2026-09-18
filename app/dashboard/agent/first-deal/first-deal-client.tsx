"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  CheckCircle2,
  Circle,
  ArrowRight,
  Sparkles,
  GraduationCap,
  Mic2,
  Plug,
  UserPlus,
  FileSignature,
  FileText,
  Handshake,
  PartyPopper,
} from "lucide-react"

interface Milestones {
  onboardingCertified: boolean
  avatarVoiceReady:    boolean
  techStackConnected:  boolean
  firstContactAdded:   boolean
  bbaSigned:           boolean
  firstOfferDrafted:   boolean
  underContract:       boolean
  firstClose:          boolean
}

interface Props {
  firstName:        string | null
  milestones:       Milestones
  onboardingPercent: number
  techStackDetail:  { hasSms: boolean; hasEmail: boolean; hasEsign: boolean }
  agentHasRow:      boolean
}

/** Ordered milestone definition — the wizard advances through this list. */
const MILESTONE_DEFS: ReadonlyArray<{
  key:    keyof Milestones
  title:  string
  body:   string
  href:   string
  cta:    string
  Icon:   typeof CheckCircle2
}> = [
  {
    key:   "onboardingCertified",
    title: "Finish onboarding certification",
    body:  "Complete the 7-day onboarding curriculum — license, E&O, fair housing, TCPA, MLS rules, and brand standards. Required before you can ship to clients.",
    href:  "/dashboard/onboarding",
    cta:   "Resume onboarding",
    Icon:  GraduationCap,
  },
  {
    key:   "avatarVoiceReady",
    title: "Set up your avatar and voice clone",
    body:  "Upload a headshot or short video clip + record a one-minute voice sample. Powers your AI assistant and every auto-generated marketing video.",
    href:  "/dashboard/settings/twin-studio",
    cta:   "Set up Twin Studio",
    Icon:  Mic2,
  },
  {
    key:   "techStackConnected",
    title: "Connect SMS, email, and e-sign",
    body:  "At least one of each (Twilio, SendGrid, and DocuSign / Dotloop / SkySlope) is required before you can send anything from the platform.",
    href:  "/dashboard/onboarding/tech-stack",
    cta:   "Open tech stack setup",
    Icon:  Plug,
  },
  {
    key:   "firstContactAdded",
    title: "Add your first contact",
    body:  "Capture a buyer or seller in your CRM. Every BBA, offer, and transaction starts from a contact record.",
    href:  "/crm/contacts/new",
    cta:   "Add a contact",
    Icon:  UserPlus,
  },
  {
    key:   "bbaSigned",
    title: "Sign your first BBA",
    body:  "NAR 2024 requires a signed Buyer Broker Agreement before you can show properties or write offers for a buyer. The voice cockpit can walk you through it.",
    href:  "/dashboard/buyer-broker-agreements",
    cta:   "Start a BBA",
    Icon:  FileSignature,
  },
  {
    key:   "firstOfferDrafted",
    title: "Draft your first offer",
    body:  "Open your buyer contact and start the offer wizard. The AI fills the state-specific contract, flags missing fields, and walks you through the packet.",
    href:  "/crm",
    cta:   "Open CRM",
    Icon:  FileText,
  },
  {
    key:   "underContract",
    title: "Get under contract",
    body:  "Buyer signs → seller signs → submit to compliance → transaction is auto-created with milestones, deadlines, and participants populated from the contract.",
    href:  "/dashboard/transactions",
    cta:   "View transactions",
    Icon:  Handshake,
  },
  {
    key:   "firstClose",
    title: "Close your first deal",
    body:  "Inspection, appraisal, financing, closing — milestones fire automatically. Your AI assistant keeps the buyer informed at every step.",
    href:  "/dashboard/transactions",
    cta:   "Track to close",
    Icon:  PartyPopper,
  },
]

export function FirstDealClient({
  firstName,
  milestones,
  onboardingPercent,
  techStackDetail,
  agentHasRow,
}: Props) {
  const completedCount = MILESTONE_DEFS.filter(m => milestones[m.key]).length
  const totalCount     = MILESTONE_DEFS.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)
  const nextStep = MILESTONE_DEFS.find(m => !milestones[m.key])

  // If the agent record itself is missing, every downstream count is 0 and
  // the wizard would be inaccurate. Show a clear path to repair.
  if (!agentHasRow) {
    return (
      <div className="container max-w-3xl mx-auto py-12 px-4 text-center">
        <h1 className="text-2xl font-semibold mb-3">Your agent profile is incomplete</h1>
        <p className="text-sm text-muted-foreground mb-6">
          We can&apos;t track your first-deal milestones until your agent record is created.
          Finishing the onboarding wizard creates the record automatically.
        </p>
        <Button asChild>
          <Link href="/dashboard/onboarding">
            Go to onboarding <ArrowRight className="h-4 w-4 ml-1" />
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {firstName ? `${firstName}, here's your path to your first close.` : "Your path to your first close."}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Eight milestones from a fresh signup to a deal that closes. Tap into any milestone to jump to the right tool.
        </p>
      </div>

      {/* ── Progress summary ──────────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardContent className="py-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">
              {completedCount} of {totalCount} milestones complete
            </span>
            <Badge variant={completedCount === totalCount ? "default" : "secondary"}>
              {progressPercent}%
            </Badge>
          </div>
          <Progress value={progressPercent} className="h-2" />
          {!milestones.onboardingCertified && onboardingPercent > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              Onboarding is {onboardingPercent}% done — finish it to clear milestone 1.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Next-action prompt ────────────────────────────────────────────── */}
      {nextStep && (
        <Card className="mb-6 border-indigo-300 bg-indigo-50/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2 text-indigo-900">
              <nextStep.Icon className="h-4 w-4" />
              Next step: {nextStep.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-indigo-950/80">{nextStep.body}</p>
            <Button asChild size="sm">
              <Link href={nextStep.href}>
                {nextStep.cta} <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Completed-first celebratory state ─────────────────────────────── */}
      {completedCount === totalCount && (
        <Card className="mb-6 border-emerald-300 bg-emerald-50/60">
          <CardContent className="py-6 text-center space-y-2">
            <PartyPopper className="h-8 w-8 text-emerald-600 mx-auto" />
            <h2 className="text-lg font-semibold text-emerald-900">
              Your first deal closed.
            </h2>
            <p className="text-sm text-emerald-950/80">
              You're off the runway. Open the agent dashboard for your active pipeline and
              the next AI-suggested actions across all your clients.
            </p>
            <Button asChild size="sm" className="mt-2">
              <Link href="/dashboard/agent">
                Open agent dashboard <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Full milestone checklist ──────────────────────────────────────── */}
      <div className="grid gap-3">
        {MILESTONE_DEFS.map((m, idx) => {
          const done    = milestones[m.key]
          const isNext  = !done && nextStep?.key === m.key
          return (
            <Card key={m.key} className={done ? "opacity-70" : isNext ? "border-indigo-300" : undefined}>
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">
                    {done ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-muted-foreground">Step {idx + 1}</span>
                      <h3 className={`text-sm font-medium ${done ? "line-through text-muted-foreground" : ""}`}>
                        {m.title}
                      </h3>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">{m.body}</p>
                    {/* Tech-stack milestone gets a sub-breakdown */}
                    {m.key === "techStackConnected" && !done && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        <Badge variant={techStackDetail.hasSms ? "default" : "outline"} className="text-[10px]">
                          {techStackDetail.hasSms ? "✓" : "○"} SMS
                        </Badge>
                        <Badge variant={techStackDetail.hasEmail ? "default" : "outline"} className="text-[10px]">
                          {techStackDetail.hasEmail ? "✓" : "○"} Email
                        </Badge>
                        <Badge variant={techStackDetail.hasEsign ? "default" : "outline"} className="text-[10px]">
                          {techStackDetail.hasEsign ? "✓" : "○"} E-sign
                        </Badge>
                      </div>
                    )}
                    {!done && (
                      <Button asChild size="sm" variant={isNext ? "default" : "outline"}>
                        <Link href={m.href}>
                          {m.cta} <ArrowRight className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
