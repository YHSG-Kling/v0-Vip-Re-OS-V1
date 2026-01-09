import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ success: false, error: "Email is required" }, { status: 400 })
    }

    const supabase = await createServerClient()

    // Send password reset email
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/reset-password-confirm`,
    })

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
