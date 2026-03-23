"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Mic,
  MicOff,
  Plus,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  Play,
  Pause,
  Trash2,
  Star,
  StarOff,
  RefreshCw,
  Volume2,
  Square,
  ArrowRight,
  Info,
  Shield,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  createVoiceProfile,
  updateVoiceProfileSamples,
  startVoiceCloneTraining,
  setDefaultVoiceProfile,
} from "@/app/actions/video-voice"
import { VOICE_CLONE_SAMPLE_PHRASES } from "@/app/actions/video-voice.constants"
import type {
  VoiceProfile,
  SampleManifest,
  SamplePhrase,
} from "@/app/actions/video-voice.types"

// ─── PROPS ───────────────────────────────────────────────────────────────────

interface VoiceCloneClientProps {
  agentId: string
  brokerageId: string
  userId: string
  initialProfiles: VoiceProfile[]
}

// ─── STATUS CONFIG ───────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: "Pending", color: "bg-slate-100 text-slate-700", icon: Clock },
  queued: { label: "Queued", color: "bg-amber-100 text-amber-700", icon: Clock },
  collecting_samples: { label: "Collecting Samples", color: "bg-blue-100 text-blue-700", icon: Mic },
  processing: { label: "Training", color: "bg-purple-100 text-purple-700", icon: Loader2 },
  completed: { label: "Ready", color: "bg-green-100 text-green-700", icon: CheckCircle2 },
  failed: { label: "Failed", color: "bg-red-100 text-red-700", icon: AlertTriangle },
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function VoiceCloneClient({
  agentId,
  brokerageId,
  userId,
  initialProfiles,
}: VoiceCloneClientProps) {
  const router = useRouter()

  // State
  const [profiles, setProfiles] = useState<VoiceProfile[]>(initialProfiles)
  const [selectedProfile, setSelectedProfile] = useState<VoiceProfile | null>(null)
  const [activeTab, setActiveTab] = useState<"profiles" | "record">("profiles")

  // Create profile dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  // Recording state
  const [sampleManifest, setSampleManifest] = useState<SampleManifest | null>(null)
  const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0)
  const [isRecording, setIsRecording] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  // Training state
  const [isStartingTraining, setIsStartingTraining] = useState(false)
  const [pollingTrainingId, setPollingTrainingId] = useState<string | null>(null)

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // ─── Initialize sample manifest when profile selected ───────────────────────

  useEffect(() => {
    if (selectedProfile && activeTab === "record") {
      // Build manifest from stored data or initialize fresh
      const existingManifest = selectedProfile.voice_clone_training?.[0]?.sample_manifest as SampleManifest | null

      if (existingManifest) {
        setSampleManifest(existingManifest)
        // Find first unrecorded phrase
        const firstUnrecorded = existingManifest.phrases.findIndex(p => p.status === "pending")
        setCurrentPhraseIndex(firstUnrecorded >= 0 ? firstUnrecorded : 0)
      } else {
        // Fresh manifest
        setSampleManifest({
          phrases: VOICE_CLONE_SAMPLE_PHRASES.map(p => ({
            ...p,
            status: "pending" as const,
          })),
        })
        setCurrentPhraseIndex(0)
      }
    }
  }, [selectedProfile, activeTab])

  // ─── Poll training status ───────────────────────────────────────────────────

  useEffect(() => {
    if (!pollingTrainingId) return

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/heygen/voice-clone/status/${pollingTrainingId}`)
        const data = await response.json()

        if (data.status === "completed" || data.status === "failed") {
          setPollingTrainingId(null)
          router.refresh()
        }
      } catch (error) {
        console.error("Error polling training status:", error)
      }
    }, 5000) // Poll every 5 seconds

    return () => clearInterval(interval)
  }, [pollingTrainingId, router])

  // ─── Create new profile ─────────────────────────────────────────────────────

  async function handleCreateProfile() {
    if (!newProfileName.trim()) return

    setIsCreating(true)
    try {
      const profile = await createVoiceProfile({
        brokerageId,
        agentId,
        profileName: newProfileName.trim(),
        actorUserId: userId,
      })

      setProfiles(prev => [profile, ...prev])
      setSelectedProfile(profile)
      setActiveTab("record")
      setCreateDialogOpen(false)
      setNewProfileName("")
    } catch (error) {
      console.error("Error creating profile:", error)
    } finally {
      setIsCreating(false)
    }
  }

  // ─── Recording functions ────────────────────────────────────────────────────

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" })
        setRecordedBlob(blob)
        setAudioUrl(URL.createObjectURL(blob))
        stream.getTracks().forEach(track => track.stop())
      }

      mediaRecorder.start()
      setIsRecording(true)
    } catch (error) {
      console.error("Error starting recording:", error)
      alert("Could not access microphone. Please check permissions.")
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  function playRecording() {
    if (audioUrl && audioRef.current) {
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  function stopPlaying() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setIsPlaying(false)
    }
  }

  function discardRecording() {
    setRecordedBlob(null)
    setAudioUrl(null)
    setIsPlaying(false)
  }

  async function confirmRecording() {
    if (!selectedProfile || !sampleManifest || !recordedBlob) return

    // In production, upload to storage and get URL
    // For now, mark as recorded with placeholder
    const updatedPhrases = [...sampleManifest.phrases]
    updatedPhrases[currentPhraseIndex] = {
      ...updatedPhrases[currentPhraseIndex],
      status: "recorded",
      recorded_at: new Date().toISOString(),
      // audio_url would come from storage upload
    }

    const newManifest: SampleManifest = {
      ...sampleManifest,
      phrases: updatedPhrases,
    }

    setSampleManifest(newManifest)
    setRecordedBlob(null)
    setAudioUrl(null)

    // Save to database
    try {
      await updateVoiceProfileSamples(
        selectedProfile.id,
        brokerageId,
        newManifest,
        userId
      )

      // Move to next phrase
      const nextUnrecorded = updatedPhrases.findIndex((p, i) => i > currentPhraseIndex && p.status === "pending")
      if (nextUnrecorded >= 0) {
        setCurrentPhraseIndex(nextUnrecorded)
      } else {
        // Check if all recorded
        const allRecorded = updatedPhrases.every(p => p.status === "recorded" || p.status === "validated")
        if (allRecorded) {
          // Refresh profile to show updated status
          router.refresh()
        }
      }
    } catch (error) {
      console.error("Error saving sample:", error)
    }
  }

  // ─── Start training ─────────────────────────────────────────────────────────

  async function handleStartTraining() {
    if (!selectedProfile || !sampleManifest) return

    const HEYGEN_MIN_SAMPLES = 5

    const readyPhrases = sampleManifest.phrases.filter(
      (p) =>
        (p.status === "recorded" || p.status === "validated") &&
        p.audio_url &&
        p.audio_url !== "placeholder_url" &&
        p.audio_url.startsWith("http")
    )

    if (readyPhrases.length < HEYGEN_MIN_SAMPLES) {
      toast.error(
        `${HEYGEN_MIN_SAMPLES} recorded samples required. ` +
          `You have ${readyPhrases.length}. ` +
          `Record ${HEYGEN_MIN_SAMPLES - readyPhrases.length} more before training.`
      )
      return
    }

    setIsStartingTraining(true)
    try {
      const trainingJob = await startVoiceCloneTraining(
        selectedProfile.id,
        brokerageId,
        sampleManifest,
        userId
      )

      setPollingTrainingId(trainingJob.id)

      const response = await fetch("/api/heygen/voice-clone/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          training_id: trainingJob.id,
          profile_id: selectedProfile.id,
          brokerage_id: brokerageId,
          user_id: userId,
          sample_audio_urls: readyPhrases.map((p) => p.audio_url),
          voice_name: selectedProfile.profile_name,
        }),
      })

      const result = await response.json()

      if (result.queued) {
        toast.info("Voice training queued — HeyGen API key required to process. Contact your admin.")
      } else if (result.status === "completed") {
        setPollingTrainingId(null)
        router.refresh()
      }
    } catch (error) {
      console.error("Error starting training:", error)
      toast.error("Failed to start training. Please try again.")
    } finally {
      setIsStartingTraining(false)
    }
  }

  // ─── Set default profile ────────────────────────────────────────────────────

  async function handleSetDefault(profileId: string) {
    try {
      await setDefaultVoiceProfile(profileId, agentId, brokerageId, userId)
      
      // Update local state
      setProfiles(prev => prev.map(p => ({
        ...p,
        is_default: p.id === profileId,
      })))
    } catch (error) {
      console.error("Error setting default:", error)
    }
  }

  // ─── Computed values ────────────────────────────────────────────────────────

  const recordedCount = sampleManifest?.phrases.filter(p => p.status === "recorded" || p.status === "validated").length || 0
  const totalRequired = VOICE_CLONE_SAMPLE_PHRASES.length
  const recordingProgress = (recordedCount / totalRequired) * 100
  const canStartTraining = recordedCount >= totalRequired

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Voice Clone</h1>
            <p className="text-muted-foreground mt-1">
              Create AI clones of your voice for personalized video content
            </p>
          </div>
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Voice Profile
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Voice Profile</DialogTitle>
                <DialogDescription>
                  Give your voice profile a name to identify it later.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Label htmlFor="profile-name">Profile Name</Label>
                <Input
                  id="profile-name"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="e.g., Professional Intro Voice"
                  className="mt-2"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateProfile} disabled={isCreating || !newProfileName.trim()}>
                  {isCreating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Create Profile
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Info Alert */}
        <Alert className="mb-6">
          <Shield className="h-4 w-4" />
          <AlertTitle>Kernel-Managed Voice Cloning</AlertTitle>
          <AlertDescription>
            Voice clone training is kernel-visible. All training events are logged and quality-gated.
            Clones below 70% quality threshold will not be auto-approved.
          </AlertDescription>
        </Alert>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "profiles" | "record")}>
          <TabsList className="mb-6">
            <TabsTrigger value="profiles">Voice Profiles</TabsTrigger>
            <TabsTrigger value="record" disabled={!selectedProfile}>
              Record Samples
            </TabsTrigger>
          </TabsList>

          {/* Profiles Tab */}
          <TabsContent value="profiles">
            {profiles.length === 0 ? (
              <Card>
                <CardContent className="p-16 text-center">
                  <Mic className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-foreground mb-2">No Voice Profiles</h3>
                  <p className="text-muted-foreground mb-4">
                    Create your first voice profile to get started with AI voice cloning.
                  </p>
                  <Button onClick={() => setCreateDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Voice Profile
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {profiles.map((profile) => {
                  const statusConfig = STATUS_CONFIG[profile.training_status] || STATUS_CONFIG.pending
                  const StatusIcon = statusConfig.icon

                  return (
                    <Card
                      key={profile.id}
                      className={cn(
                        "cursor-pointer transition-all hover:shadow-md",
                        selectedProfile?.id === profile.id && "ring-2 ring-primary"
                      )}
                      onClick={() => setSelectedProfile(profile)}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-lg">{profile.profile_name}</CardTitle>
                            {profile.is_default && (
                              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                            )}
                          </div>
                          <Badge className={statusConfig.color}>
                            {profile.training_status === "processing" ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <StatusIcon className="h-3 w-3 mr-1" />
                            )}
                            {statusConfig.label}
                          </Badge>
                        </div>
                        <CardDescription>
                          {profile.sample_count} / {totalRequired} samples recorded
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Progress 
                          value={(profile.sample_count / totalRequired) * 100} 
                          className="h-2 mb-4"
                        />

                        {profile.training_status === "completed" && profile.quality_score && (
                          <div className="flex items-center gap-2 text-sm mb-4">
                            <span className="text-muted-foreground">Quality:</span>
                            <span className={cn(
                              "font-medium",
                              profile.quality_score >= 70 ? "text-green-600" : "text-amber-600"
                            )}>
                              {profile.quality_score}%
                            </span>
                          </div>
                        )}

                        <div className="flex items-center gap-2">
                          {profile.training_status === "pending" || profile.training_status === "collecting_samples" ? (
                            <Button
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedProfile(profile)
                                setActiveTab("record")
                              }}
                            >
                              <Mic className="h-4 w-4 mr-1" />
                              Record
                            </Button>
                          ) : profile.training_status === "completed" ? (
                            <>
                              <Button
                                size="sm"
                                variant={profile.is_default ? "secondary" : "outline"}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleSetDefault(profile.id)
                                }}
                                disabled={profile.is_default}
                              >
                                {profile.is_default ? (
                                  <>
                                    <Star className="h-4 w-4 mr-1 fill-current" />
                                    Default
                                  </>
                                ) : (
                                  <>
                                    <StarOff className="h-4 w-4 mr-1" />
                                    Set Default
                                  </>
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  router.push("/dashboard/videos/create")
                                }}
                              >
                                <Volume2 className="h-4 w-4 mr-1" />
                                Use Voice
                              </Button>
                            </>
                          ) : profile.training_status === "processing" ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Training in progress...
                            </div>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* Record Tab */}
          <TabsContent value="record">
            {selectedProfile && sampleManifest && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Recording Panel */}
                <div className="lg:col-span-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>Record Sample Phrases</CardTitle>
                      <CardDescription>
                        Read each phrase clearly and naturally. Good quality recordings improve voice clone accuracy.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      {/* Progress */}
                      <div>
                        <div className="flex items-center justify-between text-sm mb-2">
                          <span className="text-muted-foreground">Progress</span>
                          <span className="font-medium">{recordedCount} / {totalRequired} phrases</span>
                        </div>
                        <Progress value={recordingProgress} className="h-2" />
                      </div>

                      {/* Current Phrase */}
                      <div className="p-6 bg-muted rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <Badge variant="outline">Phrase {currentPhraseIndex + 1}</Badge>
                          <Badge className={cn(
                            sampleManifest.phrases[currentPhraseIndex]?.status === "recorded"
                              ? "bg-green-100 text-green-700"
                              : "bg-slate-100 text-slate-700"
                          )}>
                            {sampleManifest.phrases[currentPhraseIndex]?.status === "recorded" ? "Recorded" : "Not Recorded"}
                          </Badge>
                        </div>
                        <p className="text-lg leading-relaxed text-foreground">
                          {sampleManifest.phrases[currentPhraseIndex]?.phrase_text}
                        </p>
                      </div>

                      {/* Recording Controls */}
                      <div className="flex flex-col items-center gap-4">
                        {!recordedBlob ? (
                          <Button
                            size="lg"
                            className={cn(
                              "w-24 h-24 rounded-full",
                              isRecording && "bg-red-600 hover:bg-red-700"
                            )}
                            onClick={isRecording ? stopRecording : startRecording}
                          >
                            {isRecording ? (
                              <Square className="h-8 w-8" />
                            ) : (
                              <Mic className="h-8 w-8" />
                            )}
                          </Button>
                        ) : (
                          <div className="flex items-center gap-4">
                            <Button
                              size="lg"
                              variant="outline"
                              className="w-16 h-16 rounded-full"
                              onClick={isPlaying ? stopPlaying : playRecording}
                            >
                              {isPlaying ? (
                                <Pause className="h-6 w-6" />
                              ) : (
                                <Play className="h-6 w-6" />
                              )}
                            </Button>
                            <Button
                              size="lg"
                              variant="destructive"
                              className="w-16 h-16 rounded-full"
                              onClick={discardRecording}
                            >
                              <Trash2 className="h-6 w-6" />
                            </Button>
                            <Button
                              size="lg"
                              className="w-16 h-16 rounded-full bg-green-600 hover:bg-green-700"
                              onClick={confirmRecording}
                            >
                              <CheckCircle2 className="h-6 w-6" />
                            </Button>
                          </div>
                        )}

                        <p className="text-sm text-muted-foreground">
                          {isRecording
                            ? "Recording... Click to stop"
                            : recordedBlob
                              ? "Review your recording"
                              : "Click to start recording"}
                        </p>
                      </div>

                      {/* Hidden audio element */}
                      {audioUrl && (
                        <audio
                          ref={audioRef}
                          src={audioUrl}
                          onEnded={() => setIsPlaying(false)}
                          className="hidden"
                        />
                      )}

                      {/* Training readiness + Start Training */}
                      {selectedProfile.training_status !== "completed" && (() => {
                        const HEYGEN_MIN_SAMPLES = 5
                        const readyCount = sampleManifest.phrases.filter(
                          (p) =>
                            (p.status === "recorded" || p.status === "validated") &&
                            p.audio_url &&
                            p.audio_url !== "placeholder_url" &&
                            p.audio_url.startsWith("http")
                        ).length
                        const remaining = HEYGEN_MIN_SAMPLES - readyCount
                        const isReady = readyCount >= HEYGEN_MIN_SAMPLES
                        return (
                          <div className="pt-4 border-t space-y-3">
                            <div className="space-y-1.5">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">
                                  {readyCount}/{HEYGEN_MIN_SAMPLES} samples ready
                                </span>
                                {isReady && (
                                  <span className="text-green-600 font-medium flex items-center gap-1">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Ready to train
                                  </span>
                                )}
                              </div>
                              <Progress
                                value={Math.min((readyCount / HEYGEN_MIN_SAMPLES) * 100, 100)}
                                className="h-2"
                              />
                            </div>
                            <Button
                              size="lg"
                              className="w-full"
                              onClick={handleStartTraining}
                              disabled={!isReady || isStartingTraining}
                            >
                              {isStartingTraining ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              ) : (
                                <ArrowRight className="h-4 w-4 mr-2" />
                              )}
                              {isStartingTraining
                                ? "Starting..."
                                : isReady
                                  ? "Start Voice Training"
                                  : `Record ${remaining} more sample${remaining !== 1 ? "s" : ""}`}
                            </Button>
                          </div>
                        )
                      })()}
                    </CardContent>
                  </Card>
                </div>

                {/* Phrase List */}
                <div>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Sample Phrases</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[500px]">
                        <div className="space-y-2">
                          {sampleManifest.phrases.map((phrase, index) => (
                            <div
                              key={phrase.phrase_id}
                              className={cn(
                                "p-3 rounded-lg border cursor-pointer transition-colors",
                                index === currentPhraseIndex
                                  ? "border-primary bg-primary/5"
                                  : "hover:bg-muted",
                                phrase.status === "recorded" && "border-green-200 bg-green-50"
                              )}
                              onClick={() => setCurrentPhraseIndex(index)}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs text-muted-foreground">
                                  Phrase {index + 1}
                                </span>
                                {phrase.status === "recorded" || phrase.status === "validated"
                                  ? phrase.audio_url &&
                                    phrase.audio_url !== "placeholder_url" &&
                                    phrase.audio_url.startsWith("http")
                                    ? (
                                      <span className="flex items-center gap-1 text-[11px] font-medium text-green-700">
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        Recorded
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600">
                                        <AlertTriangle className="h-3.5 w-3.5" />
                                        Needs recording
                                      </span>
                                    )
                                  : phrase.status === "recording"
                                    ? (
                                      <span className="flex items-center gap-1 text-[11px] font-medium text-blue-600">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Recording...
                                      </span>
                                    )
                                    : (
                                      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600">
                                        <AlertTriangle className="h-3.5 w-3.5" />
                                        Needs recording
                                      </span>
                                    )}
                              </div>
                              <p className="text-sm line-clamp-2">
                                {phrase.phrase_text}
                              </p>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
