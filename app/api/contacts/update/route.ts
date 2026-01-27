import { type NextRequest, NextResponse } from "next/server"
import { updateContact } from "@/lib/services/contact-management.service"
import { createClient } from "@/lib/supabase/server"
import { supabase } from "@/lib/supabase/client" // Import supabase
import { supabaseService } from "@/lib/services/supabase.service" // Import supabaseService

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { contactId, ...updates } = body

    if (!contactId) {
      return NextResponse.json({ success: false, error: "Contact ID is required" }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    // Use consolidated contact management service
    const result = await updateContact({
      contactId,
      agentId: user.id,
      updates,
    })

    if (!result.success || !result.contact) {
      return NextResponse.json({ success: false, error: result.error || "Failed to update contact" }, { status: 500 })
    }

    const contact = result.contact

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
  const supabase = await createClient()

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

  // Use consolidated update service
  await updateContact({
    contactId: contact.id,
    agentId,
    updates: {
      contact_user_id: authData.user.id,
      has_login: true,
      login_created_at: new Date().toISOString(),
    },
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
