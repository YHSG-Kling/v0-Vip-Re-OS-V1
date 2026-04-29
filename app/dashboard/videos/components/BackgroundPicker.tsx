"use client"

import { useState, useRef } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { Upload, Loader2, Check } from "lucide-react"

export type BackgroundValue =
  | { type: "color"; value: string }
  | { type: "image"; url: string; label?: string }

interface Props {
  value: BackgroundValue
  onChange: (bg: BackgroundValue) => void
  brokerageId?: string
}

const SOLID_COLORS = [
  { label: "White", hex: "#ffffff" },
  { label: "Cream", hex: "#f5f0e8" },
  { label: "Light Gray", hex: "#f0f0f0" },
  { label: "Navy", hex: "#1a2e4a" },
  { label: "Charcoal", hex: "#2d2d2d" },
  { label: "Black", hex: "#000000" },
  { label: "Sage", hex: "#8fa888" },
  { label: "Warm Taupe", hex: "#c4b49a" },
]

// Preset virtual backgrounds (public Supabase Storage URLs under video-backgrounds/ bucket)
const PRESET_BACKGROUNDS = [
  {
    id: "home-office",
    label: "Home Office",
    url: "https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&q=80",
  },
  {
    id: "modern-living",
    label: "Modern Living Room",
    url: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80",
  },
  {
    id: "luxury-interior",
    label: "Luxury Interior",
    url: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=800&q=80",
  },
  {
    id: "outdoor-patio",
    label: "Outdoor Patio",
    url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80",
  },
  {
    id: "neutral-studio",
    label: "Neutral Studio",
    url: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=800&q=80",
  },
  {
    id: "open-house",
    label: "Open House Foyer",
    url: "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=800&q=80",
  },
]

function ColorSwatch({
  hex,
  label,
  selected,
  onClick,
}: {
  hex: string
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "relative h-10 w-10 rounded-full border-2 transition-all",
        selected ? "border-primary ring-2 ring-primary ring-offset-2" : "border-border hover:border-primary/50"
      )}
      style={{ backgroundColor: hex }}
    >
      {selected && (
        <Check
          className={cn(
            "absolute inset-0 m-auto h-4 w-4",
            hex === "#ffffff" || hex === "#f5f0e8" || hex === "#f0f0f0" ? "text-gray-700" : "text-white"
          )}
        />
      )}
    </button>
  )
}

function ImageTile({
  url,
  label,
  selected,
  onClick,
}: {
  url: string
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative overflow-hidden rounded-lg border-2 aspect-video text-left transition-all",
        selected ? "border-primary ring-2 ring-primary ring-offset-2" : "border-border hover:border-primary/50"
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} className="h-full w-full object-cover" />
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 text-xs text-white truncate">
        {label}
      </div>
      {selected && (
        <div className="absolute top-1 right-1 rounded-full bg-primary p-0.5">
          <Check className="h-3 w-3 text-white" />
        </div>
      )}
    </button>
  )
}

export function BackgroundPicker({ value, onChange, brokerageId }: Props) {
  const [customHex, setCustomHex] = useState(
    value.type === "color" ? value.value : "#ffffff"
  )
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isColor = (hex: string) => value.type === "color" && value.value === hex
  const isImage = (url: string) => value.type === "image" && value.value === url

  const handleCustomHexChange = (hex: string) => {
    setCustomHex(hex)
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      onChange({ type: "color", value: hex })
    }
  }

  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setUploadError("Only image files are supported")
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("Image must be under 10 MB")
      return
    }
    setUploadError(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("bucket", "video-assets")
      form.append("folder", `video-backgrounds${brokerageId ? `/${brokerageId}` : ""}`)

      const res = await fetch("/api/storage/upload-temp", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")

      onChange({ type: "image", url: data.url, label: file.name })
    } catch (err: any) {
      setUploadError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      <Label>Video Background</Label>
      <Tabs defaultValue={value.type === "color" ? "solid" : "virtual"}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="solid">Solid Color</TabsTrigger>
          <TabsTrigger value="virtual">Virtual</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>

        {/* ── Solid Colors ─────────────────────────────── */}
        <TabsContent value="solid" className="space-y-3">
          <div className="flex flex-wrap gap-3 pt-1">
            {SOLID_COLORS.map((c) => (
              <ColorSwatch
                key={c.hex}
                hex={c.hex}
                label={c.label}
                selected={isColor(c.hex)}
                onClick={() => onChange({ type: "color", value: c.hex })}
              />
            ))}
          </div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={customHex}
              onChange={(e) => handleCustomHexChange(e.target.value)}
              className="h-10 w-10 cursor-pointer rounded border"
              title="Custom color"
            />
            <Input
              value={customHex}
              onChange={(e) => handleCustomHexChange(e.target.value)}
              placeholder="#ffffff"
              className="w-28 font-mono text-sm"
            />
            <span className="text-xs text-muted-foreground">Custom hex</span>
          </div>
        </TabsContent>

        {/* ── Virtual Backgrounds ───────────────────────── */}
        <TabsContent value="virtual">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
            {PRESET_BACKGROUNDS.map((bg) => (
              <ImageTile
                key={bg.id}
                url={bg.url}
                label={bg.label}
                selected={isImage(bg.url)}
                onClick={() => onChange({ type: "image", url: bg.url, label: bg.label })}
              />
            ))}
          </div>
        </TabsContent>

        {/* ── Custom Upload ─────────────────────────────── */}
        <TabsContent value="upload" className="space-y-3 pt-1">
          {value.type === "image" && !PRESET_BACKGROUNDS.find((b) => b.url === value.url) && (
            <div className="relative overflow-hidden rounded-lg border aspect-video">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={value.url} alt="Custom background" className="h-full w-full object-cover" />
              <p className="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 text-xs text-white truncate">
                {(value as any).label ?? "Custom background"}
              </p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFileUpload(file)
            }}
          />

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {uploading ? "Uploading…" : "Upload Image (JPEG / PNG, max 10 MB)"}
          </Button>

          {uploadError && (
            <p className="text-xs text-destructive">{uploadError}</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
