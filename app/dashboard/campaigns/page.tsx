import { redirect } from "next/navigation"

export default function CampaignsHubRedirect() {
  redirect("/dashboard/marketing/studio?tab=campaigns")
}
