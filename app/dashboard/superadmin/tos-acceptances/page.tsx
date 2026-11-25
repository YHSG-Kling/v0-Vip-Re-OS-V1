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
// Wave 156 (lane 156O round 3): the fingerprint columns answer a dispute — WHICH text this person accepted, compared with the
// text served now (listTosAcceptancesAction computes both server-side; this page renders, it never hashes).
const FINGERPRINT_LABEL: Record<string, string> = {
  match: "Yes — same text",
  different_text: "No — the text changed since (asked to accept again)",
  not_fingerprinted: "Accepted, text not fingerprinted (recorded before m1066)",
  earlier_version: "Earlier terms version",
  unreadable: "Unknown — the current terms could not be read",
  none: "—",
}

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
          {result.servedSha256 ? ` Text served now: sha256 ${result.servedSha256}.` : " The text served now could not be fingerprinted."}
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
              <th className="px-3 py-2 font-medium">Text fingerprint (sha256)</th>
              <th className="px-3 py-2 font-medium">Covers the text served now</th>
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
                <td className="px-3 py-2 font-mono text-xs" title={row.content_sha256 ?? ""}>{row.content_sha256 ? `${row.content_sha256.slice(0, 16)}…` : "—"}</td>
                <td className="px-3 py-2">{FINGERPRINT_LABEL[row.fingerprint]}</td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-muted-foreground" colSpan={7}>No acceptances recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
