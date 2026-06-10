"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { createVideoProject, deleteVideoProject } from "@/app/actions/listing-media"
import {
  PlusIcon,
  VideoIcon,
  Trash2Icon,
  ExternalLinkIcon,
  ClockIcon,
} from "lucide-react"
import { toast } from "@/hooks/use-toast"

interface VideoProject {
  id: string
  title: string | null
  script_content: string | null
  status: string | null
  video_url: string | null
  heygen_status: string | null
  heygen_avatar_id: string | null
  heygen_voice_id: string | null
  heygen_template_id: string | null
  video_type: string | null
  duration_seconds: number | null
  error_message: string | null
  created_at: string
}

interface VideoTemplate {
  id: string
  template_name: string
  category: string
  description: string | null
  thumbnail_url: string | null
  default_script: string | null
  duration_seconds: number | null
  recommended_for: string[] | null
}

interface VideoPanelProps {
  listingId: string
  brokerageId: string
  videos: VideoProject[]
  templates: VideoTemplate[]
  onVideosChange: (videos: VideoProject[]) => void
}

const STATUS_COLORS: Record<string, string> = {
  planning:    "bg-muted text-muted-foreground",
  processing:  "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  completed:   "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed:      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
}

export function VideoPanel({ listingId, brokerageId, videos, templates, onVideosChange }: VideoPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<VideoTemplate | null>(null)
  const [form, setForm] = useState({
    title:           "",
    scriptContent:   "",
    videoType:       "listing_tour",
    heygenAvatarId:  "",
    heygenVoiceId:   "",
    heygenTemplateId: "",
  })

  const applyTemplate = (template: VideoTemplate) => {
    setSelectedTemplate(template)
    setForm(f => ({
      ...f,
      title:            template.template_name,
      scriptContent:    template.default_script ?? "",
      heygenTemplateId: f.heygenTemplateId,
    }))
  }

  const handleCreate = () => {
    if (!form.title.trim() || !form.scriptContent.trim()) return
    startTransition(async () => {
      const result = await createVideoProject({
        listingId,
        brokerageId,
        title:             form.title.trim(),
        scriptContent:     form.scriptContent.trim(),
        videoType:         form.videoType,
        heygenAvatarId:    form.heygenAvatarId.trim() || undefined,
        heygenVoiceId:     form.heygenVoiceId.trim() || undefined,
        heygenTemplateId:  form.heygenTemplateId.trim() || undefined,
      })
      if (result.error) {
        toast({ title: "Error creating project", description: result.error, variant: "destructive" })
        return
      }
      const updated = await import("@/app/actions/listing-media").then(m => m.getVideoProjects(listingId))
      onVideosChange(updated.data ?? [])
      setCreateOpen(false)
      setForm({ title: "", scriptContent: "", videoType: "listing_tour", heygenAvatarId: "", heygenVoiceId: "", heygenTemplateId: "" })
      setSelectedTemplate(null)
      toast({ title: "Video project created", description: "Brand compliance check queued." })
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const result = await deleteVideoProject(id)
      if (!result.success) { toast({ title: "Error", description: result.error, variant: "destructive" }); return }
      onVideosChange(videos.filter(v => v.id !== id))
      toast({ title: "Project deleted" })
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {videos.length} project{videos.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="flex items-center gap-2">
          <PlusIcon className="w-4 h-4" />
          New Video Project
        </Button>
      </div>

      {/* Project list */}
      {videos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-border rounded-lg gap-3">
          <VideoIcon className="w-8 h-8 text-muted-foreground/50" />
          <p className="text-muted-foreground text-sm">No video projects yet.</p>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            Create first project
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {videos.map(v => (
            <Card key={v.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <CardTitle className="text-base font-medium truncate">
                    {v.title ?? "Untitled Project"}
                  </CardTitle>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[v.status ?? "planning"] ?? STATUS_COLORS.planning}`}>
                      {v.status ?? "planning"}
                    </span>
                    {v.heygen_status && v.heygen_status !== v.status && (
                      <Badge variant="outline" className="text-xs">
                        Render: {v.heygen_status}
                      </Badge>
                    )}
                    {v.duration_seconds && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <ClockIcon className="w-3 h-3" />
                        {Math.ceil(v.duration_seconds / 60)}m
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {v.video_url && (
                    <Button size="icon" variant="ghost" className="h-8 w-8" asChild>
                      <a href={v.video_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLinkIcon className="w-4 h-4" />
                        <span className="sr-only">Open video</span>
                      </a>
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(v.id)}
                    disabled={isPending}
                  >
                    <Trash2Icon className="w-4 h-4" />
                    <span className="sr-only">Delete</span>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {v.script_content && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{v.script_content}</p>
                )}
                {v.error_message && (
                  <p className="text-xs text-destructive mt-1">{v.error_message}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                  {v.heygen_avatar_id && <span>Avatar: {v.heygen_avatar_id}</span>}
                  {v.heygen_voice_id && <span>Voice: {v.heygen_voice_id}</span>}
                  {v.heygen_template_id && <span>Template: {v.heygen_template_id}</span>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New AI Video Project</DialogTitle>
          </DialogHeader>

          {/* Template picker */}
          {templates.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium">Start from template</Label>
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {templates.map(t => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className={`text-left border rounded-md p-3 text-sm transition-colors hover:bg-accent ${
                      selectedTemplate?.id === t.id
                        ? "border-primary bg-accent"
                        : "border-border"
                    }`}
                  >
                    <p className="font-medium truncate">{t.template_name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{t.category}</p>
                    {t.duration_seconds && (
                      <p className="text-xs text-muted-foreground">{Math.ceil(t.duration_seconds / 60)}m</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-4 mt-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vTitle">Title <span className="text-destructive">*</span></Label>
              <Input
                id="vTitle"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Listing Tour — 123 Main St"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vScript">Script <span className="text-destructive">*</span></Label>
              <Textarea
                id="vScript"
                value={form.scriptContent}
                onChange={e => setForm(f => ({ ...f, scriptContent: e.target.value }))}
                placeholder="Write the video script..."
                rows={5}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="avatarId">D-ID Avatar ID</Label>
                <Input
                  id="avatarId"
                  value={form.heygenAvatarId}
                  onChange={e => setForm(f => ({ ...f, heygenAvatarId: e.target.value }))}
                  placeholder="avatar_..."
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="voiceId">ElevenLabs Voice ID</Label>
                <Input
                  id="voiceId"
                  value={form.heygenVoiceId}
                  onChange={e => setForm(f => ({ ...f, heygenVoiceId: e.target.value }))}
                  placeholder="voice_..."
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={isPending || !form.title.trim() || !form.scriptContent.trim()}
            >
              {isPending ? "Creating..." : "Create Project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
