import { redirect } from "next/navigation"

export const metadata = {
  title: "Referrals | Kernel OS",
}

export default function ReferralsPage() {
  redirect("/past-clients?tab=radar")
}
