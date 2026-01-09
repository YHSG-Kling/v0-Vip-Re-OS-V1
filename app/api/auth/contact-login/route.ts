import { type NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@/lib/supabase/server"

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json({ success: false, error: "Email and password required" }, { status: 400 })
    }

    const supabase = await createServerClient()

    // Authenticate with Supabase
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (authError || !authData.user) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 })
    }

    // Get contact info from user metadata
    const contactData = authData.user.user_metadata
    const contactPersona = contactData?.contact_persona || "default"

    // Create response with session
    const response = NextResponse.json(
      {
        success: true,
        user: {
          id: authData.user.id,
          email: authData.user.email,
          firstName: contactData?.first_name || "",
          lastName: contactData?.last_name || "",
          contactPersona,
          redirectTo: `/contact/${contactPersona}`,
        },
      },
      { status: 200 },
    )

    // Set secure cookies for session
    if (authData.session) {
      response.cookies.set({
        name: "supabase-auth-token",
        value: authData.session.access_token,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 1 week
      })
    }

    return response
  } catch (error: any) {
    console.error("[Contact Login]", error)
    return NextResponse.json({ success: false, error: error.message || "Login failed" }, { status: 500 })
  }
}
