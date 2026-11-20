/**
 * lib/knowledge/help-topic-categories.ts
 *
 * THE ADMIN COULD NOT SAVE A HELP TOPIC.
 *
 * The Knowledge Base settings page hard-coded its own category list —
 * platform_setup, lead_management, transaction, compliance, marketing, billing,
 * general — and that array feeds BOTH the filter chips AND the create/edit
 * dropdown. The live CHECK on help_topics_kb.category admits an entirely
 * different set: license, brand, tech_stack, training, certification, general.
 *
 * Only `general` appears in both. Six of the seven options an admin could pick
 * were refused by the database. Verified live:
 *
 *     insert into help_topics_kb (topic_key, title, content, category)
 *     values ('…','…','…','platform_setup');
 *     ERROR: 23514 … violates check constraint "help_topics_kb_category_check"
 *
 * This module is the ONE list. It is client-safe (no `server-only`) so the
 * picker can import it directly rather than keeping a fourth copy — a
 * hand-maintained vocabulary next to a CHECK constraint is how the drift got in.
 *
 * MIRRORS the live help_topics_kb_category_check. Adding a member here without
 * the migration produces a value the database refuses.
 */

export type HelpTopicCategory =
  | "license"
  | "brand"
  | "tech_stack"
  | "training"
  | "certification"
  | "general"

/** Every storable category, in the order a picker should offer them. */
export const HELP_TOPIC_CATEGORIES: HelpTopicCategory[] = [
  "license",
  "brand",
  "tech_stack",
  "training",
  "certification",
  "general",
]

/** Human labels — the raw column value is not reader-friendly. */
export const HELP_TOPIC_CATEGORY_LABEL: Record<HelpTopicCategory, string> = {
  license:       "License",
  brand:         "Brand",
  tech_stack:    "Tech Stack",
  training:      "Training",
  certification: "Certification",
  general:       "General",
}

/** Label a raw column value without trusting it to be in the union. */
export function helpTopicCategoryLabel(value: string | null | undefined): string {
  if (!value) return "Uncategorised"
  return HELP_TOPIC_CATEGORY_LABEL[value as HelpTopicCategory] ?? value
}

/** Is this value actually storable? Use before a write, not after. */
export function isStorableHelpTopicCategory(value: string): value is HelpTopicCategory {
  return (HELP_TOPIC_CATEGORIES as string[]).includes(value)
}
