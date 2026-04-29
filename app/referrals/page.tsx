import { redirect } from "next/navigation"

export default function ReferralsPage() {
  redirect("/past-clients?tab=referrals")
}
