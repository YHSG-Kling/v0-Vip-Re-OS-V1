import { DSARForm } from "./dsar-form"

export const dynamic = "force-dynamic"
export const metadata = { title: "Privacy request — VIP RE OS" }

export default function DSARSubmissionPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto p-6 py-12">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold">Privacy request</h1>
          <p className="text-muted-foreground text-sm mt-3">
            Under CCPA (California), CPRA, and GDPR (EU/UK), you have the right to know what
            personal information we hold, request a copy of it, ask for corrections, or have
            it deleted. We respond within 45 days.
          </p>
        </div>
        <DSARForm />
      </div>
    </div>
  )
}
