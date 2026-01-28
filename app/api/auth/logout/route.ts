import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    // Create response
    const response = NextResponse.json(
      {
        success: true,
        message: "Logged out successfully",
      },
      { status: 200 }
    )

    // Clear the auth token cookie by setting it to expire immediately
    response.cookies.set({
      name: "auth-token",
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0, // Expire immediately
      path: "/",
    })

    // Also clear any other potential auth cookies
    response.cookies.set({
      name: "supabase-auth-token",
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    })

    return response
  } catch (error: any) {
    console.error("[Logout API Error]", error)
    return NextResponse.json(
      { success: false, error: error.message || "Logout failed" },
      { status: 500 }
    )
  }
}
