import { Suspense } from "react"
import { getServicesRegistry, getAIAgentTemplates, getPlaybooks, getStageRules } from "@/app/actions/services-config"
import ServicesSettingsContent from "./services-content"
import { Skeleton } from "@/components/ui/skeleton"

export default async function ServicesSettingsPage() {
  const [servicesData, agentsData, playbooksData, rulesData] = await Promise.all([
    getServicesRegistry(),
    getAIAgentTemplates(),
    getPlaybooks(),
    getStageRules(),
  ])

  return (
    <div className="container mx-auto py-8 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Services & AI Configuration</h1>
        <p className="text-muted-foreground">Manage integrations, AI agents, and automation workflows</p>
      </div>

      <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
        <ServicesSettingsContent
          services={servicesData.services}
          agents={agentsData.agents}
          playbooks={playbooksData.playbooks}
          rules={rulesData.rules}
        />
      </Suspense>
    </div>
  )
}
