// app/components/onboarding/tenant-readiness-view.tsx — ONE presentation of the tenant readiness contract
// (lib/kernel/tenant-readiness.ts TenantReadinessReport) shared by the broker dashboard card and the
// superadmin tenant panel. Pure: receives the report, renders every check with its status, owner and reason.
// Tenant-facing copy: statuses in plain words, never a single opaque score.
import type { ReadinessCheck, TenantReadinessReport } from "@/lib/kernel/tenant-readiness"

const STATUS_LABEL: Record<ReadinessCheck["status"], string> = {
  PASS: "Ready", REPAIRABLE: "Repairable", WAITING_EXTERNAL: "Waiting on a provider", BLOCKED: "Needs a decision", NOT_APPLICABLE: "Not needed yet",
}
const STATUS_CLASS: Record<ReadinessCheck["status"], string> = {
  PASS: "bg-green-100 text-green-800", REPAIRABLE: "bg-indigo-100 text-indigo-800", WAITING_EXTERNAL: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-red-100 text-red-800", NOT_APPLICABLE: "bg-muted text-muted-foreground",
}
const KEY_LABEL: Record<ReadinessCheck["key"], string> = {
  tenantCore: "Workspace record", subscription: "Subscription", plan: "Plan", entitlements: "Included features", policies: "Operating policy",
  settings: "Operating defaults", snapshot: "Starting configuration", website: "Website", adminUser: "Admin seat", seats: "Seats",
  managers: "AI managers", communications: "Email & phone", billing: "Payment account", providerState: "Service lanes", requiredSecurityState: "Security posture",
}

export function TenantReadinessView({ report, staff = false }: { report: TenantReadinessReport; staff?: boolean }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {report.ready ? "Every required item is ready." : `${report.blockers.length} item(s) still need attention.`} Checked {new Date(report.checkedAt).toLocaleString()}.
      </p>
      <div className="space-y-1.5">
        {report.checks.map((c) => (
          <div key={c.key} className="flex items-start gap-2 text-sm">
            <span className={"mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold " + STATUS_CLASS[c.status]}>{STATUS_LABEL[c.status]}</span>
            <div className="min-w-0">
              <span className="font-medium">{KEY_LABEL[c.key]}</span>
              {staff && <span className="ml-2 text-[10px] text-muted-foreground">owner: {c.owner}</span>}
              <p className="text-xs text-muted-foreground">{c.reason}</p>
            </div>
          </div>
        ))}
      </div>
      {report.repairs && report.repairs.length > 0 && (
        <div className="rounded border p-2 text-xs">
          <p className="font-medium">Repairs this pass</p>
          {report.repairs.map((r) => (
            <p key={r.key} className="text-muted-foreground">{KEY_LABEL[r.key]} · {r.playbook} · {r.escalated ? "handed to a person" : r.ok ? "repaired" : "not repaired"} → {STATUS_LABEL[r.after]}</p>
          ))}
        </div>
      )}
    </div>
  )
}
