import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getTerritorySettings } from "@/app/actions/settings/territories"
import { TerritoriesClient } from "./territories-client"

/**
 * Settings → Territories.
 *
 * The tenant, the grain gate and the writable-grain list all come from
 * getTerritorySettings(), which resolves them from the SESSION. This page passes
 * NO tenancy down and takes none from the URL — the only thing it does before
 * handing over is confirm there is a session at all, so an anonymous visitor gets
 * a login redirect rather than an empty page with an error in it.
 */
export const dynamic = "force-dynamic"
export const metadata = { title: "Territories" }

export default async function TerritoriesSettingsPage() {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) redirect("/login")

  const view = await getTerritorySettings()

  return <TerritoriesClient view={view} />
}
