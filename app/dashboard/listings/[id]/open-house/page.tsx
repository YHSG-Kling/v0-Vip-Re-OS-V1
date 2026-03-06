import { notFound } from "next/navigation"
import { getOpenHouseDashboard } from "@/app/actions/seller-open-house"
import { OpenHouseClient } from "./open-house-client"

interface Props {
  params: Promise<{ id: string }>
}

export default async function OpenHousePage({ params }: Props) {
  const { id } = await params
  const data = await getOpenHouseDashboard(id)
  if (!data || !data.listing) notFound()

  return <OpenHouseClient listingId={id} initialData={data} />
}
