"use server"

/**
 * app/actions/platform-skill-examples.ts — the platform skill EXAMPLES door (wave 137, lane 137E).
 *
 * Every export here is a public HTTP endpoint (CLAUDE.md §4): it gates FIRST on platform staff (the examples
 * are templates for the platform's own marketplace intake), then returns DATA — the examples validated at load
 * by lib/kernel/platform-skill-examples.ts, plus any candidate the load-time gate rejected (named, never
 * offered). Nothing is written: a staff member loads an example into the Superadmin → Skill marketplace intake
 * and submits it through submitThirdPartySkill (publisher "platform") — evaluated, approved, published there.
 */
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import type { SkillDeclaration } from "@/lib/kernel/skill-registry"

interface PlatformSkillExampleOption { declaration: SkillDeclaration; domains: string[]; domainSources: string[] }

export async function getPlatformSkillExamples(): Promise<{ ok: true; examples: PlatformSkillExampleOption[]; rejected: Array<{ name: string; errors: string[] }> } | { ok: false; error: string }> {
  const staff = await requirePlatformStaff()
  if (!staff.ok) return { ok: false, error: staff.error }
  const { PLATFORM_SKILL_EXAMPLES, PLATFORM_SKILL_EXAMPLE_REJECTS } = await import("@/lib/kernel/platform-skill-examples")
  return {
    ok: true,
    examples: PLATFORM_SKILL_EXAMPLES.map((e) => ({ declaration: e.declaration, domains: [...e.domains], domainSources: [...e.domainSources] })),
    rejected: PLATFORM_SKILL_EXAMPLE_REJECTS.map((r) => ({ name: r.name, errors: [...r.errors] })),
  }
}
