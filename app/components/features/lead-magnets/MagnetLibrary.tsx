"use client"

import { useEffect, useState, useTransition } from "react"
import { listLeadMagnetsAction, updateMagnetSettingsAction } from "@/app/actions/lead-magnets-actions"
import type { ListLeadMagnetsOutput } from "@/lib/kernel/lead-magnets"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
// TOMBSTONE (orphan doctrine §1.3): `CardHeader` and `CardTitle` were imported here
// and rendered NOWHERE — this library lays each magnet out as a bare
// <Card><CardContent> (MagnetLibrary.tsx:103/:111/:115/:165), with the heading text
// carried inline. The SURVIVORS of the header vocabulary are the CardHeader/CardTitle
// exports of components/ui/card.tsx themselves, used by the surfaces that render a
// titled card; nothing was moved out of this file and nothing was lost.
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { FileText, QrCode, BarChart2, Link2, Users } from "lucide-react"

interface Props {
  /** Kept for the reload key only — the ACTUAL scope is resolved server-side. */
  brokerageId: string
  /**
   * "mine" forces the own-magnets list even for a broker/admin. Omit to let
   * listLeadMagnetsAction decide from the session role (broker/admin/superadmin
   * → brokerage-wide, everyone else → their own). Never pass an agent id from
   * the client: agent_id is a FK to agents(id) and the client only has the auth
   * user id, which is what silently emptied this list before.
   */
  scope?: "mine" | "brokerage"
  onSelectMagnet?: (magnetId: string) => void
  onCreateNew?: () => void
}

type Magnet = NonNullable<ListLeadMagnetsOutput["magnets"]>[number]

const TYPE_LABELS: Record<string, string> = {
  home_valuation: "Home Valuation",
  buyer_guide: "Buyer Guide",
  seller_guide: "Seller Guide",
  market_report: "Market Report",
  listing_alert: "Listing Alert",
  open_house: "Open House",
  generic_form: "Generic Form",
}

export function MagnetLibrary({ brokerageId, scope, onSelectMagnet, onCreateNew }: Props) {
  const [magnets, setMagnets] = useState<Magnet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    load()
  }, [brokerageId, scope])

  async function load() {
    setLoading(true)
    setError(null)
    const result = await listLeadMagnetsAction({ scope })
    if (result.success) {
      setMagnets(result.magnets ?? [])
    } else {
      setError(result.error ?? "Failed to load lead magnets")
    }
    setLoading(false)
  }

  function handleToggleActive(magnet: Magnet) {
    startTransition(async () => {
      const result = await updateMagnetSettingsAction(magnet.id, { isActive: !magnet.isActive })
      if (result.success) {
        setMagnets((prev) =>
          prev.map((m) => (m.id === magnet.id ? { ...m, isActive: !m.isActive } : m))
        )
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
        Loading lead magnets...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={load}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {magnets.length} lead magnet{magnets.length !== 1 ? "s" : ""}
        </p>
        {onCreateNew && (
          <Button size="sm" onClick={onCreateNew}>
            New Lead Magnet
          </Button>
        )}
      </div>

      {magnets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16">
            <FileText className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No lead magnets yet.</p>
            {onCreateNew && (
              <Button size="sm" onClick={onCreateNew}>Create your first</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {magnets.map((magnet) => (
            <Card
              key={magnet.id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => onSelectMagnet?.(magnet.id)}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium truncate">{magnet.name}</p>
                    <Badge variant={magnet.isActive ? "default" : "secondary"} className="text-xs">
                      {magnet.isActive ? "Active" : "Inactive"}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {TYPE_LABELS[magnet.magnetType] ?? magnet.magnetType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {magnet.submissionCount} submissions
                    </span>
                    {magnet.qrCodeId && (
                      <span className="flex items-center gap-1">
                        <QrCode className="h-3 w-3" />
                        {magnet.scanCount} scans
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Link2 className="h-3 w-3" />
                      /lm/{magnet.slug}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={magnet.isActive}
                    onCheckedChange={() => handleToggleActive(magnet)}
                    disabled={isPending}
                    aria-label={`Toggle ${magnet.name}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onSelectMagnet?.(magnet.id) }}
                  >
                    <BarChart2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
