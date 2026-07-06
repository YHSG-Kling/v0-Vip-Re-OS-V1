import { GetStartedForm } from "./get-started-form"

export const dynamic = "force-dynamic"
export const metadata = { title: "See the AI team — VIP Agents" }

// Public marketing front door: the platform markets ITSELF (the AI OS transforming
// real estate). Hand-raises feed the platform growth funnel.
export default function GetStartedPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-2xl mx-auto px-6 py-14">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">The AI team that runs the whole business</h1>
          <p className="text-muted-foreground mt-3">
            Not another dashboard — an accountable AI team of managers that scrape leads, coordinate deals,
            market (video + social + ads), recruit and retain agents, manage vendors, and report — from one
            command center, with a voice admin that takes a command and does it. Lead → deal → lifetime client.
          </p>
        </div>
        <GetStartedForm />
      </div>
    </div>
  )
}
