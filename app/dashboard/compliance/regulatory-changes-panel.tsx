import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Scale, ExternalLink, ArrowUpRight } from "lucide-react"

/**
 * Regulatory changes panel — the review UI over the already-built regulatory
 * watcher (lib/kernel/regulatory-watcher.ts → reg_change_observations). The
 * watcher runs weekly, matches external regulatory changes to the encoded
 * compliance gates, and escalates via the notifications + manager bus; this
 * surfaces those observations on the Compliance Command Center so a compliance
 * officer can see what changed, which gate it touches, and act. Read-only view
 * of a governed ledger — no new write path.
 */

export interface RegChangeRow {
  id: string
  title: string
  source: string | null
  url: string | null
  severityTier: string | null
  effectiveDate: string | null
  affectedSurfaces: string[]
  surfaceDetail: Array<{ id?: string; label?: string; file?: string }>
  escalatedAt: string | null
  observedAt: string | null
}

// The watcher's real severity tiers (reg_change_severity_chk): binding law/rule
// change, advisory guidance, or informational.
const SEVERITY_STYLE: Record<string, string> = {
  binding:       "bg-red-100 text-red-800",
  advisory:      "bg-amber-100 text-amber-900",
  informational: "bg-slate-100 text-slate-700",
}

function severityStyle(tier: string | null): string {
  return (tier && SEVERITY_STYLE[tier.toLowerCase()]) || "bg-slate-100 text-slate-700"
}

export function RegulatoryChangesPanel({ changes }: { changes: RegChangeRow[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Scale className="h-4 w-4 text-primary" />
          Regulatory changes
        </CardTitle>
        <CardDescription className="text-xs">
          The regulatory watcher scans TCPA / CAN-SPAM / Fair Housing / state protected-class / authority
          rules weekly and flags changes that touch an encoded compliance gate. Review each and update the
          named gate.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {changes.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No regulatory changes flagged in the current window. The watcher runs weekly and files what it finds here.
          </p>
        ) : (
          <div className="divide-y">
            {changes.map((c) => (
              <div key={c.id} className="px-4 py-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium hover:underline inline-flex items-center gap-1"
                      >
                        <span className="truncate">{c.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <p className="text-sm font-medium truncate">{c.title}</p>
                    )}
                    {c.source && <p className="text-xs text-muted-foreground truncate">{c.source}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.severityTier && (
                      <Badge className={`text-[10px] ${severityStyle(c.severityTier)}`}>{c.severityTier}</Badge>
                    )}
                    {c.escalatedAt && (
                      <span title="Escalated to the compliance owner" className="inline-flex items-center text-[10px] text-amber-700">
                        <ArrowUpRight className="h-3 w-3" /> escalated
                      </span>
                    )}
                  </div>
                </div>

                {/* Which encoded gate(s) this change touches — the reviewer's action list */}
                {c.surfaceDetail.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.surfaceDetail.map((s, i) => (
                      <Badge key={s.id ?? i} variant="outline" className="text-[10px]" title={s.file}>
                        {s.label ?? s.id}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  {c.effectiveDate && <span>Effective {new Date(c.effectiveDate).toLocaleDateString()}</span>}
                  {c.observedAt && <span>Observed {new Date(c.observedAt).toLocaleDateString()}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
