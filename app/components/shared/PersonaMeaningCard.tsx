"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

interface PersonaGuidelines {
  greetingStyle: string
  emphasisOn: string[]
  avoidMentioning: string[]
  examplePhrases: string[]
}

interface PersonaMeaningCardProps {
  stage: string
  persona: string | null
  stageHeadline: string
  stageWhatMeans: string
  stageWhatNext: string
  stageResponsible: string
  personaGuidelines: PersonaGuidelines | null
}

function getPersonaFraming(persona: string | null, guidelines: PersonaGuidelines | null): string | null {
  if (!persona) return null

  // Derive framing from personaGuidelines if available
  if (guidelines?.greetingStyle && guidelines?.emphasisOn?.[0]) {
    const emphasis = guidelines.emphasisOn[0].toLowerCase()
    
    if (persona === "first_time_buyer" || emphasis.includes("education") || emphasis.includes("guidance")) {
      return "We'll walk you through each step so you know exactly what to expect."
    }
    if (persona === "luxury_buyer" || emphasis.includes("exclusive") || emphasis.includes("premium")) {
      return "Your dedicated team is coordinating every detail for a seamless experience."
    }
    if (persona === "investor" || emphasis.includes("efficiency") || emphasis.includes("roi")) {
      return "Timeline and efficiency are prioritized to maximize your opportunity window."
    }
    if (persona === "relocation" || emphasis.includes("speed") || emphasis.includes("remote")) {
      return "We're moving quickly and keeping you informed at every turn, wherever you are."
    }
  }

  // Fallback based on persona type alone
  switch (persona) {
    case "first_time_buyer":
      return "We'll walk you through each step so you know exactly what to expect."
    case "luxury_buyer":
      return "Your dedicated team is coordinating every detail for a seamless experience."
    case "investor":
      return "Timeline and efficiency are prioritized to maximize your opportunity window."
    case "relocation":
      return "We're moving quickly and keeping you informed at every turn, wherever you are."
    default:
      return null
  }
}

export function PersonaMeaningCard({
  stage,
  persona,
  stageHeadline,
  stageWhatMeans,
  stageWhatNext,
  stageResponsible,
  personaGuidelines,
}: PersonaMeaningCardProps) {
  const personaFraming = getPersonaFraming(persona, personaGuidelines)
  const supportiveNote = personaGuidelines?.examplePhrases?.[0]

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            What This Means
          </span>
        </div>
        <CardTitle className="text-lg">{stageHeadline}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {stageWhatMeans}
          </p>
          {personaFraming && (
            <p className="text-sm text-foreground/80 leading-relaxed">
              {personaFraming}
            </p>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              What Happens Next
            </p>
            <p className="text-sm leading-relaxed">{stageWhatNext}</p>
          </div>

          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Who's Handling This
            </p>
            <Badge variant="secondary" className="text-xs">
              {stageResponsible}
            </Badge>
          </div>
        </div>

        {supportiveNote && (
          <>
            <Separator />
            <p className="text-xs text-muted-foreground italic leading-relaxed">
              {supportiveNote}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
