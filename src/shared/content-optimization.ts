import { z } from "zod";

/**
 * Content Optimization — shared types.
 *
 * The report shape (`onPageReportSchema`) is the contract between the scan
 * engine (server), the LLM pass, the server functions, the MCP/SAM tools, and
 * the UI. It is provider-agnostic: the engine fills it from DataForSEO data +
 * an LLM pass, and the UI renders it. Keeping the field names stable means the
 * UI components are untouched by a provider swap.
 */

// Google SERP regions we accept (ISO codes). Mapped to DataForSEO location
// codes at the call site (see keyword-locations).
export const CONTENT_SCAN_REGIONS = [
  "US",
  "CA",
  "UK",
  "AU",
  "NZ",
  "ES",
  "DE",
  "IT",
  "FR",
  "IE",
  "NL",
  "CH",
  "SE",
  "NO",
  "DK",
  "FI",
  "ZA",
  "MX",
  "BR",
  "CO",
  "IN",
  "SG",
  "MY",
  "JP",
  "KE",
  "AE",
  "HK",
] as const;

export type ContentScanRegion = (typeof CONTENT_SCAN_REGIONS)[number];

export const CONTENT_SCAN_STATUS = ["running", "completed", "failed"] as const;
export type ContentScanStatus = (typeof CONTENT_SCAN_STATUS)[number];

export const coverageStatusSchema = z.enum([
  "good",
  "present_not_entity",
  "missing",
]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export const coverageEntrySchema = z.object({
  entity: z.string(),
  importance: z.number().optional(),
  coverage_status: coverageStatusSchema,
});
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export const keywordVariationSchema = z.object({
  variation: z.string(),
  coverage_status: coverageStatusSchema,
});
export type KeywordVariation = z.infer<typeof keywordVariationSchema>;

export const benchmarkMetricsSchema = z.object({
  word_count: z.number().nullable(),
  h1_count: z.number().nullable(),
  h2_count: z.number().nullable(),
  h3_count: z.number().nullable(),
  image_count: z.number().nullable(),
  entity_count: z.number().nullable(),
  keyword_variation_count: z.number().nullable(),
});
export type BenchmarkMetrics = z.infer<typeof benchmarkMetricsSchema>;

/**
 * The customer-facing report. This is the stable contract the UI renders.
 */
export const onPageReportSchema = z.object({
  meta: z.object({
    report_date: z.string().nullable(),
    target_keyword: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string().nullable(),
  }),
  on_page_optimization: z.object({
    score: z.number().nullable(),
    grade: z.string(),
    summary: z.string(),
    focus_areas: z.array(z.string()),
  }),
  benchmarks: z.object({
    page1_average: benchmarkMetricsSchema,
    your_url: benchmarkMetricsSchema,
  }),
  entity_coverage: z.object({
    your_url_related_entity_density_score: z.number().nullable(),
    competitor_related_entity_density_score: z.number().nullable(),
    natural_language_entities: z.array(coverageEntrySchema),
    highly_related_terms: z.array(coverageEntrySchema),
    keyword_variations: z.array(keywordVariationSchema),
  }),
  topic_and_classification: z.object({
    page_classification: z
      .array(
        z.object({
          rank: z.number(),
          category: z.string(),
          url: z.string().nullable(),
          confidence: z.number().nullable(),
        }),
      )
      .default([]),
    your_page: z
      .object({ category: z.string(), confidence: z.number().nullable() })
      .nullable()
      .default(null),
    swipe_content: z.object({
      suggested_title: z.string().nullable(),
      topic_coverage: z.array(z.string()),
    }),
    topical_authority_questions: z.record(z.string(), z.array(z.string())),
  }),
  internal_linking: z.object({
    add_internal_links_from: z.array(z.string()),
    to_your_url: z.string().nullable(),
  }),
  competitor_term_coverage: z.object({
    domains: z.array(z.string()),
    terms: z.array(
      z.object({
        keyword: z.string(),
        importance: z.number(),
        your_url_count: z.number(),
        competitor_counts: z.array(z.number()),
      }),
    ),
  }),
  jobId: z.string().optional(),
  jobDisplayId: z.string().optional(),
  poweredBy: z.string().optional(),
});

export type OnPageReport = z.infer<typeof onPageReportSchema>;

/**
 * The poll view returned to the UI while a scan runs and when it finishes.
 * `report` is only present once `status` is `completed`.
 */
export const contentScanViewSchema = z.object({
  jobId: z.string(),
  status: z.enum(CONTENT_SCAN_STATUS),
  progress: z.number().nullable(),
  error: z.string().nullable(),
  score: z.number().nullable(),
  grade: z.string().nullable(),
  pageCategory: z.string().nullable(),
  report: onPageReportSchema.nullable(),
});
export type ContentScanView = z.infer<typeof contentScanViewSchema>;

/**
 * The LLM pass output. Merged into the report's entity_coverage and
 * topic_and_classification sections. All sections degrade to empty when the
 * LLM is unavailable.
 */
export const llmContentAnalysisSchema = z.object({
  natural_language_entities: z.array(coverageEntrySchema),
  highly_related_terms: z.array(coverageEntrySchema),
  keyword_variations: z.array(keywordVariationSchema),
  your_url_related_entity_density_score: z.number().nullable(),
  competitor_related_entity_density_score: z.number().nullable(),
  page_classification: z
    .array(
      z.object({
        rank: z.number(),
        category: z.string(),
        url: z.string().nullable(),
        confidence: z.number().nullable(),
      }),
    )
    .default([]),
  your_page: z
    .object({ category: z.string(), confidence: z.number().nullable() })
    .nullable()
    .default(null),
  suggested_title: z.string().nullable(),
  topic_coverage: z.array(z.string()),
  topical_authority_questions: z.record(z.string(), z.array(z.string())),
  summary: z.string().nullable(),
});
export type LlmContentAnalysis = z.infer<typeof llmContentAnalysisSchema>;
