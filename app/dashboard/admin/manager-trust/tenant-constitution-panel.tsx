/**
 * The TENANT OPERATING CONSTITUTION, read-only, on the existing manager-trust governance page
 * (wave 101, lane 101A; m696). Server component: the derived read is
 * app/actions/admin/tenant-policy.ts getTenantOperatingConstitution (tenant admin, session tenant).
 * Each key links to its History (?policy=<key>), shown inline with a Revert per version — a
 * revert writes a NEW version through the key's own survivor writer. No value is edited here.
 */
import Link from "next/link"
import { revalidatePath } from "next/cache"
import { getTenantOperatingConstitution, policyHistory } from "@/app/actions/admin/tenant-policy"
import { getDirectMailExplorationPolicy, getTenantExperimentPolicy, setDirectMailExplorationFrozen, setExperimentKillSwitch } from "@/app/actions/flight-recorder"
import { RevertPolicyButton } from "./revert-policy-button"

/**
 * The two per-tenant KILL SWITCHES, toggled HERE beside their constitution rows (wave 102C, owner
 * answer 4): `experiments` (lib/kernel/experiments.ts) and `direct_mail_exploration` (the direct-mail
 * Thompson bandit, lib/direct-mail/variant-bandit.ts). Each write goes through its ONE server action
 * in app/actions/flight-recorder.ts → mergeBrokerageSettings → appendTenantPolicyVersion, so the row
 * it sits beside shows the new version and actor after the revalidate.
 */
async function KillSwitchToggle({ policyKey }: { policyKey: string }) {
  if (policyKey === "experiments") {
    const p = await getTenantExperimentPolicy()
    if (!p.ok) return <span className="text-xs text-red-700">{p.error}</span>
    if (!p.readable) return <span className="text-xs text-amber-700">policy unreadable — every experiment assigns control</span>
    return (
      <form action={async () => { "use server"; await setExperimentKillSwitch({ on: !p.killSwitch }); revalidatePath("/dashboard/admin/manager-trust") }}>
        <button type="submit" className="rounded border px-2 py-1 text-xs">{p.killSwitch ? "Resume experiments" : "Stop all experiments"}</button>
      </form>
    )
  }
  if (policyKey === "direct_mail_exploration") {
    const p = await getDirectMailExplorationPolicy()
    if (!p.ok) return <span className="text-xs text-red-700">{p.error}</span>
    if (!p.readable) return <span className="text-xs text-amber-700">policy unreadable — the bandit exploits only (fail closed)</span>
    return (
      <form action={async () => { "use server"; await setDirectMailExplorationFrozen({ frozen: !p.frozen }); revalidatePath("/dashboard/admin/manager-trust") }}>
        <button type="submit" className="rounded border px-2 py-1 text-xs">{p.frozen ? "Resume direct-mail exploration" : "Freeze direct-mail exploration"}</button>
      </form>
    )
  }
  return null
}

function preview(v: unknown): string {
  if (v === null || v === undefined) return "—"
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

export async function TenantConstitutionPanel({ historyKey }: { historyKey: string | null }) {
  const res = await getTenantOperatingConstitution()
  if (!res.ok) {
    return (
      <section id="tenant-constitution" className="mx-6 mb-8 rounded-lg border border-red-200 p-4 text-sm text-red-700">
        Operating constitution could not be loaded: {res.error}
      </section>
    )
  }
  const history = historyKey ? await policyHistory(historyKey) : null
  return (
    <section id="tenant-constitution" className="mx-6 mb-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Operating constitution</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Every operating policy this brokerage runs on, where it lives, and who last changed it. Read-only here —
        each policy is changed on its own settings screen; every change is kept as a version. The two kill
        switches (experiments, direct-mail exploration) toggle in place.
        {!res.versionsAvailable && " Version history is not available yet (pending migration m696) — values shown are live."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3">Policy</th>
              <th className="py-2 pr-3">Current value</th>
              <th className="py-2 pr-3">Version</th>
              <th className="py-2 pr-3">Last changed</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {res.entries.map((e) => (
              <tr key={e.policyKey} className="border-b align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{e.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">{e.policyKey}</div>
                </td>
                <td className="py-2 pr-3 font-mono text-xs break-all">
                  {e.isDefault ? <span className="text-muted-foreground">default — {e.defaultNote}</span> : preview(e.value)}
                </td>
                <td className="py-2 pr-3">{e.version === 0 ? <span className="text-muted-foreground">never changed</span> : `v${e.version}`}</td>
                <td className="py-2 pr-3 text-xs">
                  {e.changedAt ? `${new Date(e.changedAt).toLocaleString()} · ${e.changedByName ?? e.actorType ?? "—"}` : "—"}
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="text-xs underline" href={`?policy=${encodeURIComponent(e.policyKey)}#tenant-constitution`}>History</Link>
                    <KillSwitchToggle policyKey={e.policyKey} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {historyKey && history && (
        <div className="mt-4 rounded border p-3">
          <h3 className="mb-2 font-medium">History — <span className="font-mono text-sm">{historyKey}</span></h3>
          {!history.ok ? (
            <p className="text-sm text-red-700">{history.error}</p>
          ) : history.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {history.available ? "No versions yet — this policy has not been changed since history began." : "History is not available yet (pending migration m696)."}
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 border-b pb-2">
                  <div>
                    <div><strong>v{r.version}</strong> · {new Date(r.created_at).toLocaleString()} · {r.actor_type}{r.reason ? ` · ${r.reason}` : ""}</div>
                    <div className="font-mono text-xs break-all">value: {preview(r.value)}</div>
                    <div className="font-mono text-xs break-all text-muted-foreground">previous: {preview(r.previous)}</div>
                  </div>
                  {r.version !== history.rows[0].version && <RevertPolicyButton policyKey={historyKey} version={r.version} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
