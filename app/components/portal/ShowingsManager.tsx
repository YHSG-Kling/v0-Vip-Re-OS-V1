"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar, Home, Star, CheckCircle2, Loader2 } from "lucide-react"
import { getShowingRequests, updateShowingFeedback } from "@/app/actions/smart-insights"

interface ShowingsManagerProps {
  contactId: string
}

export function ShowingsManager({ contactId }: ShowingsManagerProps) {
  const [showings, setShowings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [feedbackDialog, setFeedbackDialog] = useState<{ open: boolean; showingId: string | null }>({
    open: false,
    showingId: null,
  })
  const [feedbackData, setFeedbackData] = useState({
    rating: 0,
    notes: "",
    interestedLevel: "" as "very_interested" | "interested" | "neutral" | "not_interested" | "",
  })

  useEffect(() => {
    loadShowings()
  }, [contactId])

  async function loadShowings() {
    setLoading(true)
    const data = await getShowingRequests(contactId)
    setShowings(data)
    setLoading(false)
  }

  async function handleSubmitFeedback() {
    if (!feedbackDialog.showingId || !feedbackData.interestedLevel) return

    await updateShowingFeedback(
      feedbackDialog.showingId,
      feedbackData.rating,
      feedbackData.notes,
      feedbackData.interestedLevel,
    )

    setFeedbackDialog({ open: false, showingId: null })
    setFeedbackData({ rating: 0, notes: "", interestedLevel: "" })
    loadShowings()
  }

  const statusColors: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800",
    confirmed: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800",
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (showings.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="font-semibold text-lg">No Showings Scheduled</h3>
          <p className="text-muted-foreground text-sm text-center mt-1">
            Browse properties and request showings to see them here
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Upcoming */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Upcoming Showings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {showings
              .filter((s) => s.status === "pending" || s.status === "confirmed")
              .map((showing) => (
                <div key={showing.id} className="flex items-center justify-between p-4 rounded-lg border">
                  <div className="flex items-center gap-4">
                    <Home className="h-10 w-10 text-muted-foreground p-2 bg-muted rounded-lg" />
                    <div>
                      <p className="font-medium">{showing.property_address || "Property"}</p>
                      <p className="text-sm text-muted-foreground">
                        {showing.confirmed_date
                          ? new Date(showing.confirmed_date).toLocaleDateString("en-US", {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : "Awaiting confirmation"}
                      </p>
                    </div>
                  </div>
                  <Badge className={statusColors[showing.status]}>{showing.status}</Badge>
                </div>
              ))}
            {showings.filter((s) => s.status === "pending" || s.status === "confirmed").length === 0 && (
              <p className="text-muted-foreground text-center py-4">No upcoming showings</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Past - Need Feedback */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5" />
            Past Showings
          </CardTitle>
          <CardDescription>Share feedback on properties you've visited</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {showings
              .filter((s) => s.status === "completed" || s.feedback_rating)
              .map((showing) => (
                <div key={showing.id} className="flex items-center justify-between p-4 rounded-lg border">
                  <div className="flex items-center gap-4">
                    <Home className="h-10 w-10 text-muted-foreground p-2 bg-muted rounded-lg" />
                    <div>
                      <p className="font-medium">{showing.property_address || "Property"}</p>
                      {showing.feedback_rating ? (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex items-center">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <Star
                                key={star}
                                className={`h-4 w-4 ${star <= showing.feedback_rating ? "text-amber-500 fill-amber-500" : "text-gray-300"}`}
                              />
                            ))}
                          </div>
                          <Badge
                            variant="secondary"
                            className={
                              showing.interested_level === "very_interested"
                                ? "bg-green-100 text-green-800"
                                : showing.interested_level === "not_interested"
                                  ? "bg-red-100 text-red-800"
                                  : ""
                            }
                          >
                            {showing.interested_level?.replace("_", " ")}
                          </Badge>
                        </div>
                      ) : (
                        <p className="text-sm text-amber-600">Feedback needed</p>
                      )}
                    </div>
                  </div>
                  {!showing.feedback_rating && (
                    <Dialog
                      open={feedbackDialog.open && feedbackDialog.showingId === showing.id}
                      onOpenChange={(open) => setFeedbackDialog({ open, showingId: open ? showing.id : null })}
                    >
                      <DialogTrigger asChild>
                        <Button size="sm">Add Feedback</Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Share Your Feedback</DialogTitle>
                          <DialogDescription>How was your showing at {showing.property_address}?</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label>Overall Rating</Label>
                            <div className="flex gap-1">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                  key={star}
                                  type="button"
                                  onClick={() => setFeedbackData({ ...feedbackData, rating: star })}
                                  className="p-1"
                                >
                                  <Star
                                    className={`h-8 w-8 ${star <= feedbackData.rating ? "text-amber-500 fill-amber-500" : "text-gray-300"}`}
                                  />
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label>Interest Level</Label>
                            <Select
                              value={feedbackData.interestedLevel}
                              onValueChange={(v) => setFeedbackData({ ...feedbackData, interestedLevel: v as any })}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="How interested are you?" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="very_interested">Very Interested - Want to make offer</SelectItem>
                                <SelectItem value="interested">Interested - Keep on list</SelectItem>
                                <SelectItem value="neutral">Neutral - Need to think</SelectItem>
                                <SelectItem value="not_interested">Not Interested - Remove</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-2">
                            <Label>Notes (optional)</Label>
                            <Textarea
                              placeholder="What did you like or dislike about this property?"
                              value={feedbackData.notes}
                              onChange={(e) => setFeedbackData({ ...feedbackData, notes: e.target.value })}
                            />
                          </div>

                          <Button onClick={handleSubmitFeedback} className="w-full">
                            Submit Feedback
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              ))}
            {showings.filter((s) => s.status === "completed" || s.feedback_rating).length === 0 && (
              <p className="text-muted-foreground text-center py-4">No past showings yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
