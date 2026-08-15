"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShieldCheck, ShieldAlert, AlertTriangle, ExternalLink, Loader2 } from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface Props {
  agentId: string
}

interface ComplianceRow {
  label: string
  expiry: string | null
  reference?: string | null
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const ms = new Date(dateStr).getTime() - Date.now()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function rowVariant(days: number | null): {
  variant: "ok" | "warn" | "alert" | "missing"
  className: string
  label: string
} {
  if (days == null) return { variant: "missing", className: "text-muted-foreground", label: "Not on file" }
  if (days < 0) return { variant: "alert", className: "text-red-700", label: `Expired ${Math.abs(days)}d ago` }
  if (days <= 30) return { variant: "alert", className: "text-red-700", label: `Expires in ${days}d` }
  if (days <= 90) return { variant: "warn", className: "text-amber-700", label: `Expires in ${days}d` }
  return { variant: "ok", className: "text-emerald-700", label: `${days}d until renewal` }
}

export function LicenseComplianceWidget({ agentId }: Props) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ComplianceRow[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        // Prefer agent_licenses (richer schema). Fall back to agents row.
        const { data: licenses } = await supabase
          .from("agent_licenses")
          .select("license_type, license_state, license_number, expiration_date, eo_carrier:eo_insurance_carrier, eo_expiration_date")
          .eq("agent_id", agentId)
          .order("expiration_date", { ascending: true })
          .limit(5)

        const collected: ComplianceRow[] = []
        if (licenses && licenses.length > 0) {
          for (const l of licenses) {
            collected.push({
              label: `${(l.license_type ?? "License").toString()} (${l.license_state ?? "—"})`,
              expiry: (l.expiration_date as string | null) ?? null,
              reference: l.license_number,
            })
            if (l.eo_expiration_date) {
              collected.push({
                label: `E&O Insurance${l.eo_carrier ? ` — ${l.eo_carrier}` : ""}`,
                expiry: l.eo_expiration_date as string,
              })
            }
          }
        } else {
          // Fallback to agents.license_expiry
          const { data: agentRow } = await supabase
            .from("agents")
            .select("license_state, license_number, license_expiry")
            .eq("id", agentId)
            .maybeSingle()
          if (agentRow) {
            collected.push({
              label: `License (${agentRow.license_state ?? "—"})`,
              expiry: (agentRow.license_expiry as string | null) ?? null,
              reference: agentRow.license_number,
            })
          }
        }

        // Ethics training: no schema yet — show as a placeholder so the agent
        // sees what's missing and can ask their broker to track it.
        collected.push({
          label: "NAR Ethics Training (3-year cycle)",
          expiry: null,
        })

        if (!cancelled) setRows(collected)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId])

  const anyAlert = rows.some((r) => {
    const d = daysUntil(r.expiry)
    return d != null && d <= 30
  })
  const anyWarn = rows.some((r) => {
    const d = daysUntil(r.expiry)
    return d != null && d > 30 && d <= 90
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            {anyAlert ? (
              <ShieldAlert className="h-4 w-4 text-red-600" />
            ) : anyWarn ? (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            )}
            License &amp; Compliance
          </span>
          <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-xs">
            <Link href="/dashboard/onboarding/license">
              Manage
              <ExternalLink className="h-3 w-3" />
            </Link>
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No license records on file.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r, i) => {
              const days = daysUntil(r.expiry)
              const variant = rowVariant(days)
              return (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{r.label}</p>
                    {r.reference && (
                      <p className="text-xs text-muted-foreground truncate">#{r.reference}</p>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-xs whitespace-nowrap ${variant.className}`}
                  >
                    {variant.label}
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
