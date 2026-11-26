"use server"

// app/actions/global-search.ts — the header box's record search (R6, wave 150, lane 150QTV).
//
// Every export of a "use server" file is a public HTTP endpoint (CLAUDE.md §4): this one takes ONLY the typed words. The tenant,
// the seat and the scope come from the SESSION (requireCaller → users row through the session client), never from the request.
// The search runs on that same session client so RLS stays underneath the scope (lib/search/scoped-record-search.ts).

import { requireCaller } from "@/lib/auth/require-caller"
import { searchScopedRecords, type ScopedRecordSearch } from "@/lib/search/scoped-record-search"

export async function searchWorkspaceRecords(query: string): Promise<ScopedRecordSearch> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, error: caller.reason === "unauthenticated" ? "Please sign in to search." : caller.error }
  return searchScopedRecords(caller.supabase, {
    userId: caller.userId, brokerageId: caller.brokerageId, userType: caller.userType, platformRole: caller.platformRole,
  }, typeof query === "string" ? query : "")
}
