"use client"

import { useState, useTransition } from "react"
import { updateMyProfile, type UserProfileRow } from "@/app/actions/user-profile"

export function ProfileSettingsClient({ initialProfile }: { initialProfile: UserProfileRow }) {
  const [website, setWebsite] = useState(initialProfile.personal_website_url ?? "")
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

  function handleSave() {
    setError(null)
    setSavedAt(null)
    startTransition(async () => {
      const r = await updateMyProfile({ personalWebsiteUrl: website })
      if (!r.success) setError(r.error ?? "Save failed")
      else setSavedAt(new Date())
    })
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Profile Settings</h1>
        <p className="text-gray-600 mt-2">
          Your personal real-estate website (Realtor.com profile, Wix, Squarespace,
          custom domain). When set, the platform uses it as the canonical embed
          origin for /embed/blog and as the byline link on your blog landing pages.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">{error}</div>
      )}
      {savedAt && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded">
          Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <div className="border rounded-lg p-4 space-y-3">
        <label htmlFor="personalWebsite" className="block font-semibold text-gray-900">
          Personal Website URL
        </label>
        <input
          id="personalWebsite"
          type="url"
          inputMode="url"
          placeholder="https://your-domain.com"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          disabled={isPending}
          className="w-full border rounded px-3 py-2"
        />
        <p className="text-xs text-gray-500">
          Must start with <code>http://</code> or <code>https://</code>. Leave blank to clear.
        </p>
        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
