import { SignupForm } from "./signup-form"

export const dynamic = "force-dynamic"
export const metadata = { title: "Start your free trial — VIP RE OS" }

export default function SignupPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Start your 14-day free trial
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
            No credit card required. Pick the plan that fits your shape — you can change it any time.
            AI features, marketing automation, and the kernel-driven workflow OS are all included.
          </p>
        </div>
        <SignupForm />
      </div>
    </div>
  )
}
