// ─── BRAND REQUIREMENTS ───────────────────────────────────────────────────────
export type { RequiredBrandElement, BrandContext, BrandRequirements } from "./brand-requirements"
export {
  getBrandRequirements,
  validateBrandCompliance,
  getBrandElementDescription,
  batchGetBrandRequirements,
  formatBrandRequirements,
} from "./brand-requirements"

// ─── TEMPLATE CLASSIFIER ──────────────────────────────────────────────────────
export type { TemplateTrustLevel, TemplateMetadata, TemplateClassification } from "./template-classifier"
export {
  classifyTemplate,
  batchClassifyTemplates,
  isAutoApprovalEligible,
  getTrustLevelPriority,
  formatTemplateClassification,
} from "./template-classifier"

// ─── REGISTRY LOGGER ──────────────────────────────────────────────────────────
export {
  logTemplateClassification,
  logBrandRequirements,
  logBrandCompliance,
  batchLogTemplateClassifications,
  batchLogBrandRequirements,
  getTemplateClassificationHistory,
  getBrandComplianceHistory,
  getBrandTemplateStatistics,
} from "./registry-logger"
