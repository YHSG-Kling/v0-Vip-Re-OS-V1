"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

interface ProfileUpdate {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  state?: string
  zip_code?: string
  preferred_contact_method?: string
  custom_fields?: Record<string, any>
}

export async function updateContactProfile(
  contactId: string,
  updates: ProfileUpdate,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("contacts")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contactId)

    if (error) {
      console.error("Error updating contact profile:", error)
      return { success: false, error: error.message }
    }

    revalidatePath(`/portal/${contactId}`)
    revalidatePath(`/portal/${contactId}/settings`)

    return { success: true }
  } catch (error) {
    console.error("Unexpected error updating profile:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

export async function uploadProfilePhoto(
  contactId: string,
  file: File,
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Upload to Supabase Storage
    const fileExt = file.name.split(".").pop()
    const fileName = `${contactId}-${Date.now()}.${fileExt}`
    const filePath = `avatars/${fileName}`

    const { error: uploadError } = await supabase.storage.from("client-documents").upload(filePath, file)

    if (uploadError) {
      return { success: false, error: uploadError.message }
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from("client-documents").getPublicUrl(filePath)

    // Update contact with new avatar URL
    const { error: updateError } = await supabase
      .from("contacts")
      .update({ avatar_url: urlData.publicUrl })
      .eq("id", contactId)

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    revalidatePath(`/portal/${contactId}`)
    revalidatePath(`/portal/${contactId}/settings`)

    return { success: true, url: urlData.publicUrl }
  } catch (error) {
    console.error("Error uploading profile photo:", error)
    return { success: false, error: "Failed to upload photo" }
  }
}

export async function deletePortalAccount(contactId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    // Soft delete - mark as deleted rather than actually removing
    const { error } = await supabase
      .from("contacts")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
        email: null, // Remove PII
        phone: null,
      })
      .eq("id", contactId)

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    console.error("Error deleting account:", error)
    return { success: false, error: "Failed to delete account" }
  }
}
