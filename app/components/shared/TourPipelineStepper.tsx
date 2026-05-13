'use client'

import React from 'react'
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react'
import Link from 'next/link'

interface TourPipelineStepperProps {
  contactId: string
  savedCount: number
  tourCount: number
  buyerStage?: string
  compact?: boolean
}

const STEPS = ['Search', 'Save', 'Schedule', 'Tour', 'Offer', 'Close']

const STEP_ROUTES: Record<string, string> = {
  Search: '/contacts/{id}/search',
  Save: '/contacts/{id}/search',
  Schedule: '/contacts/{id}/tours',
  Tour: '/contacts/{id}/tours',
  Offer: '/contacts/{id}/offers/new',
  Close: '/contacts/{id}',
}

const STAGE_TO_STEP_INDEX: Record<string, number> = {
  BUYER_CONTACT_CREATED: 0,
  BUYER_FINANCIALLY_VERIFIED: 1,
  BUYER_TOUR_ELIGIBLE: 2,
  BUYER_TOURING: 3,
  BUYER_OFFER_ELIGIBLE: 4,
  BUYER_OFFER_SUBMITTED: 4,
  BUYER_UNDER_CONTRACT: 5,
  BUYER_CLOSED: 5,
}

export function TourPipelineStepper({
  contactId,
  savedCount,
  tourCount,
  buyerStage = 'BUYER_CONTACT_CREATED',
  compact = false,
}: TourPipelineStepperProps) {
  const activeStep = STAGE_TO_STEP_INDEX[buyerStage] ?? 0

  const getStepSublabel = (step: string, index: number) => {
    if (step === 'Save') return `${savedCount} saved`
    if (step === 'Tour') return `${tourCount} toured`
    return ''
  }

  return (
    <div className="flex items-center overflow-x-auto min-w-max gap-1 md:gap-2 p-4 bg-background rounded-lg border">
      {STEPS.map((step, index) => {
        const isCompleted = index < activeStep
        const isActive = index === activeStep
        const isDone = index <= activeStep

        const circleSize = compact ? 'h-7 w-7' : 'h-9 w-9'
        const labelSize = compact ? 'text-xs' : 'text-sm'
        const sublabelSize = compact ? 'text-xs' : 'text-xs'

        return (
          <React.Fragment key={step}>
            <div className="flex flex-col items-center gap-1">
              <Link
                href={STEP_ROUTES[step].replace('{id}', contactId)}
                className="focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary rounded-full"
              >
                <div className={`flex items-center justify-center rounded-full border-2 ${circleSize} transition-colors ${
                  isCompleted
                    ? 'bg-green-50 border-green-300'
                    : isActive
                      ? 'bg-blue-50 border-blue-400'
                      : 'bg-muted border-muted-foreground/30'
                }`}>
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : isActive ? (
                    <span className="text-sm font-semibold text-blue-600">{index + 1}</span>
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/50" />
                  )}
                </div>
              </Link>
              <span className={`font-medium text-center whitespace-nowrap ${labelSize}`}>{step}</span>
              {getStepSublabel(step, index) && (
                <span className={`text-muted-foreground text-center whitespace-nowrap ${sublabelSize}`}>
                  {getStepSublabel(step, index)}
                </span>
              )}
            </div>

            {index < STEPS.length - 1 && (
              <div className="flex items-center px-1 md:px-2 h-9">
                <ArrowRight className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} text-muted-foreground/50`} />
              </div>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
