"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Video,
  Home,
  User,
  TrendingUp,
  Users,
  FileText,
  Sparkles,
  Wand2,
  Play,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Check,
  RefreshCw,
  Save,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
  Mic,
  Palette,
  Monitor,
  Smartphone,
  Square,
  Upload,
  Camera,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"
import {
  VideoBusinessPurposePicker,
  VideoContextPicker,
  RepurposeDestinationsCard,
  ListingVideoModeCard,
  SellerUpdateVideoModeCard,
} from "../components/business-context"
import type { VideoPurpose, RepurposeDestination, ListingVideoMode, SellerUpdateMode } from "../components/business-context"
import { generateVideoScript } from "@/app/actions/video/generate-script"
import { getAgentSettings } from "@/app/actions/agent-settings"
import { getHeyGenAvatars } from "@/app/actions/heygen-avatars"

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SCRIPT_TYPES = [
  {
    id: "property_tour",
    label: "Property Tour",
    icon: Home,
    description: "Showcase a listing with engaging narration",
    requiresListing: true,
  },
  {
    id: "buyer_education",
    label: "Buyer Education",
    icon: Users,
    description: "Educational content for home buyers",
    requiresListing: false,
  },
  {
    id: "market_update",
    label: "Market Update",
    icon: TrendingUp,
    description: "Local market analysis and trends",
    requiresListing: false,
  },
  {
    id: "agent_intro",
    label: "Agent Introduction",
    icon: User,
    description: "Personal brand introduction video",
    requiresListing: false,
  },
  {
    id: "listing_presentation",
    label: "Listing Presentation",
    icon: FileText,
    description: "Seller presentation for listing appointments",
    requiresListing: true,
  },
]

const QUALITY_PRESETS = [
  { id: "720p", label: "720p HD", description: "Good quality, faster render" },
  { id: "1080p", label: "1080p Full HD", description: "Recommended for most uses" },
  { id: "4k", label: "4K Ultra HD", description: "Highest quality, slower render" },
]

const OUTPUT_ORIENTATIONS = [
  { id: "landscape", label: "Landscape", icon: Monitor, aspect: "16:9", description: "YouTube, Website" },
  { id: "portrait", label: "Portrait", icon: Smartphone, aspect: "9:16", description: "TikTok, Reels, Stories" },
  { id: "square", label: "Square", icon: Square, aspect: "1:1", description: "Instagram, Facebook" },
]

const BACKGROUND_STYLES = [
  { id: "white", label: "Clean White", color: "#ffffff", previewStyle: { backgroundColor: "#ffffff" } },
  { id: "light_gray", label: "Light Gray", color: "#f5f5f5", previewStyle: { backgroundColor: "#f5f5f5" } },
  { id: "dark", label: "Dark", color: "#1a1a1a", previewStyle: { backgroundColor: "#1a1a1a" } },
  {
    id: "gradient_blue",
    label: "Blue Gradient",
    color: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    previewStyle: { background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  },
  {
    id: "office",
    label: "Office Background",
    color: "office",
    previewStyle: { background: "linear-gradient(135deg, #8B7355 0%, #A0956B 40%, #C4B48A 100%)" },
  },
  {
    id: "modern",
    label: "Modern Interior",
    color: "modern",
    previewStyle: { background: "linear-gradient(135deg, #e8e0d5 0%, #d4c5b0 50%, #b8a898 100%)" },
  },
  {
    id: "custom",
    label: "Custom Upload",
    color: "#e8f4fd",
    previewStyle: { background: "repeating-conic-gradient(#e8f4fd 0% 25%, #c7e1f5 0% 50%) 0 0 / 10px 10px" },
  },
]

// ─── COMPONENT ────────────────────────────────────────────────────────────────

interface VideoCreatePageProps {
  heygenConfigured?: boolean
}

export default function VideoCreatePage({ heygenConfigured = true }: VideoCreatePageProps) {
  const router = useRouter()
  const { user, userContext } = useAuth()
  // useAuth does not return a `brokerage` object — derive it from userContext
  const brokerage = userContext?.brokerageId ? { id: userContext.brokerageId } : null
  const supabase = createClient()

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0) // Start at step 0 (business context)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Business context state (Step 0)
  const [selectedPurpose, setSelectedPurpose] = useState<VideoPurpose | null>(null)
  const [selectedContextId, setSelectedContextId] = useState<string>("")
  const [selectedContextType, setSelectedContextType] = useState<"listing" | "contact" | "homeowner" | "market" | "none">("none")
  const [selectedContextData, setSelectedContextData] = useState<any>(null)
  const [repurposeDestinations, setRepurposeDestinations] = useState<RepurposeDestination[]>([])
  const [listingVideoMode, setListingVideoMode] = useState<ListingVideoMode | null>(null)
  const [sellerUpdateMode, setSellerUpdateMode] = useState<SellerUpdateMode | null>(null)

  // Step 1: Script Selection
  const [scriptSource, setScriptSource] = useState<"library" | "custom">("library")
  const [selectedScript, setSelectedScript] = useState<string>("")
  const [customScript, setCustomScript] = useState<string>("")
  const [scriptTitle, setScriptTitle] = useState<string>("")

  // AI Script generation (Step 1 custom tab)
  const [aiScriptDescription, setAiScriptDescription] = useState<string>("")
  const [aiScriptVideoType, setAiScriptVideoType] = useState<string>("custom")
  const [aiScriptTone, setAiScriptTone] = useState<"professional" | "friendly" | "luxury" | "educational">("professional")
  const [aiScriptDuration, setAiScriptDuration] = useState<number>(60)
  const [isAiGenerating, setIsAiGenerating] = useState(false)
  const [aiScriptError, setAiScriptError] = useState<string | null>(null)

  // Step 2: Avatar & Voice
  const [selectedAvatar, setSelectedAvatar] = useState<string>("")
  const [selectedVoice, setSelectedVoice] = useState<string>("")

  // Step 3: Style & Output
  const [backgroundStyle, setBackgroundStyle] = useState<string>("white")
  const [qualityPreset, setQualityPreset] = useState<string>("1080p")
  const [outputOrientation, setOutputOrientation] = useState<string>("landscape")
  const [brandingPresetId, setBrandingPresetId] = useState<string>("")

  // Step 3: Custom background upload / webcam capture
  const [customBgUrl, setCustomBgUrl] = useState<string>("")
  const [isUploadingBg, setIsUploadingBg] = useState(false)
  const [showWebcamCapture, setShowWebcamCapture] = useState(false)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bgFileInputRef = useRef<HTMLInputElement>(null)

  // Data from DB
  const [scripts, setScripts] = useState<any[]>([])
  const [avatars, setAvatars] = useState<any[]>([])
  const [voiceProfiles, setVoiceProfiles] = useState<any[]>([])
  const [brandingPresets, setBrandingPresets] = useState<any[]>([])
  const [connectedPlatforms, setConnectedPlatforms] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // Resolved agents.id (FK) — distinct from auth users.id
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(null)

  // Word count helpers
  const activeScript = scriptSource === "library" 
    ? scripts.find(s => s.id === selectedScript)?.script_content || ""
    : customScript
  const wordCount = activeScript.split(/\s+/).filter(Boolean).length
  const estimatedDuration = Math.ceil(wordCount / 2.5)

  // ─── Load Data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    async function loadData() {
      if (!brokerage?.id) return

      try {
        // Load approved scripts from library
        const { data: scriptsData } = await supabase
          .from("video_scripts_library")
          .select("id, title, script_content, script_type, approval_status, duration_target_seconds")
          .eq("brokerage_id", brokerage.id)
          .eq("is_active", true)
          .eq("approval_status", "approved")
          .order("created_at", { ascending: false })
          .limit(50)

        setScripts(scriptsData || [])

        // Load agent voice profiles (maps to agents.id, not users.id)
        // First get agent record for current user
        const { data: agentData } = await supabase
          .from("agents")
          .select("id")
          .eq("user_id", user?.id)
          .maybeSingle()

        let clonedVoiceProfiles: any[] = []
        if (agentData?.id) {
          setResolvedAgentId(agentData.id)

          const { data: voiceData } = await supabase
            .from("agent_voice_profiles")
            .select("*")
            .eq("agent_id", agentData.id)
            .eq("training_status", "completed")
            .order("is_default", { ascending: false })

          clonedVoiceProfiles = voiceData || []
          setVoiceProfiles(clonedVoiceProfiles)
        }

        // Load branding presets — use agents.id (FK), not auth user id
        const { data: brandingData } = await supabase
          .from("video_branding_presets")
          .select("*")
          .or(`agent_id.eq.${agentData?.id ?? user?.id},is_default.eq.true`)
          .order("is_default", { ascending: false })

        setBrandingPresets(brandingData || [])

        // HeyGen default avatars (fallback when API call fails)
        const defaultAvatars = [
          { id: "Angela-inblackskirt-20220820", name: "Angela", style: "Professional", thumbnailUrl: undefined },
          { id: "Daisy-inskirt-20220818", name: "Daisy", style: "Friendly", thumbnailUrl: undefined },
          { id: "Josh_lite3_20230714", name: "Josh", style: "Casual", thumbnailUrl: undefined },
          { id: "Kristin_public_3_20240108", name: "Kristin", style: "Professional", thumbnailUrl: undefined },
          { id: "Wayne_20240711", name: "Wayne", style: "Executive", thumbnailUrl: undefined },
        ]

        // Fetch all available HeyGen avatars from live API
        const heygenResult = await getHeyGenAvatars()
        const rawAvatars = heygenResult.success && heygenResult.avatars.length > 0
          ? heygenResult.avatars.map((av) => ({
              id: av.avatar_id,
              name: av.avatar_name,
              style: av.gender ?? "Public",
              thumbnailUrl: av.preview_image_url ?? undefined,
            }))
          : defaultAvatars
        const seenAvatarIds = new Set<string>()
        const liveAvatars = rawAvatars.filter(av => !seenAvatarIds.has(av.id) && seenAvatarIds.add(av.id))

        // Load per-user avatar + voice configured during onboarding
        if (user?.id) {
          const agentSettings = await getAgentSettings(user.id)
          if (agentSettings.avatarId) {
            // Personal avatar goes first, live/default avatars as fallbacks
            setAvatars([
              { id: agentSettings.avatarId, name: "My Avatar", style: "Personal", thumbnailUrl: undefined },
              ...liveAvatars.filter(av => av.id !== agentSettings.avatarId),
            ])
            setSelectedAvatar(agentSettings.avatarId)
          } else {
            setAvatars(liveAvatars)
          }
          // Pre-select configured voice ID if no cloned voice profiles exist
          if (agentSettings.voiceId && clonedVoiceProfiles.length === 0) {
            setSelectedVoice(agentSettings.voiceId)
          }

          // Load connected social platforms for repurpose destination indicators
          const { data: socialData } = await supabase
            .from("social_media_accounts")
            .select("platform")
            .eq("user_id", user.id)
            .eq("is_active", true)

          const platforms = (socialData ?? []).map((a: any) => a.platform as string)
          setConnectedPlatforms(platforms)
        } else {
          setAvatars(defaultAvatars)
        }
      } catch (err) {
        console.error("Error loading data:", err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [brokerage?.id, user?.id, supabase])

  // ─── Generate Video ─────────────────────────────────────────────────────────

  async function handleGenerateVideo() {
    if (!brokerage?.id || !user?.id) return

    setIsSubmitting(true)
    setError(null)

    try {
      const script = scriptSource === "library"
        ? scripts.find(s => s.id === selectedScript)?.script_content
        : customScript

      if (!script) {
        throw new Error("Script content is required")
      }

      // 1. Create ai_video_projects record
      const { data: project, error: projectError } = await supabase
        .from("ai_video_projects")
        .insert({
          agent_id: resolvedAgentId,
          brokerage_id: brokerage.id,
          title: scriptTitle || `Video — ${new Date().toLocaleDateString()}`,
          script_content: script,
          video_type: scriptSource === "library"
            ? scripts.find(s => s.id === selectedScript)?.script_type ?? "custom"
            : aiScriptVideoType ?? "custom",
          status: "pending",
          heygen_status: "pending",
          heygen_avatar_id: selectedAvatar || null,
          heygen_voice_id: selectedVoice || null,
          video_provider: "heygen",
          // listing_id is only relevant when the user explicitly selected a listing as the
          // video context. Other context types (contact, homeowner, market, none) do not
          // involve a listing and must leave this null.
          listing_id: selectedContextType === "listing" && selectedContextId
            ? selectedContextId
            : null,
          provider_metadata: {
            quality_preset: qualityPreset,
            output_orientation: outputOrientation,
            background_style: backgroundStyle,
            branding_preset_id: brandingPresetId || null,
            aspect_ratio: OUTPUT_ORIENTATIONS.find(o => o.id === outputOrientation)?.aspect ?? "16:9",
          },
        })
        .select()
        .maybeSingle()

      if (projectError || !project) throw projectError ?? new Error("Failed to create video project")

      // 2. Submit to HeyGen via API
      const response = await fetch("/api/heygen/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script,
          avatar_id: selectedAvatar,
          voice_id: selectedVoice,
          video_project_id: project.id,
          brokerage_id: brokerage.id,
          user_id: user.id,
          script_id: scriptSource === "library" ? selectedScript : null,
          branding_preset_id: brandingPresetId || null,
          quality_preset: qualityPreset,
          output_orientation: outputOrientation,
          aspect_ratio: OUTPUT_ORIENTATIONS.find(o => o.id === outputOrientation)?.aspect || "16:9",
          background: backgroundStyle === "custom" && customBgUrl
            ? { type: "image", value: customBgUrl }
            : (() => {
                const bgPreset = BACKGROUND_STYLES.find(b => b.id === backgroundStyle)
                const bgColorValue = bgPreset?.color ?? "#ffffff"
                return {
                  type: bgColorValue.startsWith("linear") || bgColorValue.startsWith("repeating") || ["office", "modern"].includes(backgroundStyle) ? "image" : "color",
                  value: bgColorValue,
                }
              })(),
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        // Update project status on failure
        await supabase
          .from("ai_video_projects")
          .update({ status: "failed", error_message: result.error })
          .eq("id", project.id)
        throw new Error(result.error || "Failed to generate video")
      }

      // Redirect to board
      router.push("/dashboard/videos/board")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  // ─── Steps Configuration ────────────────────────────────────────────────────

  const steps = [
    { number: 0, label: "Purpose" },
    { number: 1, label: "Script" },
    { number: 2, label: "Avatar & Voice" },
    { number: 3, label: "Style & Quality" },
    { number: 4, label: "Review & Generate" },
  ]

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        // Purpose step - need purpose selected, and context if required
        if (!selectedPurpose) return false
        const needsContext = ["listing_launch", "seller_update", "portal_video", "homeowner_update", "market_update"].includes(selectedPurpose)
        if (needsContext && !selectedContextId) return false
        // For listing purposes, also need mode selected
        if (selectedPurpose === "listing_launch" && !listingVideoMode) return false
        if (selectedPurpose === "seller_update" && !sellerUpdateMode) return false
        return true
      case 1:
        return scriptSource === "library" ? !!selectedScript : customScript.trim().length > 20
      case 2:
        // Voice is required only if profiles exist; if none are configured the user
        // can still proceed (HeyGen will use its default voice).
        if (!selectedAvatar) return false
        if (voiceProfiles.length > 0 && !selectedVoice) return false
        return true
      case 3:
        return !!backgroundStyle && !!qualityPreset && !!outputOrientation &&
          (backgroundStyle !== "custom" || !!customBgUrl)
      default:
        return true
    }
  }

  // Handle context selection
  const handleSelectContext = (id: string, type: "listing" | "contact" | "homeowner" | "market" | "none", data: any) => {
    setSelectedContextId(id)
    setSelectedContextType(type)
    setSelectedContextData(data)
  }

  // Toggle repurpose destination
  const handleToggleDestination = (dest: RepurposeDestination) => {
    setRepurposeDestinations((prev) =>
      prev.includes(dest) ? prev.filter((d) => d !== dest) : [...prev, dest]
    )
  }

  // ─── Custom Background Handlers ────────────────────────────────────────────

  const stopWebcam = useCallback(() => {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop())
      setWebcamStream(null)
    }
    setShowWebcamCapture(false)
  }, [webcamStream])

  // Cleanup webcam on unmount
  useEffect(() => () => { webcamStream?.getTracks().forEach((t) => t.stop()) }, [webcamStream])

  // Stop webcam tracks when leaving the style step (step 3)
  useEffect(() => {
    if (currentStep !== 3 && webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop())
      setWebcamStream(null)
      setShowWebcamCapture(false)
    }
  }, [currentStep, webcamStream])

  const handleBgFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/")) {
      setError("Please select an image file (JPG, PNG, WebP)")
      return
    }
    setIsUploadingBg(true)
    try {
      const ext = file.name.split(".").pop() ?? "jpg"
      const path = `video-backgrounds/${user?.id ?? "anon"}/${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from("listing-media")
        .upload(path, file, { upsert: true, contentType: file.type })
      if (uploadError) throw uploadError
      const { data: { publicUrl } } = supabase.storage.from("listing-media").getPublicUrl(path)
      setCustomBgUrl(publicUrl)
      setBackgroundStyle("custom")
    } catch (err: any) {
      setError(`Background upload failed: ${err.message}`)
    } finally {
      setIsUploadingBg(false)
      if (bgFileInputRef.current) bgFileInputRef.current.value = ""
    }
  }

  const startWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
      setWebcamStream(stream)
      setShowWebcamCapture(true)
      // Assign stream after state update so the video element is rendered
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      }, 50)
    } catch {
      setError("Camera access denied. Allow camera access to capture a background photo.")
    }
  }

  const captureWebcamPhoto = async () => {
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    stopWebcam()
    setIsUploadingBg(true)
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Capture failed"))), "image/jpeg", 0.92)
      })
      const path = `video-backgrounds/${user?.id ?? "anon"}/${Date.now()}.jpg`
      const { error: uploadError } = await supabase.storage
        .from("listing-media")
        .upload(path, blob, { upsert: true, contentType: "image/jpeg" })
      if (uploadError) throw uploadError
      const { data: { publicUrl } } = supabase.storage.from("listing-media").getPublicUrl(path)
      setCustomBgUrl(publicUrl)
      setBackgroundStyle("custom")
    } catch (err: any) {
      setError(`Background capture failed: ${err.message}`)
    } finally {
      setIsUploadingBg(false)
    }
  }

  // Generate script from Step 0 context — calls Claude via server action
  const handleGenerateScript = async () => {
    if (!selectedPurpose || !brokerage?.id || !user?.id) return
    setIsGenerating(true)
    setError(null)
    try {
      const purposeToVideoType: Record<string, string> = {
        listing_launch: "property_tour",
        seller_update: "seller_update",
        market_update: "market_update",
        agent_brand: "agent_intro",
        portal_video: "tips",
        homeowner_update: "seller_update",
        just_sold: "tips",
        farming: "tips",
      }
      const videoType = (purposeToVideoType[selectedPurpose] ?? "custom") as any

      let description = `Create a ${selectedPurpose.replace(/_/g, " ")} video`
      if (selectedContextData?.address) {
        description += ` for the property at ${selectedContextData.address}, ${selectedContextData.city ?? ""}`
      }
      if (selectedContextId && selectedContextType === "market") {
        description += ` covering the ${selectedContextId} market area`
      }

      const result = await generateVideoScript({
        brokerageId: brokerage.id,
        agentId: user.id,
        userId: user.id,
        description,
        videoType,
        tone: "professional",
        targetDurationSeconds: 60,
        // listingContext is only injected when the user actually selected a listing —
        // other context types (contact, homeowner, market) don't carry listing data.
        listingContext: selectedContextType === "listing" && selectedContextData?.address
          ? {
              address: selectedContextData.address,
              city: selectedContextData.city ?? "",
              state: selectedContextData.state ?? "",
              listPrice: selectedContextData.list_price ?? 0,
              bedrooms: selectedContextData.bedrooms,
              bathrooms: selectedContextData.bathrooms,
              sqft: selectedContextData.sqft,
            }
          : undefined,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to generate script")
        return
      }

      setCustomScript(result.script!)
      setScriptSource("custom")
      setScriptTitle(`${selectedPurpose.replace(/_/g, " ")} — ${new Date().toLocaleDateString()}`)
      setCurrentStep(1)
    } catch (err: any) {
      setError(err.message ?? "Script generation failed")
    } finally {
      setIsGenerating(false)
    }
  }

  // Generate AI script from Step 1 custom tab inputs
  const handleAiGenerateFromStep1 = async () => {
    if (!brokerage?.id || !user?.id || !aiScriptDescription.trim()) return
    setIsAiGenerating(true)
    setAiScriptError(null)
    try {
      const result = await generateVideoScript({
        brokerageId: brokerage.id,
        agentId: user.id,
        userId: user.id,
        description: aiScriptDescription,
        videoType: aiScriptVideoType as any,
        tone: aiScriptTone,
        targetDurationSeconds: aiScriptDuration,
        // Only pass listing context if the Step 0 context was a listing selection
        listingContext: selectedContextType === "listing" && selectedContextData?.address
          ? {
              address: selectedContextData.address,
              city: selectedContextData.city ?? "",
              state: selectedContextData.state ?? "",
              listPrice: selectedContextData.list_price ?? 0,
              bedrooms: selectedContextData.bedrooms,
              bathrooms: selectedContextData.bathrooms,
              sqft: selectedContextData.sqft,
            }
          : undefined,
        saveToLibrary: false,
      })

      if (!result.success) {
        setAiScriptError(result.error ?? "Generation failed")
        return
      }

      setCustomScript(result.script!)
      if (!scriptTitle) {
        setScriptTitle(`AI Script — ${aiScriptVideoType.replace(/_/g, " ")} — ${new Date().toLocaleDateString()}`)
      }
    } catch (err: any) {
      setAiScriptError(err.message ?? "Script generation failed")
    } finally {
      setIsAiGenerating(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          <Button variant="outline" onClick={() => router.back()} className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-3xl font-bold text-foreground">Create AI Video</h1>
          <p className="text-muted-foreground mt-1">
            Generate professional avatar videos with kernel governance
          </p>
        </div>

        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div
                  className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
                    currentStep > step.number
                      ? "bg-green-600 text-white"
                      : currentStep === step.number
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {currentStep > step.number ? <Check className="h-5 w-5" /> : step.number}
                </div>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "w-16 md:w-24 h-1 mx-2",
                      currentStep > step.number ? "bg-green-600" : "bg-muted"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 px-1">
            {steps.map((step) => (
              <span
                key={step.number}
                className={cn(
                  "text-xs",
                  currentStep >= step.number ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {step.label}
              </span>
            ))}
          </div>
        </div>

        {/* HeyGen not configured — non-blocking notice */}
        {!heygenConfigured && (
          <Alert className="mb-6 border-amber-200 bg-amber-50 text-amber-900">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertTitle className="text-amber-800">HeyGen Not Configured</AlertTitle>
            <AlertDescription className="text-amber-700">
              The HeyGen API key is not set. You can still build and save your video project — it will be queued once HeyGen is connected. Admins: configure in{" "}
              <a href="/settings/integrations" className="underline font-medium">
                Settings &rarr; Integrations
              </a>
              . To set your personal avatar and voice ID, visit your{" "}
              <a href="/dashboard/profile" className="underline font-medium">
                Profile Settings
              </a>
              .
            </AlertDescription>
          </Alert>
        )}

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Step Content */}
        <Card className="mb-6">
          <CardContent className="p-6">
            {/* Step 0: Business Purpose & Context */}
            {currentStep === 0 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">What video do you want to create?</h2>
                  <p className="text-muted-foreground">
                    Select a business purpose and we will generate the right script and delivery options
                  </p>
                </div>

                {/* Purpose Picker */}
                <VideoBusinessPurposePicker
                  selectedPurpose={selectedPurpose}
                  onSelectPurpose={setSelectedPurpose}
                />

                {/* Context Picker (shows based on purpose) */}
                {selectedPurpose && (
                  <VideoContextPicker
                    purpose={selectedPurpose}
                    brokerageId={brokerage?.id || ""}
                    agentId={user?.id || ""}
                    selectedContextId={selectedContextId}
                    selectedContextType={selectedContextType}
                    onSelectContext={handleSelectContext}
                  />
                )}

                {/* Listing Video Mode (if listing purpose) */}
                {selectedPurpose === "listing_launch" && selectedContextData && (
                  <ListingVideoModeCard
                    listingData={selectedContextData}
                    selectedMode={listingVideoMode}
                    onSelectMode={setListingVideoMode}
                    onGenerateScript={handleGenerateScript}
                    isGenerating={isGenerating}
                  />
                )}

                {/* Seller Update Mode (if seller update purpose) */}
                {selectedPurpose === "seller_update" && selectedContextData && (
                  <SellerUpdateVideoModeCard
                    listingData={selectedContextData}
                    selectedMode={sellerUpdateMode}
                    onSelectMode={setSellerUpdateMode}
                    onGenerateScript={handleGenerateScript}
                    isGenerating={isGenerating}
                  />
                )}

                {/* Repurpose Destinations */}
                {selectedPurpose && (
                  <RepurposeDestinationsCard
                    purpose={selectedPurpose}
                    selectedDestinations={repurposeDestinations}
                    onToggleDestination={handleToggleDestination}
                    connectedPlatforms={connectedPlatforms}
                    listingId={selectedContextType === "listing" ? selectedContextId : undefined}
                    contactId={selectedContextType === "contact" || selectedContextType === "homeowner" ? selectedContextId : undefined}
                  />
                )}

                {/* Quick Generate for non-listing purposes */}
                {selectedPurpose && !["listing_launch", "seller_update"].includes(selectedPurpose) && selectedContextId && (
                  <Button onClick={handleGenerateScript} disabled={isGenerating} className="w-full">
                    <Sparkles className="h-4 w-4 mr-2" />
                    {isGenerating ? "Generating..." : "Generate Script for Me"}
                  </Button>
                )}
              </div>
            )}

            {/* Step 1: Script Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Select Your Script</h2>
                  <p className="text-muted-foreground">
                    Choose an approved script from your library or write a custom one
                  </p>
                </div>

                <Tabs value={scriptSource} onValueChange={(v) => setScriptSource(v as "library" | "custom")}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="library">
                      <FileText className="h-4 w-4 mr-2" />
                      Script Library
                    </TabsTrigger>
                    <TabsTrigger value="custom">
                      <Wand2 className="h-4 w-4 mr-2" />
                      Custom Script
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="library" className="mt-4 space-y-4">
                    {scripts.length === 0 ? (
                      <Alert>
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>No Approved Scripts</AlertTitle>
                        <AlertDescription>
                          You need at least one approved script to generate a video.
                          <Button variant="link" className="p-0 h-auto ml-1" onClick={() => router.push("/dashboard/videos/library")}>
                            Go to Script Library
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Select value={selectedScript} onValueChange={setSelectedScript}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an approved script" />
                        </SelectTrigger>
                        <SelectContent>
                          {scripts.map((script) => (
                            <SelectItem key={script.id} value={script.id}>
                              <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-green-600" />
                                {script.title}
                                <span className="text-muted-foreground text-xs">
                                  ({script.duration_target_seconds || "~"}s)
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    {selectedScript && (
                      <div className="p-4 bg-muted rounded-lg">
                        <Label className="text-sm mb-2 block">Script Preview</Label>
                        <p className="text-sm whitespace-pre-wrap line-clamp-6">
                          {scripts.find(s => s.id === selectedScript)?.script_content}
                        </p>
                        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                          <span>{wordCount} words</span>
                          <span>~{estimatedDuration}s duration</span>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="custom" className="mt-4 space-y-4">
                    {/* AI Script Generation Panel */}
                    <Card className="border border-primary/20 bg-primary/5">
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <Sparkles className="h-4 w-4 text-primary" />
                          <span className="font-medium text-sm">Generate Script with AI</span>
                        </div>

                        <div className="space-y-2">
                          <Label className="text-xs text-muted-foreground">What is this video about?</Label>
                          <Textarea
                            value={aiScriptDescription}
                            onChange={(e) => setAiScriptDescription(e.target.value)}
                            placeholder="e.g. Introduce myself to first-time buyers, explain the offer process, and invite them to schedule a call"
                            rows={2}
                            className="text-sm"
                          />
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Video type</Label>
                            <Select value={aiScriptVideoType} onValueChange={setAiScriptVideoType}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {SCRIPT_TYPES.map(t => (
                                  <SelectItem key={t.id} value={t.id} className="text-xs">{t.label}</SelectItem>
                                ))}
                                <SelectItem value="tips" className="text-xs">Tips</SelectItem>
                                <SelectItem value="testimonial" className="text-xs">Testimonial</SelectItem>
                                <SelectItem value="custom" className="text-xs">Custom</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Tone</Label>
                            <Select value={aiScriptTone} onValueChange={(v) => setAiScriptTone(v as any)}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="professional" className="text-xs">Professional</SelectItem>
                                <SelectItem value="friendly" className="text-xs">Friendly</SelectItem>
                                <SelectItem value="luxury" className="text-xs">Luxury</SelectItem>
                                <SelectItem value="educational" className="text-xs">Educational</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Duration</Label>
                            <Select
                              value={String(aiScriptDuration)}
                              onValueChange={(v) => setAiScriptDuration(Number(v))}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="15" className="text-xs">15 sec</SelectItem>
                                <SelectItem value="30" className="text-xs">30 sec</SelectItem>
                                <SelectItem value="60" className="text-xs">60 sec</SelectItem>
                                <SelectItem value="90" className="text-xs">90 sec</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {aiScriptError && (
                          <p className="text-xs text-destructive">{aiScriptError}</p>
                        )}

                        <Button
                          onClick={handleAiGenerateFromStep1}
                          disabled={isAiGenerating || !aiScriptDescription.trim()}
                          size="sm"
                          className="w-full"
                        >
                          {isAiGenerating ? (
                            <><Loader2 className="h-3 w-3 mr-2 animate-spin" />Generating with Claude...</>
                          ) : (
                            <><Sparkles className="h-3 w-3 mr-2" />Generate Script</>
                          )}
                        </Button>
                      </CardContent>
                    </Card>

                    <Alert>
                      <Shield className="h-4 w-4" />
                      <AlertTitle>Script Compliance</AlertTitle>
                      <AlertDescription>
                        All scripts (AI and manual) are checked against Fair Housing and brand compliance before video generation.
                      </AlertDescription>
                    </Alert>

                    <div className="space-y-2">
                      <Label>Script Title</Label>
                      <Input
                        value={scriptTitle}
                        onChange={(e) => setScriptTitle(e.target.value)}
                        placeholder="Enter a title for this video"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Script Content</Label>
                        <span className="text-xs text-muted-foreground">
                          {wordCount} words / ~{estimatedDuration}s
                        </span>
                      </div>
                      <Textarea
                        value={customScript}
                        onChange={(e) => setCustomScript(e.target.value)}
                        placeholder="Write your video script here... or generate one above."
                        rows={10}
                        className="font-mono text-sm"
                      />
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            )}

            {/* Step 2: Avatar & Voice */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Choose Avatar & Voice</h2>
                  <p className="text-muted-foreground">
                    Select who will present your video and which voice to use
                  </p>
                </div>

                {/* Avatar Selection */}
                <div className="space-y-3">
                  <Label>Avatar</Label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {avatars.map((avatar) => (
                      <div
                        key={avatar.id}
                        onClick={() => setSelectedAvatar(avatar.id)}
                        className={cn(
                          "p-4 rounded-lg border-2 cursor-pointer transition-all text-center",
                          selectedAvatar === avatar.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <div className="w-16 h-16 rounded-full bg-muted mx-auto mb-2 flex items-center justify-center overflow-hidden">
                          {avatar.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={avatar.thumbnailUrl}
                              alt={avatar.name}
                              className="w-16 h-16 rounded-full object-cover mx-auto"
                            />
                          ) : (
                            <User className="w-8 h-8 mx-auto text-muted-foreground" />
                          )}
                        </div>
                        <p className="font-medium">{avatar.name}</p>
                        <p className="text-xs text-muted-foreground">{avatar.style}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 text-center">
                    <a href="/dashboard/videos/voice" className="underline hover:text-foreground">
                      + Create your personal avatar
                    </a>
                  </p>
                </div>

                {/* Voice Selection */}
                <div className="space-y-3">
                  <Label>Voice</Label>
                  {voiceProfiles.length > 0 ? (
                    <div className="space-y-2">
                      {voiceProfiles.map((voice) => (
                        <div
                          key={voice.id}
                          onClick={() => setSelectedVoice(voice.heygen_voice_clone_id || voice.id)}
                          className={cn(
                            "p-4 rounded-lg border-2 cursor-pointer transition-all flex items-center gap-4",
                            selectedVoice === (voice.heygen_voice_clone_id || voice.id)
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/50"
                          )}
                        >
                          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                            <Mic className="h-6 w-6 text-muted-foreground" />
                          </div>
                          <div>
                            <p className="font-medium">{voice.profile_name}</p>
                            <div className="flex items-center gap-2">
                              {voice.is_default && (
                                <Badge variant="secondary" className="text-xs">Default</Badge>
                              )}
                              <span className="text-xs text-muted-foreground">
                                Quality: {(voice.quality_score * 100).toFixed(0)}%
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Alert>
                      <Mic className="h-4 w-4" />
                      <AlertTitle>No Voice Profiles</AlertTitle>
                      <AlertDescription>
                        You have not set up any voice profiles yet. Using default HeyGen voices.
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Default HeyGen voices if no custom profiles */}
                  {voiceProfiles.length === 0 && (
                    <Alert>
                      <Mic className="h-4 w-4" />
                      <AlertTitle>No Voice Profiles</AlertTitle>
                      <AlertDescription>
                        You have not set up any voice profiles yet. Using default HeyGen voices.
                        <Button
                          variant="link"
                          className="p-0 h-auto ml-1"
                          onClick={() => router.push("/dashboard/videos/voice")}
                        >
                          Create Voice Clone
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </div>
            )}

            {/* Step 3: Style & Quality */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Style & Output Settings</h2>
                  <p className="text-muted-foreground">
                    Configure the look and quality of your video
                  </p>
                </div>

                {/* Background Style */}
                <div className="space-y-3">
                  <Label>Background Style</Label>
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                    {BACKGROUND_STYLES.map((bg) => (
                      <div
                        key={bg.id}
                        onClick={() => { if (bg.id !== "custom") stopWebcam(); setBackgroundStyle(bg.id) }}
                        className={cn(
                          "p-3 rounded-lg border-2 cursor-pointer transition-all text-center",
                          backgroundStyle === bg.id
                            ? "border-primary"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <div
                          className="w-full h-12 rounded mb-2"
                          style={bg.previewStyle}
                        />
                        <p className="text-xs font-medium truncate">{bg.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Custom Background Upload (shown when "Custom Upload" is selected) */}
                {backgroundStyle === "custom" && (
                  <div className="space-y-3 p-4 rounded-lg border bg-muted/30">
                    <Label className="text-sm font-medium">Upload or Capture Your Background</Label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => bgFileInputRef.current?.click()}
                        disabled={isUploadingBg}
                        className="gap-2"
                      >
                        {isUploadingBg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        Upload Image
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={showWebcamCapture ? stopWebcam : startWebcam}
                        disabled={isUploadingBg}
                        className="gap-2"
                      >
                        {showWebcamCapture ? <X className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
                        {showWebcamCapture ? "Cancel Webcam" : "Use Webcam"}
                      </Button>
                      {customBgUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => { setCustomBgUrl(""); setBackgroundStyle("white") }}
                          className="gap-2 text-destructive hover:text-destructive"
                        >
                          <X className="h-4 w-4" /> Clear
                        </Button>
                      )}
                    </div>

                    {/* Hidden file input */}
                    <input
                      ref={bgFileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handleBgFileUpload}
                    />

                    {/* Live webcam feed */}
                    {showWebcamCapture && (
                      <div className="space-y-2">
                        <video
                          ref={videoRef}
                          autoPlay
                          muted
                          playsInline
                          className="w-full max-h-52 rounded-lg object-cover border"
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={captureWebcamPhoto}
                          disabled={isUploadingBg}
                          className="w-full gap-2"
                        >
                          {isUploadingBg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                          Capture as Background
                        </Button>
                      </div>
                    )}

                    {/* Off-screen canvas for frame capture */}
                    <canvas ref={canvasRef} className="hidden" />

                    {/* Preview uploaded/captured image */}
                    {customBgUrl && (
                      <div className="relative w-full h-28 rounded-lg overflow-hidden border">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={customBgUrl} alt="Custom background preview" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <Badge className="bg-primary text-primary-foreground">Custom Background Active</Badge>
                        </div>
                      </div>
                    )}

                    {!customBgUrl && !showWebcamCapture && !isUploadingBg && (
                      <p className="text-xs text-muted-foreground">
                        Upload a JPG, PNG, or WebP image to use as your video background, or use your webcam to capture a photo.
                      </p>
                    )}
                  </div>
                )}

                {/* Output Orientation */}
                <div className="space-y-3">
                  <Label>Output Orientation</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {OUTPUT_ORIENTATIONS.map((orientation) => {
                      const Icon = orientation.icon
                      return (
                        <div
                          key={orientation.id}
                          onClick={() => setOutputOrientation(orientation.id)}
                          className={cn(
                            "p-4 rounded-lg border-2 cursor-pointer transition-all text-center",
                            outputOrientation === orientation.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/50"
                          )}
                        >
                          <Icon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                          <p className="font-medium">{orientation.label}</p>
                          <p className="text-xs text-muted-foreground">{orientation.aspect}</p>
                          <p className="text-xs text-muted-foreground">{orientation.description}</p>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Quality Preset */}
                <div className="space-y-3">
                  <Label>Quality Preset</Label>
                  <RadioGroup value={qualityPreset} onValueChange={setQualityPreset}>
                    {QUALITY_PRESETS.map((preset) => (
                      <Label
                        key={preset.id}
                        htmlFor={preset.id}
                        className={cn(
                          "flex items-center gap-4 p-4 rounded-lg border-2 cursor-pointer transition-colors",
                          qualityPreset === preset.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <RadioGroupItem value={preset.id} id={preset.id} />
                        <div>
                          <p className="font-medium">{preset.label}</p>
                          <p className="text-sm text-muted-foreground">{preset.description}</p>
                        </div>
                        {preset.id === "1080p" && (
                          <Badge variant="secondary" className="ml-auto">Recommended</Badge>
                        )}
                      </Label>
                    ))}
                  </RadioGroup>
                </div>

                {/* Branding Preset (optional) */}
                {brandingPresets.length > 0 && (
                  <div className="space-y-3">
                    <Label>Branding Preset (Optional)</Label>
                    <Select value={brandingPresetId} onValueChange={setBrandingPresetId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a branding preset" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">No branding</SelectItem>
                        {brandingPresets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            <div className="flex items-center gap-2">
                              <Palette className="h-4 w-4" />
                              {preset.preset_name}
                              {preset.is_default && <Badge variant="outline" className="text-xs">Default</Badge>}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {/* Step 4: Review & Generate */}
            {currentStep === 4 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Review & Generate</h2>
                  <p className="text-muted-foreground">
                    Review your settings and generate your video
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Script Summary */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Script
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm line-clamp-4">{activeScript}</p>
                      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{wordCount} words</span>
                        <span>~{estimatedDuration}s</span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Avatar & Voice Summary */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <User className="h-4 w-4" />
                        Presenter
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm">
                        <strong>Avatar:</strong> {avatars.find(a => a.id === selectedAvatar)?.name || selectedAvatar}
                      </p>
                      <p className="text-sm">
                        <strong>Voice:</strong> {voiceProfiles.find(v => v.heygen_voice_clone_id === selectedVoice)?.profile_name || selectedVoice}
                      </p>
                    </CardContent>
                  </Card>

                  {/* Style Summary */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <Palette className="h-4 w-4" />
                        Style
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm">
                        <strong>Background:</strong> {BACKGROUND_STYLES.find(b => b.id === backgroundStyle)?.label}
                      </p>
                      <p className="text-sm">
                        <strong>Orientation:</strong> {OUTPUT_ORIENTATIONS.find(o => o.id === outputOrientation)?.label} ({OUTPUT_ORIENTATIONS.find(o => o.id === outputOrientation)?.aspect})
                      </p>
                    </CardContent>
                  </Card>

                  {/* Quality Summary */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <Monitor className="h-4 w-4" />
                        Output
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm">
                        <strong>Quality:</strong> {QUALITY_PRESETS.find(q => q.id === qualityPreset)?.label}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Estimated render time: 5-15 minutes
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Compliance Notice */}
                <Alert>
                  <Shield className="h-4 w-4" />
                  <AlertTitle>Kernel Governance</AlertTitle>
                  <AlertDescription>
                    Your video will be processed through kernel governance. Ensure your script is approved and branding assets are validated before generation.
                  </AlertDescription>
                </Alert>

                {/* Generate Button */}
                <Button
                  onClick={handleGenerateVideo}
                  disabled={isSubmitting}
                  className="w-full"
                  size="lg"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                      Submitting to HeyGen...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-5 w-5 mr-2" />
                      Generate Video
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation */}
        {currentStep < 4 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
              disabled={currentStep === 0}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>

            <Button onClick={() => setCurrentStep((s) => s + 1)} disabled={!canProceed()}>
              {currentStep === 0 ? "Continue to Script" : "Next"}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        )}

        {currentStep === 4 && (
          <div className="flex items-center justify-start">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
