import { getListingTaskTemplates } from "@/app/actions/settings/listing-task-templates"
import { ListingTaskTemplatesClient } from "./listing-task-templates-client"

export const metadata = { title: "Listing Task Templates | Settings" }

export default async function ListingTaskTemplatesPage() {
  let templates: Awaited<ReturnType<typeof getListingTaskTemplates>> = []

  try {
    templates = await getListingTaskTemplates()
  } catch {
    return (
      <div className="p-6 text-red-600 text-sm">
        Failed to load task templates. Please refresh the page.
      </div>
    )
  }

  return <ListingTaskTemplatesClient templates={templates} />
}
