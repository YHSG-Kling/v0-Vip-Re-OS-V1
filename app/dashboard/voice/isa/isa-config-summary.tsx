"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Settings,
  Mic,
  Zap,
  ExternalLink
} from "lucide-react"

interface VoiceConfig {
  id: string
  agent_id: string
  brokerage_id: string
  wake_word: string | null
  auto_briefing: boolean | null
  preferred_commands: Record<string, unknown> | null
  voice_profile_id: string | null
}

interface ISAConfigSummaryProps {
  config: VoiceConfig | null
  agentId: string
}

export function ISAConfigSummary({ config, agentId }: ISAConfigSummaryProps) {
  const commands = config?.preferred_commands 
    ? Object.keys(config.preferred_commands).slice(0, 3)
    : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4" />
            AI-ISA Configuration
          </CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings?tab=ai-isa">
              Edit Configuration
              <ExternalLink className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!config ? (
          <div className="text-sm text-muted-foreground">
            No AI-ISA voice configuration set up yet.{" "}
            <Link href="/settings?tab=ai-isa" className="text-primary hover:underline">
              Configure now
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Mic className="h-3.5 w-3.5" />
                Wake Word
              </div>
              <p className="font-medium">{config.wake_word || "Not set"}</p>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Zap className="h-3.5 w-3.5" />
                Auto Briefing
              </div>
              <Badge variant={config.auto_briefing ? "default" : "secondary"}>
                {config.auto_briefing ? "Enabled" : "Disabled"}
              </Badge>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                Preferred Commands
              </div>
              <div className="flex flex-wrap gap-1">
                {commands.length > 0 ? (
                  commands.map((cmd) => (
                    <Badge key={cmd} variant="outline" className="text-xs">
                      {cmd}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">None configured</span>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
