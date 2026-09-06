"use client"

import { useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog"
import { ChevronLeft, ChevronRight, Play, Calendar, Home } from "lucide-react"
import { trackCtaClick } from "@/app/actions/listing-landing"
import { cn } from "@/lib/utils"

interface ListingHeroProps {
  photos: Array<{
    id: string
    photo_url: string
    sort_order: number
  }>
  media: Array<{
    id: string
    media_type: string
    media_url: string
  }>
  address: string
  sessionToken: string
  listingId: string
}

export function ListingHero({
  photos,
  media,
  address,
  sessionToken,
  listingId,
}: ListingHeroProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isGalleryOpen, setIsGalleryOpen] = useState(false)

  const videoMedia = media.filter((m) => m.media_type === "video")
  const hasVideo = videoMedia.length > 0
  const primaryPhoto = photos[0]?.photo_url

  const handlePrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? photos.length - 1 : prev - 1))
  }

  const handleNext = () => {
    setCurrentIndex((prev) => (prev === photos.length - 1 ? 0 : prev + 1))
  }

  const handleScheduleClick = () => {
    trackCtaClick(listingId, sessionToken)
    const formElement = document.getElementById("showing-request-form")
    if (formElement) {
      formElement.scrollIntoView({ behavior: "smooth" })
    }
  }

  return (
    <section className="relative">
      {/* Hero Image */}
      <div className="relative w-full aspect-[16/9] max-h-[70vh] overflow-hidden bg-muted">
        {photos.length > 0 ? (
          <>
            <Image
              src={photos[currentIndex]?.photo_url || primaryPhoto}
              alt={`${address} - Photo ${currentIndex + 1}`}
              fill
              className="object-cover"
              priority
            />
            {/* Overlay gradient */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

            {/* Navigation arrows */}
            {photos.length > 1 && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute left-4 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background"
                  onClick={handlePrevious}
                >
                  <ChevronLeft className="h-6 w-6" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-4 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background"
                  onClick={handleNext}
                >
                  <ChevronRight className="h-6 w-6" />
                </Button>
              </>
            )}

            {/* Photo count */}
            <div className="absolute top-4 right-4 bg-background/80 px-3 py-1 rounded-full text-sm">
              {currentIndex + 1} / {photos.length}
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Home className="h-24 w-24 text-muted-foreground/30" />
          </div>
        )}

        {/* Address overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-6">
          <h2 className="text-3xl md:text-4xl font-bold text-white drop-shadow-lg">{address}</h2>
        </div>

        {/* Video button */}
        {hasVideo && (
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="secondary"
                className="absolute top-4 left-4 gap-2"
              >
                <Play className="h-4 w-4" />
                Watch Video Tour
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl p-0">
              <div className="aspect-video">
                <video
                  src={videoMedia[0].media_url}
                  controls
                  autoPlay
                  className="w-full h-full"
                />
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Thumbnail Strip */}
      {photos.length > 1 && (
        <div className="bg-muted/50 py-3 px-4 overflow-x-auto">
          <div className="flex gap-2">
            {photos.map((photo, index) => (
              <button
                key={photo.id}
                onClick={() => setCurrentIndex(index)}
                className={cn(
                  "relative flex-shrink-0 w-20 h-14 rounded-md overflow-hidden border-2 transition-all",
                  currentIndex === index
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-transparent hover:border-muted-foreground/30"
                )}
              >
                <Image
                  src={photo.photo_url}
                  alt={`Thumbnail ${index + 1}`}
                  fill
                  className="object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sticky Schedule Button */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 md:hidden">
        <Button
          size="lg"
          onClick={handleScheduleClick}
          className="shadow-lg gap-2"
        >
          <Calendar className="h-5 w-5" />
          Schedule a Showing
        </Button>
      </div>
    </section>
  )
}
