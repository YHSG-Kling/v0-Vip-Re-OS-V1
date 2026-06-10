"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { StagedDraftBanner } from "@/app/components/shared/staged-draft-banner"
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
import { generateVideoScript } from "@/app/actions/video-generation"
import { BrollPicker } from "../components/BrollPicker"
import { getAgentSettings } from "@/app/actions/agent-settings"

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

export default function VideoCreatePage() {
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
  // D-ID-specific selections
  const [selectedElevenLabsVoiceId, setSelectedElevenLabsVoiceId] = useState<string | null>(null)
  const [selectedDIDAvatarSource, setSelectedDIDAvatarSource] = useState<"photo" | "video" | null>(null)
  // D-ID avatar library (agent_avatar_assets rows) — "photo" fallback is not an asset row
  const [didAvatarAssets, setDidAvatarAssets] = useState<Array<{
    id: string
    label: string
    source_type: "photo" | "video"
    did_avatar_id: string | null
    status: string
    thumbnail_url: string | null
    is_default: boolean
  }>>([])
  // Which asset row (or "photo" for the legacy photo fallback) the agent selected
  const [selectedDidAssetId, setSelectedDidAssetId] = useState<string | "photo" | null>(null)
  // Inline "add avatar" upload state
  const [showAddAvatar, setShowAddAvatar] = useState(false)
  const [newAvatarFile, setNewAvatarFile] = useState<File | null>(null)
  const [newAvatarLabel, setNewAvatarLabel] = useState("")
  const [isAddingAvatar, setIsAddingAvatar] = useState(false)
  const [addAvatarError, setAddAvatarError] = useState<string | null>(null)

  // Step 3: Style & Output
  const [backgroundStyle, setBackgroundStyle] = useState<string>("white")
  const [qualityPreset, setQualityPreset] = useState<string>("1080p")
  const [outputOrientation, setOutputOrientation] = useState<string>("landscape")
  // Cinematic touches — brokerage-curated bookend clips + b-roll the agent
  // picks from a card grid. Post-render compositing in poll-did-videos cron.
  const [brollSelection, setBrollSelection] = useState<{
    introVideoUrl: string | null
    outroVideoUrl: string | null
    bRollUrls:     string[]
  }>({ introVideoUrl: null, outroVideoUrl: null, bRollUrls: [] })
  const [brandingPresetId, setBrandingPresetId] = useState<string>("")

  // Step 3: Custom background upload / webcam capture
  const [customBgUrl, setCustomBgUrl] = useState<string>("")
  const [isUploadingBg, setIsUploadingBg] = useState(false)
  const [showWebcamCapture, setShowWebcamCapture] = useState(false)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bgFileInputRef = useRef<HTMLInputElement>(null)

  // Platform provider (loaded once from global_settings)
  const [platformProvider, setPlatformProvider] = useState<"did" | "heygen">("did")
  const [agentDIDProfile, setAgentDIDProfile] = useState<{
    elevenlabs_voice_id: string | null
    did_photo_url: string | null
    did_video_url: string | null
  } | null>(null)

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
        // Platform video engine is D-ID + ElevenLabs ONLY (HeyGen removed).
        // platformProvider is pinned to "did" — the heygen branches below are dead.
        setPlatformProvider("did")

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

          // Load D-ID profile for the agent (used when platform provider = "did")
          const { data: didProfileData } = await supabase
            .from("agent_voice_profiles")
            .select("elevenlabs_voice_id, did_photo_url, did_video_url")
            .eq("agent_id", agentData.id)
            .maybeSingle()
          setAgentDIDProfile(didProfileData ?? null)

          // Load avatar library for this agent
          const { data: assetRows } = await supabase
            .from("agent_avatar_assets")
            .select("id, label, source_type, did_avatar_id, status, thumbnail_url, is_default")
            .eq("agent_id", agentData.id)
            .order("is_default", { ascending: false })
            .order("created_at", { ascending: false })

          const assets = assetRows ?? []
          setDidAvatarAssets(assets)

          // Auto-select defaults for D-ID path
          // Voice: pick the default profile's elevenlabs_voice_id
          const defaultVoice = (voiceData ?? []).find((v: any) => v.is_default && v.elevenlabs_voice_id)
            ?? (voiceData ?? []).find((v: any) => v.elevenlabs_voice_id)
          if (defaultVoice?.elevenlabs_voice_id) {
            setSelectedElevenLabsVoiceId(defaultVoice.elevenlabs_voice_id)
          }

          // Avatar: prefer default ready video avatar from library, then photo fallback
          type AssetRow = typeof assets[number]
          const defaultReadyAsset = assets.find((a: AssetRow) => a.is_default && a.status === "ready")
            ?? assets.find((a: AssetRow) => a.status === "ready")
          if (defaultReadyAsset) {
            setSelectedDidAssetId(defaultReadyAsset.id)
            setSelectedDIDAvatarSource("video")
          } else if (didProfileData?.did_video_url) {
            // No library asset yet — fall back to raw video URL (legacy)
            setSelectedDIDAvatarSource("video")
          } else if (didProfileData?.did_photo_url) {
            setSelectedDIDAvatarSource("photo")
            setSelectedDidAssetId("photo")
          }
        }

        // Load branding presets — use agents.id (FK), not auth user id
        const { data: brandingData } = await supabase
          .from("video_branding_presets")
          .select("*")
          .or(`agent_id.eq.${agentData?.id ?? user?.id},is_default.eq.true`)
          .order("is_default", { ascending: false })

        setBrandingPresets(brandingData || [])

        // Load per-user voice configured during onboarding + social platforms.
        // Avatar selection for the D-ID engine is driven by didAvatarAssets below;
        // the legacy avatar list is no longer fetched (HeyGen removed).
        if (user?.id) {
          const agentSettings = await getAgentSettings(user.id)
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

      // ─── Setup guard ────────────────────────────────────────────────────────
      // Block generation if the agent hasn't completed Voice & Avatar setup.
      // Surfaces a clear, actionable error instead of silently failing downstream.
      if (platformProvider === "did") {
        if (!selectedElevenLabsVoiceId) {
          throw new Error(
            "Voice clone not set up. Visit Settings → Voice & Avatar to record your voice before generating videos."
          )
        }
        const selectedAsset = didAvatarAssets.find((a) => a.id === selectedDidAssetId)
        const hasReadyAvatar =
          (selectedAsset?.status === "ready") ||
          (selectedDidAssetId === "photo" && agentDIDProfile?.did_photo_url)
        if (!hasReadyAvatar) {
          throw new Error(
            "No avatar selected. Choose an avatar from the gallery or upload a new video clip."
          )
        }
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
            ? scripts.find((s: any) => s.id === selectedScript)?.script_type ?? "custom"
            : aiScriptVideoType ?? "custom",
          status: "pending",
          heygen_status: "pending",
          heygen_avatar_id: platformProvider === "heygen" ? (selectedAvatar || null) : null,
          heygen_voice_id: platformProvider === "heygen" ? (selectedVoice || null) : null,
          video_provider: platformProvider,
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

      // 2. Submit to video generation API — D-ID is the only engine.
      const endpoint = "/api/did/generate-video"

      // Resolve background payload (color hex or image URL) for the D-ID API.
      // D-ID requires a valid color (hex) or an image URL. The "office" and
      // "modern" presets are stylised gradients with no image asset behind
      // them — they were silently passing the literal word "office" as the
      // background value, which D-ID rejects. Fall back to a neutral hex
      // for any preset whose color isn't a usable hex or http(s) URL.
      const didBackground = backgroundStyle === "custom" && customBgUrl
        ? { type: "image" as const, value: customBgUrl }
        : (() => {
            const bgPreset = BACKGROUND_STYLES.find(b => b.id === backgroundStyle)
            const bgColorValue = bgPreset?.color
            if (!bgColorValue) return undefined
            // Hex color → pass through as color
            if (/^#[0-9a-f]{3,8}$/i.test(bgColorValue)) {
              return { type: "color" as const, value: bgColorValue }
            }
            // http(s) URL → pass through as image
            if (/^https?:\/\//i.test(bgColorValue)) {
              return { type: "image" as const, value: bgColorValue }
            }
            // Gradients, patterns, or named presets without an asset →
            // fall back to neutral white so D-ID still renders.
            return { type: "color" as const, value: "#ffffff" }
          })()

      // Resolve the did_avatar_id for the selected asset (null for photo fallback)
      const selectedAssetRow = didAvatarAssets.find((a) => a.id === selectedDidAssetId)
      const resolvedDidAvatarId = selectedAssetRow?.did_avatar_id ?? null

      const body = platformProvider === "did"
        ? {
            video_project_id: project.id,
            script,
            elevenlabs_voice_id: selectedElevenLabsVoiceId,
            // Pass avatar_id when available (faster, consistent renders via D-ID avatar library)
            ...(resolvedDidAvatarId ? { did_avatar_id: resolvedDidAvatarId } : {}),
            // Source URL fallbacks for photo mode and legacy profiles without avatar_id
            agent_photo_url: selectedDIDAvatarSource === "photo" ? agentDIDProfile?.did_photo_url : null,
            agent_video_url:
              selectedDIDAvatarSource === "video" && !resolvedDidAvatarId
                ? agentDIDProfile?.did_video_url
                : null,
            background: didBackground,
            // Cinematic touches — picked from the brokerage stock library in
            // step 3. All optional. The poll cron concatenates intro→main→outro
            // after the brand overlay.
            ...(brollSelection.introVideoUrl ? { intro_video_url: brollSelection.introVideoUrl } : {}),
            ...(brollSelection.outroVideoUrl ? { outro_video_url: brollSelection.outroVideoUrl } : {}),
            ...(brollSelection.bRollUrls.length > 0 ? { b_roll_urls: brollSelection.bRollUrls } : {}),
          }
        : {
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
          }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
        if (platformProvider === "did") {
          const asset = didAvatarAssets.find((a) => a.id === selectedDidAssetId)
          const hasReadyAvatar =
            (asset?.status === "ready") ||
            (selectedDidAssetId === "photo" && !!agentDIDProfile?.did_photo_url)
          return !!(selectedElevenLabsVoiceId && hasReadyAvatar)
        }
        // HeyGen: avatar required; voice required only if profiles exist
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
        {/* Banner — surfaces a fresh video project staged via voice/Copilot
            stage_video_project tool. Reads `?project=<uuid>`. */}
        <StagedDraftBanner
          paramKey="project"
          label="Video project draft"
          hint="Find your new project in the videos list — refine the script and generate the video."
        />
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
                    {platformProvider === "did"
                      ? "Your video uses your own face and cloned voice"
                      : "Select who will present your video and which voice to use"}
                  </p>
                </div>

                {/* D-ID: Voice clone + avatar gallery */}
                {platformProvider === "did" && (() => {
                  const elVoiceProfiles = voiceProfiles.filter((v: any) => v.elevenlabs_voice_id)
                  const hasPhoto = !!agentDIDProfile?.did_photo_url
                  const readyAssets = didAvatarAssets.filter((a) => a.status === "ready")
                  const pendingAssets = didAvatarAssets.filter((a) => a.status === "pending" || a.status === "processing")
                  const hasAnyAvatar = readyAssets.length > 0 || hasPhoto
                  const hasAnyVoice = elVoiceProfiles.length > 0

                  async function handleAddAvatar() {
                    if (!newAvatarFile || !resolvedAgentId) return
                    setIsAddingAvatar(true)
                    setAddAvatarError(null)
                    try {
                      const form = new FormData()
                      form.append("file", newAvatarFile)
                      form.append("bucket", "agent-photos")
                      const uploadRes = await fetch("/api/storage/upload-temp", { method: "POST", body: form })
                      const uploadData = uploadRes.ok ? await uploadRes.json() : null
                      if (!uploadData?.url) throw new Error("Upload failed — please try again.")

                      const createRes = await fetch("/api/did/create-avatar", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          source_url: uploadData.url,
                          label: newAvatarLabel || "My Avatar",
                          set_as_default: readyAssets.length === 0,
                        }),
                      })
                      const createData = await createRes.json()
                      if (!createRes.ok) throw new Error(createData.error ?? "Avatar creation failed.")

                      // Refresh avatar list
                      const { data: refreshed } = await supabase
                        .from("agent_avatar_assets")
                        .select("id, label, source_type, did_avatar_id, status, thumbnail_url, is_default")
                        .eq("agent_id", resolvedAgentId)
                        .order("is_default", { ascending: false })
                        .order("created_at", { ascending: false })
                      setDidAvatarAssets(refreshed ?? [])
                      setShowAddAvatar(false)
                      setNewAvatarFile(null)
                      setNewAvatarLabel("")
                    } catch (err: any) {
                      setAddAvatarError(err.message)
                    } finally {
                      setIsAddingAvatar(false)
                    }
                  }

                  return (
                    <div className="space-y-6">
                      {/* Voice Clone Selection */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Voice Clone</Label>
                          <a href="/dashboard/videos/voice" className="text-xs text-muted-foreground underline hover:text-foreground">
                            Manage voice setup
                          </a>
                        </div>
                        {hasAnyVoice ? (
                          <div className="space-y-2">
                            {elVoiceProfiles.map((voice: any) => (
                              <div
                                key={voice.id}
                                onClick={() => setSelectedElevenLabsVoiceId(voice.elevenlabs_voice_id)}
                                className={cn(
                                  "p-4 rounded-lg border-2 cursor-pointer transition-all flex items-center gap-4",
                                  selectedElevenLabsVoiceId === voice.elevenlabs_voice_id
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:border-primary/50"
                                )}
                              >
                                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                                  <Mic className="h-5 w-5 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium">{voice.profile_name}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {voice.is_default && (
                                      <Badge variant="secondary" className="text-xs">Default</Badge>
                                    )}
                                    {voice.quality_score && (
                                      <span className="text-xs text-muted-foreground">
                                        Quality: {(voice.quality_score * 100).toFixed(0)}%
                                      </span>
                                    )}
                                  </div>
                                </div>
                                {selectedElevenLabsVoiceId === voice.elevenlabs_voice_id && (
                                  <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertTitle>No voice clone set up</AlertTitle>
                            <AlertDescription className="flex items-center justify-between gap-4 flex-wrap">
                              <span>Upload a voice recording in Avatar & Voice Setup to clone your voice.</span>
                              <Button size="sm" variant="outline" className="shrink-0" onClick={() => router.push("/dashboard/videos/voice")}>
                                Set Up Voice
                              </Button>
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>

                      {/* Avatar Gallery */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Avatar</Label>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7 gap-1"
                            onClick={() => setShowAddAvatar((v) => !v)}
                          >
                            <Upload className="h-3 w-3" />
                            Add Avatar
                          </Button>
                        </div>

                        {/* Inline add-avatar form */}
                        {showAddAvatar && (
                          <div className="p-4 rounded-lg border bg-muted/50 space-y-3">
                            <p className="text-sm font-medium">Upload a new avatar video clip (5–15 sec)</p>
                            <input
                              type="text"
                              placeholder="Avatar name (e.g. Outdoor Casual)"
                              value={newAvatarLabel}
                              onChange={(e) => setNewAvatarLabel(e.target.value)}
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            />
                            <input
                              type="file"
                              accept="video/mp4,video/webm"
                              onChange={(e) => setNewAvatarFile(e.target.files?.[0] ?? null)}
                              className="block text-sm"
                            />
                            {addAvatarError && (
                              <p className="text-xs text-destructive">{addAvatarError}</p>
                            )}
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={!newAvatarFile || isAddingAvatar}
                                onClick={handleAddAvatar}
                              >
                                {isAddingAvatar ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                                {isAddingAvatar ? "Uploading…" : "Upload & Create Avatar"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => { setShowAddAvatar(false); setAddAvatarError(null) }}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Processing avatars banner */}
                        {pendingAssets.length > 0 && (
                          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                            {pendingAssets.length === 1
                              ? `"${pendingAssets[0].label}" is being processed by D-ID (1–3 min)…`
                              : `${pendingAssets.length} avatars are being processed…`}
                          </div>
                        )}

                        {hasAnyAvatar ? (
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {/* Ready library avatars */}
                            {readyAssets.map((asset) => (
                              <div
                                key={asset.id}
                                onClick={() => {
                                  setSelectedDidAssetId(asset.id)
                                  setSelectedDIDAvatarSource("video")
                                }}
                                className={cn(
                                  "p-3 rounded-lg border-2 cursor-pointer transition-all text-center space-y-2",
                                  selectedDidAssetId === asset.id
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:border-primary/50"
                                )}
                              >
                                <div className="w-16 h-16 rounded-full bg-muted mx-auto flex items-center justify-center overflow-hidden">
                                  {asset.thumbnail_url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={asset.thumbnail_url} alt={asset.label} className="w-full h-full object-cover" />
                                  ) : (
                                    <Video className="h-6 w-6 text-muted-foreground" />
                                  )}
                                </div>
                                <p className="font-medium text-xs truncate">{asset.label}</p>
                                {asset.is_default && (
                                  <Badge variant="secondary" className="text-xs">Default</Badge>
                                )}
                                {selectedDidAssetId === asset.id && (
                                  <CheckCircle2 className="h-4 w-4 text-primary mx-auto" />
                                )}
                              </div>
                            ))}

                            {/* Legacy photo fallback — shown when no library video avatars yet */}
                            {hasPhoto && readyAssets.filter((a) => a.source_type === "video").length === 0 && (
                              <div
                                onClick={() => {
                                  setSelectedDidAssetId("photo")
                                  setSelectedDIDAvatarSource("photo")
                                }}
                                className={cn(
                                  "p-3 rounded-lg border-2 cursor-pointer transition-all text-center space-y-2",
                                  selectedDidAssetId === "photo"
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:border-primary/50"
                                )}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={agentDIDProfile!.did_photo_url!}
                                  alt="Your photo"
                                  className="w-16 h-16 rounded-full object-cover mx-auto"
                                />
                                <p className="font-medium text-xs">Photo</p>
                                <p className="text-xs text-muted-foreground">Best for social</p>
                                {selectedDidAssetId === "photo" && (
                                  <CheckCircle2 className="h-4 w-4 text-primary mx-auto" />
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertTitle>No avatar uploaded</AlertTitle>
                            <AlertDescription className="flex items-center justify-between gap-4 flex-wrap">
                              <span>Upload a video clip above or go to Avatar & Voice Setup.</span>
                              <Button size="sm" variant="outline" className="shrink-0" onClick={() => router.push("/dashboard/videos/voice")}>
                                Set Up Avatar
                              </Button>
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Avatar Selection — only shown for HeyGen platform */}
                {platformProvider === "heygen" && (
                  <>{/* Avatar Selection */}
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
                </>)}
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

                {/* Cinematic touches — intro / outro / b-roll from the brokerage
                    stock library. Entirely optional. */}
                {brokerage?.id && (
                  <div className="pt-4 border-t">
                    <BrollPicker
                      brokerageId={brokerage.id}
                      videoType={aiScriptVideoType}
                      value={brollSelection}
                      onChange={setBrollSelection}
                    />
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
