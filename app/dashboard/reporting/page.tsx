import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ReportingClient } from "./reporting-client"

export const metadata = {
  title: "Reporting Command Center | Kernel OS",
  description:
    "Lead funnel, AI-ISA performance, listing and transaction health, marketing ROI, and cross-domain stuck work.",
}

export default async function ReportingPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  return <ReportingClient />
}
