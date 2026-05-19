"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  resolveTenantSafetyFindingAction,
  triggerTenantSafetyScanAction,
  type TenantSafetyFinding,
} from "@/app/actions/tenant-safety-actions"

interface Props {
  unresolved: TenantSafetyFinding[]
  resolved:   TenantSafetyFinding[]
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-500 text-white",
  high:     "bg-orange-500 text-white",
  medium:   "bg-amber-500 text-white",
  low:      "bg-gray-300 text-gray-800",
}

const FINDING_TYPE_LABEL: Record<string, string> = {
  rows_missing_brokerage_id:  "Rows missing brokerage_id",
  table_missing_brokerage_id: "Table missing brokerage_id column",
  table_missing_rls_policy:   "Table missing brokerage RLS policy",
  cross_tenant_join_risk:     "Cross-tenant join risk",
  listing_missing_agreement:  "Listing without listing agreement",
}

export function TenantSafetyClient({ unresolved, resolved }: Props) {
  const router = useRouter()
  const [scanning, setScanning] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState("")

  async function handleScan() {
    if (scanning) return
    setScanning(true)
    try {
      const r = await triggerTenantSafetyScanAction()
      if (r.success) {
        const inserted = (r.summary?.findings_inserted as number | undefined) ?? 0
        toast.success(inserted > 0 ? `Scan complete — ${inserted} new finding${inserted === 1 ? "" : "s"}` : "Scan complete — no new findings")
        router.refresh()
      } else {
        toast.error(r.error ?? "Scan failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed")
    } finally {
      setScanning(false)
    }
  }

  async function handleResolve(id: string) {
    setResolvingId(id)
    try {
      const r = await resolveTenantSafetyFindingAction({ findingId: id, resolutionNote: noteText.trim() || undefined })
      if (r.success) {
        toast.success("Finding marked resolved")
        setNoteFor(null)
        setNoteText("")
        router.refresh()
      } else {
        toast.error(r.error ?? "Could not resolve")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resolve")
    } finally {
      setResolvingId(null)
    }
  }

  const counts = {
    critical: unresolved.filter((f) => f.severity === "critical").length,
    high:     unresolved.filter((f) => f.severity === "high").length,
    medium:   unresolved.filter((f) => f.severity === "medium").length,
    low:      unresolved.filter((f) => f.severity === "low").length,
  }

  return (
    <div className="space-y-4">
      {/* Header strip */}
      <div className="rounded-lg border bg-card p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Open findings</p>
            <p className="text-2xl font-semibold">{unresolved.length}</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {counts.critical > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white font-medium">
                {counts.critical} critical
              </span>
            )}
            {counts.high > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-orange-500 text-white font-medium">
                {counts.high} high
              </span>
            )}
            {counts.medium > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500 text-white font-medium">
                {counts.medium} medium
              </span>
            )}
            {counts.low > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-gray-300 text-gray-800 font-medium">
                {counts.low} low
              </span>
            )}
            {unresolved.length === 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" /> All clear
              </span>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={scanning} onClick={handleScan} className="gap-1.5">
          {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Run scan now
        </Button>
      </div>

      {/* Open findings */}
      <div className="rounded-lg border bg-card">
        <div className="p-3 border-b">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4 text-orange-500" />
            Open findings
          </p>
        </div>
        {unresolved.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No open findings.</p>
        ) : (
          <ul className="divide-y">
            {unresolved.map((f) => (
              <li key={f.id} className="p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-[10px] uppercase px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap", SEVERITY_STYLE[f.severity])}>
                        {f.severity}
                      </span>
                      <span className="text-sm font-medium">{FINDING_TYPE_LABEL[f.findingType] ?? f.findingType}</span>
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">{f.tableName}</code>
                      {f.affectedRows != null && f.affectedRows > 0 && (
                        <span className="text-xs text-red-700">{f.affectedRows.toLocaleString()} row{f.affectedRows === 1 ? "" : "s"}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(f.createdAt).toLocaleString()} · scan {f.scanRunId.slice(0, 8)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {noteFor === f.id ? (
                      <>
                        <input
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="Resolution note (optional)"
                          className="h-7 text-xs border border-input rounded-md px-2 w-56"
                        />
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs"
                          disabled={resolvingId === f.id}
                          onClick={() => handleResolve(f.id)}
                        >
                          {resolvingId === f.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => { setNoteFor(null); setNoteText("") }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => { setNoteFor(f.id); setNoteText("") }}
                      >
                        Resolve
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent resolved */}
      {resolved.length > 0 && (
        <details className="rounded-lg border bg-card">
          <summary className="p-3 border-b cursor-pointer text-sm font-semibold flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Recently resolved · {resolved.length}
          </summary>
          <ul className="divide-y">
            {resolved.map((f) => (
              <li key={f.id} className="p-3 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn("text-[10px] uppercase px-1.5 py-0.5 rounded-full font-medium", SEVERITY_STYLE[f.severity])}>
                    {f.severity}
                  </span>
                  <span className="font-medium">{FINDING_TYPE_LABEL[f.findingType] ?? f.findingType}</span>
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">{f.tableName}</code>
                  <span className="text-muted-foreground">resolved {f.resolvedAt ? new Date(f.resolvedAt).toLocaleDateString() : ""}</span>
                </div>
                {f.resolutionNote && (
                  <p className="text-[11px] text-muted-foreground mt-1 italic">"{f.resolutionNote}"</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Footer info card */}
      <div className="rounded-lg border bg-muted/30 p-3 text-[11px] text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
          <span>
            The scan is read-only — it never modifies data. Critical findings should be triaged within 24 hours. After fixing the underlying issue (add a missing brokerage_id, attach an RLS policy, backfill rows), mark the finding resolved with a short note for the audit trail.
          </span>
        </p>
      </div>
    </div>
  )
}
