import Link from "next/link"
import { ShieldAlert, ShieldCheck, ChevronRight } from "lucide-react"
import { createClient } from "@/lib/supabase/server"

/**
 * TenantSafetyWidget — server component, renders on the admin landing.
 *
 * Tiny status card: number of open findings, broken down by severity, with
 * a click-through to /dashboard/admin/tenant-safety for the full triage UI.
 * Hidden when zero findings AND no recent scan (i.e. the cron hasn't run
 * yet).
 */
export async function TenantSafetyWidget() {
  const supabase = await createClient()

  // Latest unresolved findings + a quick severity rollup. RLS gates the
  // table to admin user_types only, so unauthorized callers naturally
  // get an empty set and the widget hides itself.
  const { data: rows } = await supabase
    .from("tenant_safety_findings")
    .select("severity")
    .eq("resolved", false)

  if (!rows) return null

  const counts = {
    critical: rows.filter((r) => (r as { severity?: string }).severity === "critical").length,
    high:     rows.filter((r) => (r as { severity?: string }).severity === "high").length,
    medium:   rows.filter((r) => (r as { severity?: string }).severity === "medium").length,
    low:      rows.filter((r) => (r as { severity?: string }).severity === "low").length,
  }
  const total = rows.length

  return (
    <Link
      href="/dashboard/admin/tenant-safety"
      className={
        "block rounded-lg border bg-card p-4 hover:bg-muted/40 transition " +
        (counts.critical > 0
          ? "border-red-300"
          : counts.high > 0
          ? "border-orange-300"
          : "border-input")
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {total === 0 ? (
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
          ) : (
            <ShieldAlert className={"h-5 w-5 " + (counts.critical > 0 ? "text-red-600" : "text-orange-500")} />
          )}
          <div>
            <p className="text-sm font-semibold">Tenant Safety</p>
            <p className="text-xs text-muted-foreground">
              {total === 0
                ? "All clear — no open findings."
                : `${total} open finding${total === 1 ? "" : "s"} from the daily scan.`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {counts.critical > 0 && (
            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded-full bg-red-500 text-white font-medium">
              {counts.critical} critical
            </span>
          )}
          {counts.high > 0 && (
            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded-full bg-orange-500 text-white font-medium">
              {counts.high} high
            </span>
          )}
          {counts.medium > 0 && (
            <span className="text-[10px] uppercase px-1.5 py-0.5 rounded-full bg-amber-500 text-white font-medium">
              {counts.medium} medium
            </span>
          )}
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Link>
  )
}
