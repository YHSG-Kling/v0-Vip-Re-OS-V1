"use client"

import { useState, useEffect } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { Badge } from "@/app/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/app/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import {
  Loader2,
  ChevronRight,
  ChevronLeft,
  FileText,
  Sparkles,
  Video,
  Mic2,
  Settings,
  Upload,
} from "lucide-react"
import {
  createPodcastEpisode,
  generatePodcastEpisodeDescription,
  getVideoScriptsLibrary,
  getVideoProjects,
} from "@/app/actions/podcast-generation"

interface Template {
  id: string
  name: string
  template_type: string
  host_name: string
  show_name: string
}

interface DistributionChannel {
  id: string
  channel_name: string
  is_enabled: boolean
}

interface CreateEpisodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: Template[]
  channels: DistributionChannel[]
  onCreated: () => void
}

interface VideoScript {
  id: string
  title: string
  script_content: string
  script_type: string
  duration_target_seconds: number
}

interface VideoProject {
  id: string
  title: string
  script_content: string
  video_type: string
  duration_seconds: number
  status: string
}

type SourceType = "script" | "keywords" | "video"

const STEPS = [
  { id: "source", label: "Source", icon: FileText },
  { id: "script", label: "Script", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic2 },
  { id: "template", label: "Template", icon: Settings },
  { id: "publish", label: "Publish", icon: Upload },
]

const CATEGORIES = [
  { value: "market_update", label: "Market Update" },
  { value: "buyer_tips", label: "Buyer Tips" },
  { value: "seller_tips", label: "Seller Tips" },
  { value: "neighborhood", label: "Neighborhood Guide" },
  { value: "interview", label: "Interview" },
  { value: "general", label: "General" },
]

export function CreateEpisodeDialog({
  open,
  onOpenChange,
  templates,
  channels,
  onCreated,
}: CreateEpisodeDialogProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)

  // Source data
  const [videoScripts, setVideoScripts] = useState<VideoScript[]>([])
  const [videoProjects, setVideoProjects] = useState<VideoProject[]>([])

  // Form state
  const [sourceType, setSourceType] = useState<SourceType>("keywords")
  const [selectedScriptId, setSelectedScriptId] = useState<string>("")
  const [selectedProjectId, setSelectedProjectId] = useState<string>("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [generatingDesc, setGeneratingDesc] = useState(false)
  const [script, setScript] = useState("")
  const [keywords, setKeywords] = useState<string[]>([])
  const [keywordInput, setKeywordInput] = useState("")
  const [voiceId, setVoiceId] = useState("default")
  const [templateId, setTemplateId] = useState<string>("")
  const [category, setCategory] = useState("general")
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])

  const handleGenerateDescription = async () => {
    if (!title.trim()) return
    setGeneratingDesc(true)
    try {
      const result = await generatePodcastEpisodeDescription({
        title: title.trim(),
        keywords,
      })
      if (result.success && result.description) {
        setDescription(result.description)
      }
    } finally {
      setGeneratingDesc(false)
    }
  }

  // Load content when dialog opens
  useEffect(() => {
    if (open) {
      loadSourceContent()
    } else {
      resetForm()
    }
  }, [open])

  async function loadSourceContent() {
    setLoadingContent(true)
    try {
      const [scriptsResult, projectsResult] = await Promise.all([
        getVideoScriptsLibrary(),
        getVideoProjects(),
      ])

      if (scriptsResult.success) {
        setVideoScripts(scriptsResult.scripts || [])
      }
      if (projectsResult.success) {
        setVideoProjects(projectsResult.projects || [])
      }
    } catch (error) {
      console.error("Failed to load source content:", error)
    } finally {
      setLoadingContent(false)
    }
  }

  function resetForm() {
    setCurrentStep(0)
    setSourceType("keywords")
    setSelectedScriptId("")
    setSelectedProjectId("")
    setTitle("")
    setDescription("")
    setScript("")
    setKeywords([])
    setKeywordInput("")
    setVoiceId("default")
    setTemplateId("")
    setCategory("general")
    setSelectedChannels([])
  }

  function handleAddKeyword() {
    if (keywordInput.trim() && !keywords.includes(keywordInput.trim())) {
      setKeywords([...keywords, keywordInput.trim()])
      setKeywordInput("")
    }
  }

  function handleRemoveKeyword(keyword: string) {
    setKeywords(keywords.filter((k) => k !== keyword))
  }

  function handleSourceSelect(type: SourceType) {
    setSourceType(type)
    // Clear other source selections
    if (type !== "script") setSelectedScriptId("")
    if (type !== "video") setSelectedProjectId("")
    if (type !== "keywords") setKeywords([])
  }

  function handleScriptSelect(scriptId: string) {
    setSelectedScriptId(scriptId)
    const selectedScript = videoScripts.find((s) => s.id === scriptId)
    if (selectedScript) {
      setScript(selectedScript.script_content)
      if (!title) setTitle(selectedScript.title)
    }
  }

  function handleProjectSelect(projectId: string) {
    setSelectedProjectId(projectId)
    const selectedProject = videoProjects.find((p) => p.id === projectId)
    if (selectedProject) {
      setScript(selectedProject.script_content)
      if (!title) setTitle(selectedProject.title)
    }
  }

  function canProceedFromStep(): boolean {
    switch (currentStep) {
      case 0: // Source
        if (sourceType === "script") return !!selectedScriptId
        if (sourceType === "video") return !!selectedProjectId
        if (sourceType === "keywords") return keywords.length > 0
        return false
      case 1: // Script
        return !!title && (!!script || keywords.length > 0)
      case 2: // Voice
        return true // Voice has default
      case 3: // Template
        return true // Template is optional
      case 4: // Publish
        return true // Channels are optional
      default:
        return false
    }
  }

  async function handleCreate() {
    setProcessing(true)
    try {
      const result = await createPodcastEpisode({
        title,
        description,
        script: sourceType === "keywords" ? undefined : script,
        keywords: sourceType === "keywords" ? keywords : undefined,
        templateId: templateId || undefined,
        voiceId: voiceId || undefined,
        category,
        sourceVideoProjectId: selectedProjectId || undefined,
        publishChannels: selectedChannels.length > 0 ? selectedChannels : undefined,
      })

      if (result.success) {
        onCreated()
      } else {
        console.error("Failed to create episode:", result.error)
        // Could show error toast here
      }
    } finally {
      setProcessing(false)
    }
  }

  const currentStepConfig = STEPS[currentStep]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Create New Episode</DialogTitle>
          <DialogDescription>
            Create a new podcast episode from a script, keywords, or existing video content.
          </DialogDescription>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center gap-1 py-2 overflow-x-auto">
          {STEPS.map((step, index) => {
            const Icon = step.icon
            const isActive = index === currentStep
            const isCompleted = index < currentStep

            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => index < currentStep && setCurrentStep(index)}
                  disabled={index > currentStep}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : isCompleted
                        ? "bg-gray-100 text-gray-900 hover:bg-gray-200"
                        : "text-gray-400"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{step.label}</span>
                </button>
                {index < STEPS.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-gray-300 mx-1" />
                )}
              </div>
            )
          })}
        </div>

        {/* Step Content */}
        <div className="flex-1 overflow-auto py-4 min-h-[300px]">
          {/* Step 1: Source */}
          {currentStep === 0 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">
                Choose the source for your podcast content.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <button
                  onClick={() => handleSourceSelect("keywords")}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    sourceType === "keywords"
                      ? "border-primary bg-primary/5"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Sparkles className="h-6 w-6 mb-2 text-primary" />
                  <div className="font-medium">From Keywords</div>
                  <p className="text-sm text-gray-500 mt-1">
                    Generate a script from keywords using AI
                  </p>
                </button>

                <button
                  onClick={() => handleSourceSelect("script")}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    sourceType === "script"
                      ? "border-primary bg-primary/5"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <FileText className="h-6 w-6 mb-2 text-primary" />
                  <div className="font-medium">From Script</div>
                  <p className="text-sm text-gray-500 mt-1">
                    Use an existing script from your library
                  </p>
                </button>

                <button
                  onClick={() => handleSourceSelect("video")}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    sourceType === "video"
                      ? "border-primary bg-primary/5"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <Video className="h-6 w-6 mb-2 text-primary" />
                  <div className="font-medium">From Video</div>
                  <p className="text-sm text-gray-500 mt-1">
                    Repurpose an existing video project
                  </p>
                </button>
              </div>

              {/* Source-specific inputs */}
              {sourceType === "keywords" && (
                <div className="flex flex-col gap-3 mt-4">
                  <Label>Keywords</Label>
                  <div className="flex gap-2">
                    <Input
                      value={keywordInput}
                      onChange={(e) => setKeywordInput(e.target.value)}
                      placeholder="Enter a keyword..."
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddKeyword())}
                    />
                    <Button type="button" variant="outline" onClick={handleAddKeyword}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {keywords.map((keyword) => (
                      <Badge
                        key={keyword}
                        variant="secondary"
                        className="cursor-pointer"
                        onClick={() => handleRemoveKeyword(keyword)}
                      >
                        {keyword} ×
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {sourceType === "script" && (
                <div className="flex flex-col gap-3 mt-4">
                  <Label>Select Script</Label>
                  {loadingContent ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    </div>
                  ) : videoScripts.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">
                      No scripts found in your library.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                      {videoScripts.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleScriptSelect(s.id)}
                          className={`p-3 border rounded-lg text-left transition-colors ${
                            selectedScriptId === s.id
                              ? "border-primary bg-primary/5"
                              : "border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          <div className="font-medium text-sm">{s.title}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {s.script_type} • {Math.ceil((s.duration_target_seconds || 180) / 60)} min
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {sourceType === "video" && (
                <div className="flex flex-col gap-3 mt-4">
                  <Label>Select Video Project</Label>
                  {loadingContent ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    </div>
                  ) : videoProjects.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-4">
                      No completed video projects found.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                      {videoProjects.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => handleProjectSelect(p.id)}
                          className={`p-3 border rounded-lg text-left transition-colors ${
                            selectedProjectId === p.id
                              ? "border-primary bg-primary/5"
                              : "border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          <div className="font-medium text-sm">{p.title}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {p.video_type} • {Math.ceil((p.duration_seconds || 180) / 60)} min
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Script */}
          {currentStep === 1 && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="title">Episode Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter episode title..."
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="description">Description</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleGenerateDescription}
                    disabled={generatingDesc || !title.trim()}
                    className="h-7 text-xs gap-1"
                  >
                    {generatingDesc ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    AI Generate
                  </Button>
                </div>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Enter episode description..."
                  rows={2}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="category">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {sourceType !== "keywords" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="script">Script</Label>
                  <Textarea
                    id="script"
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Enter or edit your podcast script..."
                    rows={8}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              {sourceType === "keywords" && (
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-600">
                    A script will be AI-generated from your keywords:
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {keywords.map((keyword) => (
                      <Badge key={keyword} variant="secondary">
                        {keyword}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Voice */}
          {currentStep === 2 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">
                Select the voice for your podcast narration.
              </p>

              <div className="flex flex-col gap-2">
                <Label htmlFor="voice">Voice</Label>
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select voice" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default Voice</SelectItem>
                    <SelectItem value="professional">Professional</SelectItem>
                    <SelectItem value="friendly">Friendly</SelectItem>
                    <SelectItem value="authoritative">Authoritative</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">
                  Voice settings can be customized further in your template.
                </p>
              </div>
            </div>
          )}

          {/* Step 4: Template */}
          {currentStep === 3 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">
                Optionally select a template to apply show branding and settings.
              </p>

              <div className="flex flex-col gap-2">
                <Label>Template (Optional)</Label>
                {templates.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">
                    No templates available. You can create templates in the Templates tab.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <button
                      onClick={() => setTemplateId("")}
                      className={`p-3 border rounded-lg text-left transition-colors ${
                        !templateId
                          ? "border-primary bg-primary/5"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className="font-medium text-sm">No Template</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Use default settings
                      </div>
                    </button>
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setTemplateId(t.id)}
                        className={`p-3 border rounded-lg text-left transition-colors ${
                          templateId === t.id
                            ? "border-primary bg-primary/5"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <div className="font-medium text-sm">{t.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {t.show_name} • {t.host_name}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 5: Publish */}
          {currentStep === 4 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-gray-600">
                Select distribution channels for this episode. You can also publish later.
              </p>

              <div className="flex flex-col gap-2">
                <Label>Distribution Channels (Optional)</Label>
                {channels.filter((ch) => ch.is_enabled).length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">
                    No distribution channels enabled. Configure channels in the Distribution tab.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {channels
                      .filter((ch) => ch.is_enabled)
                      .map((channel) => (
                        <label
                          key={channel.id}
                          className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                        >
                          <input
                            type="checkbox"
                            checked={selectedChannels.includes(channel.channel_name)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedChannels([...selectedChannels, channel.channel_name])
                              } else {
                                setSelectedChannels(
                                  selectedChannels.filter((c) => c !== channel.channel_name)
                                )
                              }
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                          />
                          <span className="text-sm font-medium capitalize">
                            {channel.channel_name}
                          </span>
                        </label>
                      ))}
                  </div>
                )}
              </div>

              {/* Summary */}
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <h4 className="font-medium text-sm mb-2">Episode Summary</h4>
                <div className="text-sm text-gray-600 space-y-1">
                  <p>
                    <span className="font-medium">Title:</span> {title}
                  </p>
                  <p>
                    <span className="font-medium">Source:</span>{" "}
                    {sourceType === "keywords" ? "AI Generated" : sourceType === "script" ? "Script" : "Video"}
                  </p>
                  <p>
                    <span className="font-medium">Category:</span>{" "}
                    {CATEGORIES.find((c) => c.value === category)?.label}
                  </p>
                  {templateId && (
                    <p>
                      <span className="font-medium">Template:</span>{" "}
                      {templates.find((t) => t.id === templateId)?.name}
                    </p>
                  )}
                  {selectedChannels.length > 0 && (
                    <p>
                      <span className="font-medium">Channels:</span>{" "}
                      {selectedChannels.join(", ")}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between border-t pt-4">
          <Button
            variant="outline"
            onClick={() => setCurrentStep(currentStep - 1)}
            disabled={currentStep === 0}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          {currentStep < STEPS.length - 1 ? (
            <Button
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!canProceedFromStep()}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={processing || !title}>
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Episode"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
