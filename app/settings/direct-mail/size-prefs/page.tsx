import { getSizePrefsMatrix, type ScopeType } from "@/app/actions/direct-mail-size-prefs"
import { SizePrefsMatrixClient } from "./client"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ scope?: string; team?: string }>
}

export default async function SizePrefsPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const scopeType: ScopeType =
    sp.scope === "team" ? "team"
    : sp.scope === "brokerage" ? "brokerage"
    : "agent"

  const result = await getSizePrefsMatrix({ scopeType, teamId: sp.team })
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Direct Mail Size Preferences</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }

  return (
    <SizePrefsMatrixClient
      initialCells={result.cells}
      initialOverrides={result.overrides}
      activeScope={scopeType}
      activeTeamId={sp.team ?? null}
      scopeOptions={result.scopeOptions}
    />
  )
}
