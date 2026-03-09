'use server'

// app/actions/onboarding/certification-actions.ts
// VIP Real Estate AI OS — Layer 11
// Server actions for Certification claiming and progress management
// Re-exports from progress.ts for cleaner imports

export {
  getAgentProgress,
  checkCertEligibility,
  claimCertification,
  dismissCelebration,
  retakeCourse,
  getAdminOnboardingOverview,
} from './progress'
