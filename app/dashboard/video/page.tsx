import { redirect } from "next/navigation"

export default function VideoHubRedirect() {
  redirect("/dashboard/videos/library")
}
