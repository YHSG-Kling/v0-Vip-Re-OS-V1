import { redirect } from "next/navigation"
import { getModuleForLearner } from "@/app/actions/academy-learning"
import { ModuleReaderClient } from "./module-reader-client"

export const dynamic = "force-dynamic"

export default async function AcademyModulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await getModuleForLearner(id)
  if (!result.ok) redirect("/academy")
  return <ModuleReaderClient module={result.module} />
}
