import { getMyProfile } from "@/app/actions/user-profile"
import { ProfileSettingsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function ProfileSettingsPage() {
  const result = await getMyProfile()
  if (!result.success || !result.profile) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Profile Settings</h1>
        <p className="text-red-600">{result.error ?? "Could not load profile"}</p>
      </div>
    )
  }
  return <ProfileSettingsClient initialProfile={result.profile} />
}
