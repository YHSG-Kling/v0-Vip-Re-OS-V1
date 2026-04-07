import { Suspense } from "react"
import { AddressSearchForm } from "@/app/components/home-value/AddressSearchForm"
import { getAgentBySlug, getPageConfigByAgentId, type HomeValuePageConfig } from "@/app/actions/home-value"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Home, Shield, TrendingUp, Clock } from "lucide-react"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: Promise<{ agent?: string; brokerage?: string; utm_source?: string }>
}

export async function generateMetadata({ searchParams }: PageProps) {
  const params = await searchParams
  if (params.agent) {
    const agent = await getAgentBySlug(params.agent)
    if (agent) {
      return {
        title: `What's Your Home Worth? | ${agent.first_name} ${agent.last_name}`,
        description: `Get a free AI-powered home value estimate from ${agent.first_name} ${agent.last_name} in minutes.`,
      }
    }
  }
  return {
    title: "What's Your Home Worth? | Free Home Value Estimate",
    description: "Get an AI-powered estimate of your home's value in minutes. Free, no obligation.",
  }
}

export default async function HomeValuePage({ searchParams }: PageProps) {
  const params = await searchParams
  const agentSlug = params.agent
  const brokerageId = params.brokerage
  const utmSource = params.utm_source

  // Personalization + config if agent slug provided
  let agent: Awaited<ReturnType<typeof getAgentBySlug>> = null
  let pageConfig: HomeValuePageConfig | null = null

  if (agentSlug) {
    agent = await getAgentBySlug(agentSlug)
    if (agent?.id) {
      pageConfig = await getPageConfigByAgentId(agent.id)
    }
  }

  const headline = pageConfig?.headline ?? "What's Your Home Worth?"
  const subheadline = pageConfig?.subheadline ?? "Get an AI-powered estimate in minutes — free, no obligation"
  const accentColor = pageConfig?.primaryColor ?? undefined

  // Build activeQuestions map from config (all true by default when no config)
  const activeQuestions = {
    sellTimeline: pageConfig?.showQSellTimeline ?? true,
    motivation: pageConfig?.showQMotivation ?? true,
    mortgageStatus: pageConfig?.showQMortgageStatus ?? true,
    priceExpectation: pageConfig?.showQPriceExpectation ?? true,
    hasAgent: pageConfig?.showQHasAgent ?? true,
    buyAfterSell: pageConfig?.showQBuyAfterSell ?? true,
    additionalNotes: pageConfig?.showQAdditionalNotes ?? true,
  }

  const questionLabels = {
    sellTimeline: pageConfig?.labelSellTimeline ?? null,
    motivation: pageConfig?.labelMotivation ?? null,
    mortgageStatus: pageConfig?.labelMortgageStatus ?? null,
    priceExpectation: pageConfig?.labelPriceExpectation ?? null,
    hasAgent: pageConfig?.labelHasAgent ?? null,
    buyAfterSell: pageConfig?.labelBuyAfterSell ?? null,
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Hero Section */}
      <section
        className="relative py-16 px-4"
        style={
          accentColor
            ? { background: `linear-gradient(135deg, ${accentColor}14 0%, transparent 100%)` }
            : undefined
        }
      >
        <div className="mx-auto max-w-4xl text-center">
          {agent && (
            <div className="mb-6 flex items-center justify-center gap-3">
              {agent.profile_image_url && (
                <img
                  src={agent.profile_image_url}
                  alt={`${agent.first_name} ${agent.last_name}`}
                  className="h-12 w-12 rounded-full object-cover border-2 border-primary"
                />
              )}
              <p className="text-muted-foreground">
                {pageConfig?.agentBioOverride ? (
                  pageConfig.agentBioOverride
                ) : (
                  <>
                    Your estimate powered by{" "}
                    <span className="font-medium text-foreground">
                      {agent.first_name} {agent.last_name}
                    </span>
                  </>
                )}
              </p>
            </div>
          )}

          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl text-balance">
            {headline}
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto text-pretty">
            {subheadline}
          </p>
        </div>
      </section>

      {/* Form Section */}
      <section className="py-12 px-4">
        <div className="mx-auto max-w-2xl">
          <Suspense fallback={<FormSkeleton />}>
            <AddressSearchForm
              agentSlug={agentSlug}
              brokerageId={brokerageId ?? agent?.brokerage_id ?? undefined}
              utmSource={utmSource}
              activeQuestions={activeQuestions}
              questionLabels={questionLabels}
              ctaButtonText={pageConfig?.ctaButtonText}
              accentColor={accentColor}
            />
          </Suspense>
        </div>
      </section>

      {/* Trust Indicators */}
      <section className="py-12 px-4 bg-muted/30">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <TrustCard
              icon={<Home className="h-8 w-8 text-primary" />}
              title="AI-Powered"
              description="Advanced algorithms analyze market data"
            />
            <TrustCard
              icon={<Clock className="h-8 w-8 text-primary" />}
              title="Instant Results"
              description="Get your estimate in under 2 minutes"
            />
            <TrustCard
              icon={<TrendingUp className="h-8 w-8 text-primary" />}
              title="Market Insights"
              description="Includes comparable sales and trends"
            />
            <TrustCard
              icon={<Shield className="h-8 w-8 text-primary" />}
              title="Private & Secure"
              description="We never sell your information"
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-4 text-center text-sm text-muted-foreground">
        <p>
          This estimate is generated by AI and should be used for informational purposes only.
          For a more accurate assessment, contact a local real estate professional.
        </p>
      </footer>
    </main>
  )
}

function TrustCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <Card className="p-6 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <h3 className="font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1">{description}</p>
    </Card>
  )
}

function FormSkeleton() {
  return (
    <Card className="p-6">
      <div className="flex justify-center mb-5">
        <Skeleton className="h-9 w-64" />
      </div>
      <Skeleton className="h-6 w-48 mx-auto mb-1" />
      <Skeleton className="h-4 w-56 mx-auto mb-6" />
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </Card>
  )
}
