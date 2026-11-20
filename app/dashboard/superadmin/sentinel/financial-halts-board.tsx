/**
 * FINANCIAL-WRITER HALTS — the platform view (wave 137, owner "approve all": platform staff may release a
 * financial halt WITH EVIDENCE). Server component: the read is app/actions/superadmin/financial-halts.ts
 * listHaltedFinancialWritersAction (platform 'billing' capability); each row's release form submits
 * releaseFinancialWriterHaltAsPlatformAction (billing WRITE + evidence, through the one release writer).
 * The tenant's own finance admins keep their door on the brokerage command center (BrokerSelfHealPanel).
 */
import { listHaltedFinancialWritersAction } from "@/app/actions/superadmin/financial-halts"
import { FinancialHaltRelease } from "./financial-halt-release"

export async function FinancialHaltsBoard() {
  const res = await listHaltedFinancialWritersAction()
  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Halted financial writers</h2>
        <p className="text-xs text-muted-foreground">
          Money writers the OS health supervisor halted on a financial discrepancy. A release needs a reason and
          evidence of what reconciled it; it is a versioned policy change attributed to you.
        </p>
      </div>
      {!res.ok ? (
        <p className="text-sm text-red-700">Halts could not be read: {res.error}</p>
      ) : res.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No financial writer is halted on any tenant.</p>
      ) : (
        <ul className="space-y-2">
          {res.rows.map((h) => (
            <li key={`${h.brokerageId}:${h.writer}`} className="rounded border p-2 text-sm">
              <div className="font-medium">{h.brokerageName ?? h.brokerageId} — {h.label}</div>
              <div className="text-xs text-muted-foreground">
                {h.reason ?? "no reason recorded"}{h.setAt ? ` · halted ${new Date(h.setAt).toLocaleString()}` : ""}{h.incident ? ` · incident ${h.incident}` : ""}
              </div>
              <FinancialHaltRelease brokerageId={h.brokerageId} writer={h.writer} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
