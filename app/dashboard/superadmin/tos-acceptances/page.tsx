import { listTosAcceptancesAction } from "@/app/actions/public/tos-acceptance"

export const dynamic = "force-dynamic"

// Platform-staff compliance/legal export — READER for platform_tos_acceptances
// (readerless-write-census: email/tos_version/ip_address/user_agent were
// written at signup and never read anywhere). No tenant column on this table
// (schema-snapshot.ts) — it is platform-wide consent proof, not brokerage
// data, so the gate is platform staff (listTosAcceptancesAction ->
// requirePlatformStaff), not a tenant role. Sibling of the re-acceptance
// gate banner (app/components/layout/tos-reacceptance-banner.tsx) — that
// checks ONE user's status; this is the full legal-proof export.
export default async function TosAcceptancesPage() {
  const result = await listTosAcceptancesAction()

  if (!result.ok) {
    return <div className="p-6 text-red-600">Forbidden: {result.error}</div>
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">ToS Acceptance Log</h1>
        <p className="text-sm text-muted-foreground">
          Legal proof-of-acceptance export — {result.rows.length} most recent record{result.rows.length !== 1 ? "s" : ""}.
        </p>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Version</th>
              <th className="px-3 py-2 font-medium">IP</th>
              <th className="px-3 py-2 font-medium">User agent</th>
              <th className="px-3 py-2 font-medium">Accepted at</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2">{row.email}</td>
                <td className="px-3 py-2">{row.tos_version}</td>
                <td className="px-3 py-2">{row.ip_address ?? "—"}</td>
                <td className="px-3 py-2 max-w-[280px] truncate" title={row.user_agent ?? ""}>{row.user_agent ?? "—"}</td>
                <td className="px-3 py-2">{new Date(row.accepted_at).toLocaleString()}</td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-muted-foreground" colSpan={5}>No acceptances recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
