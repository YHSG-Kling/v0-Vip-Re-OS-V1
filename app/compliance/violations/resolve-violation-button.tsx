"use client"

// MOUNTED (§1 orphan doctrine — scripts/handler-parity-census.ts, 2026-09-11):
// app/api/compliance/flags/route.ts's PATCH handler (status/resolution_notes,
// brokerage-scoped, broker/broker_owner/admin/compliance_officer gated) had
// zero in-tree callers — the violations list rendered every flag read-only.
// This is the missing CALLER, not a second writer: it targets the SAME
// existing endpoint rather than adding a new one.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CheckCircle2 } from "lucide-react"

export function ResolveViolationButton({ flagId }: { flagId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleResolve() {
    setLoading(true)
    try {
      const res = await fetch("/api/compliance/flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagId, status: "resolved" }),
      })
      if (res.ok) router.refresh()
    } catch {
      // best-effort UI action — a failed resolve just leaves the flag open,
      // which is the fail-closed outcome (CLAUDE.md §4)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleResolve} disabled={loading}>
      <CheckCircle2 className="w-4 h-4 mr-1" />
      {loading ? "Resolving…" : "Resolve"}
    </Button>
  )
}
