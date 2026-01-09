import { type NextRequest, NextResponse } from "next/server"
import { supabase } from "@/services/supabase"

export async function POST(request: NextRequest) {
  try {
    const { contactId } = await request.json()

    if (!contactId) {
      return NextResponse.json({ success: false, error: "Contact ID is required" }, { status: 400 })
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    // Get contact
    const { data: contact, error: fetchError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("agent_id", user.id)
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

    // Generate secure password
    const tempPassword = generateSecurePassword()

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
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
        created_by: user.id,
      },
    })

    if (authError) {
      console.error("[Qualify Contact] Auth error:", authError)
      return NextResponse.json({ success: false, error: "Failed to create user account" }, { status: 500 })
    }

    // Update contact
    const { error: updateError } = await supabase
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

    // Send welcome email
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
    // Add more persona-specific messages
  }

  const welcomeMessage =
    personaWelcomeMessages[contact.contact_persona] ||
    "You now have access to your personalized real estate dashboard with tools and resources tailored to your needs."

  console.log(`
    ===== WELCOME EMAIL =====
    To: ${contact.email}
    Subject: You're All Set! Login to Access Your Real Estate Dashboard
    
    Hi ${contact.first_name},
    
    You've been qualified as a ${contact.contact_persona.replace(/_/g, " ")}! 
    
    ${welcomeMessage}
    
    Your Login Credentials:
    Email: ${contact.email}
    Temporary Password: ${tempPassword}
    Login URL: ${process.env.NEXT_PUBLIC_APP_URL || "https://yourdomain.com"}/login
    
    Please log in and change your password for security.
    
    Best regards,
    Your Real Estate Team
    =========================
  `)

  // Implement actual email sending with SendGrid, Resend, etc.
}
