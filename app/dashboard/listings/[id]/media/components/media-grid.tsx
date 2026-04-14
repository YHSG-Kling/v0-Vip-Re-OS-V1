"use client"

import { useState, useTransition, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  uploadListingMedia,
  approveListingMedia,
  rejectListingMedia,
  deleteListingMedia,
  setPrimaryMedia,
  runComplianceCheck,
} from "@/app/actions/listing-media"
import { createClient } from "@/lib/supabase/client"
import {
  MoreHorizontalIcon,
  PlusIcon,
  CheckCircleIcon,
  XCircleIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
  UploadIcon,
  Loader2,
} from "lucide-react"
import { toast } from "@/hooks/use-toast"

interface MediaItem {
  id: string
  media_type: string
  file_url: string
  thumbnail_url: string | null
  caption: string | null
  alt_text: string | null
  tags: string[]
  is_primary: boolean
  is_approved: boolean
  approval_required: boolean
  kernel_compliance_passed: boolean
  rejection_notes: string | null
  sort_order: number
}

interface MediaGridProps {
  listingId: string
  brokerageId: string
  media: MediaItem[]
  canApprove: boolean
  onMediaChange: (media: MediaItem[]) => void
}

const MEDIA_TYPE_OPTIONS = [
  { value: "photo",         label: "Photo" },
  { value: "video",         label: "Video" },
  { value: "floor_plan",    label: "Floor Plan" },
  { value: "virtual_tour",  label: "Virtual Tour" },
  { value: "document",      label: "Document" },
]

export function MediaGrid({ listingId, brokerageId, media, canApprove, onMediaChange }: MediaGridProps) {
  const [isPending, startTransition] = useTransition()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState<string | null>(null)
  const [rejectNotes, setRejectNotes] = useState("")
  const [form, setForm] = useState({
    fileUrl: "",
    thumbnailUrl: "",
    caption: "",
    altText: "",
    mediaType: "photo" as const,
    isPrimary: false,
  })

  // File upload state
  const [fileUploading, setFileUploading] = useState(false)
  const [fileUploadProgress, setFileUploadProgress] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setFileUploading(true)
    setFileUploadProgress("Uploading...")

    try {
      const supabase = createClient()
      const ext = file.name.split(".").pop() ?? "jpg"
      const path = `${listingId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from("listing-media")
        .upload(path, file, { upsert: false })

      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage.from("listing-media").getPublicUrl(path)
      setForm(f => ({ ...f, fileUrl: urlData.publicUrl }))
      setFileUploadProgress("File uploaded — URL filled in below")
    } catch (err: any) {
      setFileUploadProgress(`Upload failed: ${err?.message ?? "Unknown error"}`)
    } finally {
      setFileUploading(false)
    }
  }

  const handleUpload = () => {
    if (!form.fileUrl.trim()) return
    startTransition(async () => {
      const result = await uploadListingMedia({
        listingId,
        brokerageId,
        mediaType:    form.mediaType,
        fileUrl:      form.fileUrl.trim(),
        thumbnailUrl: form.thumbnailUrl.trim() || undefined,
        caption:      form.caption.trim() || undefined,
        altText:      form.altText.trim() || undefined,
        isPrimary:    form.isPrimary,
        approvalRequired: true,
      })
      if (result.error) {
        toast({ title: "Upload failed", description: result.error, variant: "destructive" })
        return
      }
      // Refresh list
      const updated = await import("@/app/actions/listing-media").then(m => m.getListingMedia(listingId))
      onMediaChange(updated.data ?? [])
      setUploadOpen(false)
      setForm({ fileUrl: "", thumbnailUrl: "", caption: "", altText: "", mediaType: "photo", isPrimary: false })
      toast({ title: "Media uploaded", description: result.data?.compliance?.passed ? "Brand compliance passed." : "Compliance check flagged issues." })
    })
  }

  const handleApprove = (id: string) => {
    startTransition(async () => {
      const result = await approveListingMedia(id)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onMediaChange(media.map(m => m.id === id ? { ...m, is_approved: true, rejection_notes: null } : m))
      toast({ title: "Media approved" })
    })
  }

  const handleReject = (id: string) => {
    startTransition(async () => {
      const result = await rejectListingMedia(id, rejectNotes)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onMediaChange(media.map(m => m.id === id ? { ...m, is_approved: false, rejection_notes: rejectNotes } : m))
      setRejectOpen(null)
      setRejectNotes("")
      toast({ title: "Media rejected" })
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const result = await deleteListingMedia(id)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onMediaChange(media.filter(m => m.id !== id))
      toast({ title: "Media deleted" })
    })
  }

  const handleSetPrimary = (id: string) => {
    startTransition(async () => {
      const result = await setPrimaryMedia(id, listingId)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onMediaChange(media.map(m => ({ ...m, is_primary: m.id === id })))
    })
  }

  const handleRunCompliance = (id: string) => {
    startTransition(async () => {
      const result = await runComplianceCheck(id, brokerageId)
      onMediaChange(media.map(m => m.id === id ? { ...m, kernel_compliance_passed: result.passed } : m))
      toast({
        title: result.passed ? "Compliance passed" : "Compliance failed",
        description: result.violations.length > 0 ? result.violations.join(", ") : undefined,
        variant: result.passed ? "default" : "destructive",
      })
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {media.length} file{media.length !== 1 ? "s" : ""}
          {media.filter(m => m.is_approved).length > 0 && (
            <span className="ml-2 text-green-600 dark:text-green-400">
              · {media.filter(m => m.is_approved).length} approved
            </span>
          )}
        </p>
        <Button size="sm" onClick={() => setUploadOpen(true)} className="flex items-center gap-2">
          <PlusIcon className="w-4 h-4" />
          Add Media
        </Button>
      </div>

      {/* Grid */}
      {media.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border rounded-lg gap-3">
          <p className="text-muted-foreground text-sm">No media uploaded yet.</p>
          <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
            Add first file
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {media.map(item => (
            <Card key={item.id} className="overflow-hidden group relative">
              {/* Thumbnail */}
              <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
                {item.thumbnail_url || item.file_url ? (
                  <img
                    src={item.thumbnail_url ?? item.file_url}
                    alt={item.alt_text ?? item.caption ?? item.media_type}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    {item.media_type}
                  </span>
                )}
              </div>

              {/* Status badges */}
              <div className="absolute top-2 left-2 flex flex-col gap-1">
                {item.is_primary && (
                  <Badge className="text-xs bg-yellow-500 text-white border-0 flex items-center gap-1">
                    <StarIcon className="w-3 h-3" /> Primary
                  </Badge>
                )}
                {item.kernel_compliance_passed ? (
                  <Badge className="text-xs bg-green-600 text-white border-0 flex items-center gap-1">
                    <ShieldCheckIcon className="w-3 h-3" /> OK
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="text-xs flex items-center gap-1">
                    <ShieldAlertIcon className="w-3 h-3" /> Compliance
                  </Badge>
                )}
              </div>

              {/* Approval badge */}
              <div className="absolute top-2 right-2">
                {item.approval_required && !item.is_approved ? (
                  <Badge variant="secondary" className="text-xs">Pending</Badge>
                ) : item.is_approved ? (
                  <Badge className="text-xs bg-green-600 text-white border-0">Approved</Badge>
                ) : null}
              </div>

              {/* Footer */}
              <div className="p-2 flex items-center justify-between gap-1">
                <p className="text-xs text-muted-foreground truncate flex-1">
                  {item.caption ?? item.media_type}
                </p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
                      <MoreHorizontalIcon className="w-3 h-3" />
                      <span className="sr-only">Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!item.is_primary && (
                      <DropdownMenuItem onClick={() => handleSetPrimary(item.id)}>
                        <StarIcon className="w-3 h-3 mr-2" /> Set as primary
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => handleRunCompliance(item.id)}>
                      <ShieldCheckIcon className="w-3 h-3 mr-2" /> Re-run compliance
                    </DropdownMenuItem>
                    {canApprove && item.approval_required && !item.is_approved && (
                      <DropdownMenuItem onClick={() => handleApprove(item.id)}>
                        <CheckCircleIcon className="w-3 h-3 mr-2" /> Approve
                      </DropdownMenuItem>
                    )}
                    {canApprove && item.is_approved && (
                      <DropdownMenuItem onClick={() => { setRejectOpen(item.id); setRejectNotes("") }}>
                        <XCircleIcon className="w-3 h-3 mr-2" /> Reject
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => handleDelete(item.id)}
                    >
                      <Trash2Icon className="w-3 h-3 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Rejection notes */}
              {item.rejection_notes && (
                <div className="px-2 pb-2">
                  <p className="text-xs text-destructive truncate">{item.rejection_notes}</p>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <Dialog open={uploadOpen} onOpenChange={open => {
        setUploadOpen(open)
        if (!open) {
          setFileUploadProgress(null)
          if (fileInputRef.current) fileInputRef.current.value = ""
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Media</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mediaType">Type</Label>
              <select
                id="mediaType"
                value={form.mediaType}
                onChange={e => setForm(f => ({ ...f, mediaType: e.target.value as any }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {MEDIA_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* File source: upload or URL */}
            <Tabs defaultValue="upload" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="upload" className="flex-1 text-xs gap-1.5">
                  <UploadIcon className="h-3.5 w-3.5" /> Upload File
                </TabsTrigger>
                <TabsTrigger value="url" className="flex-1 text-xs">Enter URL</TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="mt-2 space-y-2">
                <div
                  className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {fileUploading ? (
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Uploading…</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1">
                      <UploadIcon className="h-6 w-6 text-muted-foreground" />
                      <p className="text-xs font-medium">Click to choose a file</p>
                      <p className="text-[10px] text-muted-foreground">JPG, PNG, PDF, MP4</p>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*,application/pdf"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {fileUploadProgress && (
                  <p className={`text-xs ${fileUploadProgress.startsWith("Upload failed") ? "text-destructive" : "text-green-600"}`}>
                    {fileUploadProgress}
                  </p>
                )}
                {form.fileUrl && (
                  <p className="text-xs text-muted-foreground truncate">
                    URL: {form.fileUrl}
                  </p>
                )}
              </TabsContent>
              <TabsContent value="url" className="mt-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fileUrl">File URL <span className="text-destructive">*</span></Label>
                  <Input
                    id="fileUrl"
                    placeholder="https://..."
                    value={form.fileUrl}
                    onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
                  />
                </div>
              </TabsContent>
            </Tabs>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="thumbnailUrl">Thumbnail URL</Label>
              <Input
                id="thumbnailUrl"
                placeholder="https://... (optional)"
                value={form.thumbnailUrl}
                onChange={e => setForm(f => ({ ...f, thumbnailUrl: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="caption">Caption</Label>
              <Input
                id="caption"
                placeholder="e.g. Front exterior"
                value={form.caption}
                onChange={e => setForm(f => ({ ...f, caption: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altText">Alt text</Label>
              <Input
                id="altText"
                placeholder="Describe the image for screen readers"
                value={form.altText}
                onChange={e => setForm(f => ({ ...f, altText: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPrimary"
                checked={form.isPrimary}
                onChange={e => setForm(f => ({ ...f, isPrimary: e.target.checked }))}
                className="h-4 w-4 rounded border-input"
              />
              <Label htmlFor="isPrimary" className="cursor-pointer">Set as primary</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={isPending || !form.fileUrl.trim()}>
              {isPending ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectOpen} onOpenChange={open => { if (!open) setRejectOpen(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Media</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor="rejectNotes">Reason</Label>
            <Input
              id="rejectNotes"
              placeholder="Reason for rejection..."
              value={rejectNotes}
              onChange={e => setRejectNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => rejectOpen && handleReject(rejectOpen)}
              disabled={isPending || !rejectNotes.trim()}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
