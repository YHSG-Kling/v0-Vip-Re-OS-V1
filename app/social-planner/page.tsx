import { redirect } from 'next/navigation'

// ─── TOMBSTONE (lane 85E, CLAUDE.md §1.1) ────────────────────────────────────
// app/social-planner/social-planner-content.tsx (621 lines) was DELETED. It was
// the legacy Social Planner body, imported by NOTHING once this route became a
// redirect — invisible to test:no-dead-components, which accused only files
// under */components/ until lane 85E widened it to every runtime .tsx.
// SURVIVOR: app/dashboard/social/social-dashboard-client.tsx (/dashboard/social).
// Compared capability by capability before deletion:
//   · queue (draft/scheduled/published, delete) → the survivor's status tabs
//     (deleteSocialPost is already called there);
//   · calendar → SocialCalendarAiPlanner on the survivor;
//   · analytics (post counts by platform) → the survivor's analytics tab
//     (totals, impressions, engagement, the agent's share ledger);
//   · MERGED FIRST — the two halves only the legacy body had:
//       the blocked-content COMPLIANCE LOG (getEvaluationHistory, status fail)
//         → app/dashboard/social/components/social-compliance-log.tsx, mounted
//           as the survivor's "Compliance" tab;
//       per-post VideoGenerationButtons ("make a video from this post")
//         → the survivor's post card.
export default function SocialPlannerLegacyRedirect() {
  redirect('/dashboard/social')
}
