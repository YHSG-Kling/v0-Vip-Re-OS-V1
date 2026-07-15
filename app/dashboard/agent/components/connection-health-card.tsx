"use client"

/**
 * CONNECTION HEALTH CARD — the tenant's own "what's connected, what broke,
 * what it costs you" view (the connectivity fabric, agent-facing). Renders
 * ONLY when something needs attention; a healthy fleet shows nothing.
 */

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PlugZap, AlertTriangle } from "lucide-react"
import Link from "next/link"
import { getMyConnectionHealth } from "@/app/actions/connection-health"
import type { ConnectionImpactRead } from "@/lib/agentic-os/connection-impact"

export function ConnectionHealthCard() {
  const [read, setRead] = useState<ConnectionImpactRead | null>(null)

  useEffect(() => {
    getMyConnectionHealth().then((r) => { if (r.success) setRead(r.read) }).catch(() => {})
  }, [])

  if (!read || !read.needsAttention) return null

  return (
    <Card className={read.broken.length > 0 ? "border-red-300 bg-red-50/60 dark:bg-red-950/20" : "border-amber-200 bg-amber-50/60 dark:bg-amber-950/20"}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          {read.broken.length > 0
            ? <AlertTriangle className="h-5 w-5 text-red-600" />
            : <PlugZap className="h-5 w-5 text-amber-600" />}
          <p className="text-sm font-semibold">
            {read.broken.length > 0 ? "A connection stopped working" : "A connection is about to expire"}
          </p>
        </div>
        <ul className="space-y-1.5">
          {read.broken.map((l) => <li key={l.provider} className="text-sm">{l.line}</li>)}
          {read.expiring.map((l) => <li key={l.provider} className="text-sm text-muted-foreground">{l.line}</li>)}
        </ul>
        <Button size="sm" asChild>
          <Link href="/settings/connections">Fix connections</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
