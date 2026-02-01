"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { getPersonaConfig } from "@/lib/portal/persona-config"
import { cn } from "@/lib/utils"

interface Contact {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string
  contact_persona?: string
  custom_fields?: Record<string, any>
}

interface PersonaWelcomeHeroProps {
  contact: Contact
  journeyProgress: number
  currentStageName?: string
}

export default function PersonaWelcomeHero({ contact, journeyProgress, currentStageName }: PersonaWelcomeHeroProps) {
  const persona = contact.contact_persona || "first_time_buyer"
  const config = getPersonaConfig(persona)
  const PersonaIcon = config.icon

  const displayName = contact.first_name || contact.email?.split("@")[0] || "there"

  return (
    <Card className={cn(config.bgColor, "border-none shadow-lg")}>
      <CardContent className="p-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          {/* Left side - Welcome message */}
          <div className="flex items-start gap-4">
            <div className={cn("p-4 rounded-2xl bg-white shadow-md", config.color)}>
              <PersonaIcon className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Welcome back, {displayName}!</h1>
              <p className="text-slate-600 mt-1">{config.greeting}</p>
              <Badge variant="secondary" className="mt-2">
                {config.title}
              </Badge>
            </div>
          </div>

          {/* Right side - Progress */}
          <div className="text-left md:text-right bg-white/60 rounded-xl p-4 min-w-[200px]">
            <p className="text-sm text-slate-500">Journey Progress</p>
            <p className="text-3xl font-bold text-slate-900">{journeyProgress}%</p>
            <Progress value={journeyProgress} className="w-full mt-2" />
            {currentStageName && <p className="text-xs text-slate-500 mt-1">Current: {currentStageName}</p>}
          </div>
        </div>

        {/* Supportive message for sensitive personas */}
        {config.supportMessage && (
          <div className="mt-4 p-4 bg-white/80 rounded-xl border border-white">
            <p className="text-sm text-slate-700 italic">{config.supportMessage}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
