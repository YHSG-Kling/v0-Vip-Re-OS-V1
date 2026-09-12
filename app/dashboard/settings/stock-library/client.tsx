"use client"

/**
 * Wave 39 — stock library upload UI. Lets broker admins, team leads,
 * and solo agents upload their own intros / outros / B-roll / music
 * scoped to the appropriate tier. The render coordinator reads from
 * video_assets when stitching bookends + mixing music — uploads
 * here take effect on the next render.
 *
 * File upload pattern: each pick goes straight to Vercel Blob via
 * the @vercel/blob/client put helper, then we register the metadata
 * server-side. Same pattern the existing brand_asset_library uses.
 */
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  registerStockAsset,
  deleteStockAsset,
  type StockAssetRow,
  type StockCategory,
} from "@/app/actions/stock-library"

interface AccessProp {
  canEditAgent:     boolean
  canEditTeam:      boolean
  canEditBrokerage: boolean
  agentScopeId:     string | null
  teamScopeIds:     string[]
  brokerageScopeId: string | null
}

const CATEGORY_LABEL: Record<StockCategory, string> = {
  brand_intro:  "Brand Intro",
  logo_outro:   "Logo Outro",
  b_roll:       "B-roll",
  neighborhood: "Neighborhood Cutaway",
  music:        "Background Music",
}

const CATEGORY_ORDER: StockCategory[] = ["brand_intro", "logo_outro", "b_roll", "neighborhood", "music"]

export function StockLibraryClient({
  assets, access,
}: {
  assets: StockAssetRow[]
  access: AccessProp
}) {
  const [showUpload, setShowUpload] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function handleDelete(id: string) {
    setError(null)
    startTransition(async () => {
      const r = await deleteStockAsset(id)
      if (!r.success) { setError(r.error ?? "Delete failed"); return }
      router.refresh()
    })
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Stock Library</h1>
          <p className="text-gray-600 mt-2 max-w-2xl">
            Upload intros, outros, B-roll, and background music the
            render coordinator stitches into your videos. Solo agents
            upload to their own scope (your personal brand); team leads
            and brokers upload to shared scopes. The render coordinator
            walks the cascade — agent scope first, brokerage fallback.
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 whitespace-nowrap">
          + Upload asset
        </button>
      </header>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const inCat = assets.filter((a) => a.category === cat)
        return (
          <section key={cat}>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">
              {CATEGORY_LABEL[cat]} <span className="text-gray-500 font-normal">({inCat.length})</span>
            </h2>
            {inCat.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No {CATEGORY_LABEL[cat].toLowerCase()} uploaded yet.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {inCat.map((a) => (
                  <AssetCard key={a.id} asset={a} onDelete={() => handleDelete(a.id)} pending={pending} />
                ))}
              </div>
            )}
          </section>
        )
      })}

      {showUpload && (
        <UploadModal
          access={access}
          onClose={() => setShowUpload(false)}
          onSaved={() => { setShowUpload(false); router.refresh() }}
        />
      )}
    </div>
  )
}

function AssetCard({ asset, onDelete, pending }: {
  asset:    StockAssetRow
  onDelete: () => void
  pending:  boolean
}) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">{asset.title}</h3>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">{asset.scope_type}</span>
            {asset.duration_seconds !== null && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                {asset.duration_seconds}s
              </span>
            )}
            {asset.category === "music" && asset.music_volume_pct !== null && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700">
                Vol {asset.music_volume_pct}%
              </span>
            )}
            {asset.license_url && (
              <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">licensed</span>
            )}
          </div>
          {asset.description && (
            <p className="mt-2 text-sm text-gray-600 line-clamp-2">{asset.description}</p>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3 justify-end">
        <a href={asset.video_url} target="_blank" rel="noreferrer"
          className="text-xs px-3 py-1 border border-gray-200 rounded hover:bg-gray-50">Preview</a>
        <button onClick={onDelete} disabled={pending}
          className="text-xs px-3 py-1 border border-gray-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50">
          Delete
        </button>
      </div>
    </div>
  )
}

function UploadModal({ access, onClose, onSaved }: {
  access:  AccessProp
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<StockCategory>("brand_intro")
  const [scopeType, setScopeType] = useState<"agent" | "team" | "brokerage">(
    access.canEditBrokerage ? "brokerage" :
    access.canEditTeam      ? "team" :
    "agent"
  )
  const [videoUrl, setVideoUrl] = useState("")
  const [musicVolume, setMusicVolume] = useState(20)
  const [musicLoop, setMusicLoop] = useState(true)
  const [licenseUrl, setLicenseUrl] = useState("")
  const [licenseAttr, setLicenseAttr] = useState("")
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpload(file: File) {
    setUploading(true); setError(null)
    try {
      // Was @vercel/blob/client's `upload()`. Survivor:
      // lib/storage/browser-upload.ts#uploadViaSignedUrl (owner ruling — all
      // file storage lives in Supabase buckets). Still a direct browser→storage
      // PUT, so a B-roll clip is not capped at Vercel's 4.5 MB function body
      // limit. The old path was `stock-library/${file.name}` — no tenant in it
      // at all, so two brokerages uploading `intro.mp4` wrote the same key; the
      // key is now built server-side under the session's brokerage.
      const { uploadViaSignedUrl } = await import("@/lib/storage/browser-upload")
      const stored = await uploadViaSignedUrl({ purpose: "stock_library", file })
      if (!stored.ok) {
        setError(stored.error)
        return
      }
      setVideoUrl(stored.url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (category === "music" && !licenseUrl.trim()) {
      setError("Music tracks require a license URL.")
      return
    }
    const r = await registerStockAsset({
      title,
      description: description || undefined,
      category,
      scope_type: scopeType,
      video_url:  videoUrl,
      music_volume_pct: category === "music" ? musicVolume : undefined,
      music_loop:       category === "music" ? musicLoop   : undefined,
      license_url:        licenseUrl || undefined,
      license_attribution: licenseAttr || undefined,
    })
    if (!r.success) { setError(r.error ?? "Save failed"); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 my-6 space-y-4">
        <header className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900">Upload stock asset</h2>
          <button type="button" onClick={onClose} className="text-2xl text-gray-400 hover:text-gray-700">×</button>
        </header>

        {error && <div className="p-2 bg-red-50 border border-red-200 text-red-800 rounded text-sm">{error}</div>}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Title</span>
            <input required value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Office bay-front exterior"
              className="w-full border rounded px-3 py-1.5" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-700 mb-1">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as StockCategory)}
              className="w-full border rounded px-3 py-1.5">
              {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </label>
        </div>

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">Scope</span>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value as "agent" | "team" | "brokerage")}
            className="w-full border rounded px-3 py-1.5">
            {access.canEditAgent && <option value="agent">My personal brand</option>}
            {access.canEditTeam && <option value="team">My team</option>}
            {access.canEditBrokerage && <option value="brokerage">Brokerage</option>}
          </select>
        </label>

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">File</span>
          {videoUrl ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-green-700 break-all">{videoUrl}</span>
              <button type="button" onClick={() => setVideoUrl("")}
                className="text-xs px-2 py-0.5 border border-gray-200 rounded hover:bg-gray-50">
                Change
              </button>
            </div>
          ) : (
            <input type="file" accept="video/*,audio/*"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleUpload(file)
              }}
              className="w-full text-xs" />
          )}
          {uploading && <p className="text-xs text-gray-500 mt-1 italic">Uploading…</p>}
        </label>

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">Description (optional)</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="When to use this asset, who shot it, etc."
            className="w-full border rounded px-3 py-1.5 text-xs" />
        </label>

        {category === "music" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="block text-xs text-gray-700 mb-1">Volume under voice (%)</span>
                <input type="number" min={0} max={100} step={5} value={musicVolume}
                  onChange={(e) => setMusicVolume(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 20)))}
                  className="w-full border rounded px-3 py-1.5" />
              </label>
              <label className="text-sm flex items-center gap-2 mt-5">
                <input type="checkbox" checked={musicLoop} onChange={(e) => setMusicLoop(e.target.checked)} />
                Loop to fill video length
              </label>
            </div>
          </>
        )}

        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">
            License URL {category === "music" ? "(required)" : "(recommended)"}
          </span>
          <input type="url" required={category === "music"} value={licenseUrl}
            onChange={(e) => setLicenseUrl(e.target.value)}
            placeholder="https://artlist.io/.../license/123"
            className="w-full border rounded px-3 py-1.5 font-mono text-xs" />
        </label>
        <label className="text-sm block">
          <span className="block text-xs text-gray-700 mb-1">License attribution</span>
          <input value={licenseAttr} onChange={(e) => setLicenseAttr(e.target.value)}
            placeholder="Music by [Artist] · Licensed via Artlist"
            className="w-full border rounded px-3 py-1.5" />
        </label>

        <div className="flex justify-end gap-2 border-t pt-3">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border rounded text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={!videoUrl || uploading || !title.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            Save asset
          </button>
        </div>
      </form>
    </div>
  )
}
