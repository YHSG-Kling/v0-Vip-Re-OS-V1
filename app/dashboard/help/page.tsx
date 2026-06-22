import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { searchHelp, listMyTickets } from "@/app/actions/support"
import { HelpCenterClient } from "./help-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Help & Support | Dashboard",
  description: "Browse help articles and raise support tickets",
}

export default async function DashboardHelpPage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  const supabase = await createClient()
  const [{ data: brokerage }, articles, tickets] = await Promise.all([
    supabase.from("brokerages").select("name, email, phone").eq("id", ctx.brokerageId ?? "").maybeSingle(),
    searchHelp(),
    listMyTickets(),
  ])

  return (
    <HelpCenterClient
      brokerageName={brokerage?.name ?? null}
      supportEmail={(brokerage?.email as string | null) ?? null}
      supportPhone={(brokerage?.phone as string | null) ?? null}
      initialArticles={articles}
      initialTickets={tickets}
    />
  )
}
