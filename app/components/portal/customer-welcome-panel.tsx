"use client"

/**
 * Sprint 10 — Customer welcome panel.
 *
 * Renders on the customer portal home when their customer_onboarding row is
 * in_progress AND not dismissed. Persona-aware copy. Five-step checklist
 * with progress bar. Auto-starts the journey if no row exists yet.
 *
 * Hides on completion + on dismissal — no flash.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Circle, Sparkles, X, Loader2 } from "lucide-react"
import {
  advanceCustomerOnboardingStepAction,
  dismissCustomerWelcomeAction,
  getCustomerOnboardingStateAction,
  startCustomerOnboardingAction,
} from "@/app/actions/customer-onboarding"
import type { CustomerOnboardingState } from "@/lib/kernel/customer-onboarding"

interface Props {
  contactId: string
}

const STEPS = [
  { key: "welcome",          label: "Welcome",                  description: "Get oriented with your portal" },
  { key: "meet_your_agent",  label: "Meet your agent",          description: "See your agent's details and how to reach them" },
  { key: "tour_portal",      label: "Tour your portal",         description: "Live updates, properties, documents, education" },
  { key: "set_preferences",  label: "Set your preferences",     description: "Pick how and when you want to hear from us" },
  { key: "first_lesson",     label: "Start your first lesson",  description: "A short learning module tailored to where you are" },
] as const

function personaIntro(persona: string | null, view: string | null): string {
  // Buyer-side personas
  if (persona === "first_time_buyer")
    return "Welcome — buying your first home can feel like a lot, so we'll go at your pace. Here's everything ready for you."
  if (persona === "investor")
    return "Welcome. Your portal is tuned for deal speed — comps, DOM, returns, all in one place."
  if (persona === "downsizer")
    return "Welcome. We'll make this transition feel as smooth as possible — your portal walks you through every step."
  if (persona === "luxury_buyer")
    return "Welcome. Your portal gives you white-glove access to every detail of the search and transaction."
  if (persona === "bargain_hunter")
    return "Welcome. Your portal surfaces every angle on price, days-on-market, and negotiation room."
  if (persona === "relocation")
    return "Welcome. Your portal is structured around your move timeline and the new market."
  // Seller-side
  if (persona === "expired")    return "Welcome — fresh start. We'll show you exactly what we'll do differently this time."
  if (persona === "fsbo")       return "Welcome. Your portal makes the work of selling visible at every step."
  if (persona === "divorce")    return "Welcome. Your portal is built for clarity and speed during this transition."
  if (persona === "estate")     return "Welcome. We'll handle the details — your portal keeps everything organized."
  // Forever / post-close
  if (view === "forever")       return "Welcome back. Your forever-portal tracks your home value, refi opportunities, and life milestones."
  return "Welcome to your portal — everything about your real estate journey, in one place."
}

export function CustomerWelcomePanel({ contactId }: Props) {
  const [state, setState] = useState<CustomerOnboardingState | null>(null)
  const [isPending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await getCustomerOnboardingStateAction(contactId)
      if (cancelled) return
      if (!result.ok) {
        setLoading(false)
        return
      }
      if (!result.state.exists) {
        // Auto-start on first visit
        const started = await startCustomerOnboardingAction(contactId)
        if (cancelled) return
        if (started.ok) setState(started.state)
      } else {
        setState(result.state)
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [contactId])

  if (loading) return null
  if (!state) return null
  if (state.status === "completed") return null
  if (state.welcomeDismissedAt) return null

  function handleAdvance(stepKey: string): void {
    startTransition(async () => {
      const result = await advanceCustomerOnboardingStepAction(contactId, stepKey)
      if (result.ok) setState(result.state)
    })
  }

  function handleDismiss(): void {
    startTransition(async () => {
      await dismissCustomerWelcomeAction(contactId)
      setState(s => s ? { ...s, welcomeDismissedAt: new Date().toISOString() } : s)
    })
  }

  const intro = personaIntro(state.contactPersona, state.portalView)
  const completed = new Set(state.completedSteps)

  return (
    <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-purple-50">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base text-blue-900">
            <Sparkles className="h-4 w-4" />
            Getting started
            <Badge variant="outline" className="ml-auto text-xs bg-white">
              {state.completionPercentage}% done
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            disabled={isPending}
            className="h-7 w-7 p-0"
            aria-label="Dismiss welcome panel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-blue-900/90 leading-snug">{intro}</p>

        <div className="flex flex-col gap-2">
          {STEPS.map((s) => {
            const isDone = completed.has(s.key)
            const isCurrent = state.currentStep === s.key
            return (
              <div
                key={s.key}
                className={`flex items-start gap-3 rounded-md border bg-white px-3 py-2 ${
                  isCurrent ? "border-blue-400" : "border-blue-100"
                }`}
              >
                {isDone
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                  : <Circle className="h-4 w-4 text-blue-300 mt-0.5 flex-shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${isDone ? "text-muted-foreground line-through" : "text-blue-950"}`}>
                    {s.label}
                  </div>
                  <div className="text-xs text-blue-800/70">{s.description}</div>
                </div>
                {!isDone && (
                  <Button
                    size="sm"
                    variant={isCurrent ? "default" : "outline"}
                    disabled={isPending}
                    onClick={() => handleAdvance(s.key)}
                    className="h-7 text-xs flex-shrink-0"
                  >
                    {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Mark done"}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
