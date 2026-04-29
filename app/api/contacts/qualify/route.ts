import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: NextRequest) {
  // Auth guard — caller identity always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // admin.createUser requires the service role client
  const serviceSupabase = createServiceClient()

  try {
    const { contactId } = await request.json()

    if (!contactId) {
      return NextResponse.json({ success: false, error: "Contact ID is required" }, { status: 400 })
    }

    // Fetch contact scoped to caller's brokerage to prevent cross-brokerage escalation
    const { data: contact, error: fetchError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (fetchError || !contact) {
      return NextResponse.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    // Check if already has login
    if (contact.has_login) {
      return NextResponse.json({
        success: true,
        message: "Contact already has login",
        loginCreated: false,
      })
    }

    if (!contact.email) {
      return NextResponse.json({ success: false, error: "Contact must have an email address" }, { status: 400 })
    }

    const tempPassword = generateSecurePassword()

    // Use service client for admin user creation — requires service role key
    const { data: authData, error: authError } = await serviceSupabase.auth.admin.createUser({
      email: contact.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        first_name: contact.first_name,
        last_name: contact.last_name,
        user_type: "contact",
        is_contact: true,
        contact_type: contact.contact_type,
        contact_persona: contact.contact_persona,
        created_by: auth.userId,   // session-resolved, not body
      },
    })

    if (authError) {
      console.error("[Qualify Contact] Auth error:", authError)
      return NextResponse.json({ success: false, error: "Failed to create user account" }, { status: 500 })
    }

    // Update contact — use service client to bypass RLS for this write
    const { error: updateError } = await serviceSupabase
      .from("contacts")
      .update({
        status: "qualified",
        contact_user_id: authData.user.id,
        has_login: true,
        login_created_at: new Date().toISOString(),
      })
      .eq("id", contactId)

    if (updateError) {
      console.error("[Qualify Contact] Update error:", updateError)
      return NextResponse.json({ success: false, error: "Failed to update contact" }, { status: 500 })
    }

    await sendWelcomeEmail(contact, tempPassword)

    return NextResponse.json({
      success: true,
      loginCreated: true,
      userEmail: contact.email,
      message: "Contact qualified and login created",
    })
  } catch (error: any) {
    console.error("[Qualify Contact] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}

function generateSecurePassword(): string {
  const length = 16
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
  let password = ""
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return password
}

async function sendWelcomeEmail(contact: any, tempPassword: string) {
  const personaWelcomeMessages: Record<string, string> = {
    first_time_buyer:
      "As a first-time buyer, you'll have access to educational resources, mortgage calculators, and property search tools designed specifically for you.",
    luxury_buyer:
      "As a luxury buyer, you'll have access to exclusive off-market listings, private viewings, and concierge services.",
    motivated_seller:
      "As a motivated seller, you'll have access to fast-track selling guides, staging tips, and timeline management tools.",
  }

  const welcomeMessage =
    personaWelcomeMessages[contact.contact_persona] ||
    "You now have access to your personalized real estate dashboard with tools and resources tailored to your needs."

  console.log(`
    ===== WELCOME EMAIL =====
    To: ${contact.email}
    Subject: You're All Set! Login to Access Your Real Estate Dashboard

    Hi ${contact.first_name},

    You've been qualified as a ${contact.contact_persona?.replace(/_/g, " ")}!

    ${welcomeMessage}

    Your Login Credentials:
    Email: ${contact.email}
    Temporary Password: ${tempPassword}
    Login URL: ${process.env.NEXT_PUBLIC_APP_URL || "https://yourdomain.com"}/login

    Please log in and change your password for security.
    =========================
  `)
  // TODO: Replace with actual email provider (SendGrid, Resend, etc.)
}
