import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"
import { siteUrl } from "@/lib/platform/site-url"

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ success: false, error: "Email is required" }, { status: 400 })
    }

    const supabase = await createServerClient()

    // Send password reset email. THE ONE PUBLIC-ORIGIN RESOLVER (wave 148, lane 148A): this fell back to
    // "http://localhost:3000" when NEXT_PUBLIC_APP_URL was unset, so a production subscriber locked out of their
    // account was mailed a reset link to localhost. siteUrl() falls back to the deployment's own VERCEL_URL; with
    // no origin at all redirectTo is OMITTED and the auth provider uses the project's configured Site URL — the
    // same rule as invitationLandingUrl. Never an invented host.
    const origin = siteUrl()
    const { error } = await supabase.auth.resetPasswordForEmail(email, origin ? { redirectTo: `${origin}/auth/reset-password-confirm` } : {})

    if (error) {
      console.error("[Reset Password]", error)
      return NextResponse.json({ success: false, error: "Failed to send reset email" }, { status: 500 })
    }

    return NextResponse.json(
      {
        success: true,
        message: "Password reset email sent. Check your inbox.",
      },
      { status: 200 },
    )
  } catch (error: any) {
    console.error("[Reset Password Error]", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}
