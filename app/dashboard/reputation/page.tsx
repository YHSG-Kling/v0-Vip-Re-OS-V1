import { redirect } from "next/navigation"

export const metadata = {
  title: "Reputation Manager | Kernel OS",
}

export default function ReputationPage() {
  redirect("/lifetime-customers?tab=reviews")
}
