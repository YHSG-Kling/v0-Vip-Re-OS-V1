import { type NextRequest, NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"
import { supabase } from "@/services/supabase"

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { contactId, ...updates } = body

    if (!contactId) {
      return NextResponse.json({ success: false, error: "Contact ID is required" }, { status: 400 })
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const contact = await supabaseService.updateContact(contactId, updates)

    if (!contact) {
      return NextResponse.json({ success: false, error: "Failed to update contact" }, { status: 500 })
    }

    // Check if being qualified
    const wasQualified = updates.status === "qualified"
    let loginCreated = false

    // If qualified and no login exists, create user account
    if (wasQualified && !contact.has_login) {
      try {
        const userCreated = await createContactUser(contact, contact.agent_id || "")
        loginCreated = userCreated
      } catch (loginError) {
        console.error("[Contact Update] Login creation failed:", loginError)
      }
    }

    return NextResponse.json({
      success: true,
      contact,
      loginCreated,
      message: "Contact updated successfully",
    })
  } catch (error: any) {
    console.error("[Contact Update] Error:", error)
    return NextResponse.json({ success: false, error: error.message || "Internal server error" }, { status: 500 })
  }
}

async function createContactUser(contact: any, agentId: string) {
  const tempPassword = generateSecurePassword()

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
      created_by: agentId,
    },
  })

  if (authError) throw authError

  await supabaseService.updateContact(contact.id, {
    contact_user_id: authData.user.id,
    has_login: true,
    login_created_at: new Date().toISOString(),
  })

  return true
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
