"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Sparkles } from "lucide-react"
import Link from "next/link"
import { getPersonaConfig } from "@/lib/portal"
import { cn } from "@/lib/utils"

interface PersonaQuickActionsProps {
  contactId: string
  persona: string
}

export default function PersonaQuickActions({ contactId, persona }: PersonaQuickActionsProps) {
  const config = getPersonaConfig(persona)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className={cn("w-5 h-5", config.color)} />
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {config.quickActions.map((action, idx) => {
            const ActionIcon = action.icon
            return (
              <Button
                key={idx}
                variant="outline"
                className={cn("h-auto py-4 flex flex-col items-center gap-2 hover:bg-accent", config.borderColor)}
                asChild
              >
                <Link href={action.href.replace("{contactId}", contactId)}>
                  <ActionIcon className={cn("w-6 h-6", config.color)} />
                  <span className="text-xs text-center">{action.label}</span>
                </Link>
              </Button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
