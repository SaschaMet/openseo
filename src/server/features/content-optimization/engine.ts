import type {
  BenchmarkMetrics,
  OnPageReport,
} from "@/shared/content-optimization";
import type { ParsedPage } from "@/server/lib/dataforseo/onpage";

export type { ParsedPage } from "@/server/lib/dataforseo/onpage";

/**
 * Content Optimization scan engine.
 *
 * Pure, deterministic functions that turn collected page data (DataForSEO
 * content parsing + SERP + Lighthouse) into the report's data-driven sections:
 * benchmarks, the transparent score, competitor term coverage, and internal
 * linking. The LLM pass (see `llm.ts`) fills the entity-coverage and
 * topic-classification sections and the natural-language summary.
 */

// ─── Text helpers ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "you",
  "your",
  "are",
  "was",
  "were",
  "will",
  "would",
  "can",
  "could",
  "should",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "about",
  "into",
  "over",
  "under",
  "after",
  "before",
  "between",
  "than",
  "then",
  "them",
  "they",
  "their",
  "there",
  "here",
  "not",
  "but",
  "also",
  "more",
  "most",
  "some",
  "such",
  "only",
  "own",
  "same",
  "so",
  "do",
  "does",
  "did",
  "doing",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "of",
  "is",
  "it",
  "be",
  "by",
  "or",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((token) => token.length > 0);
}

function significantTerms(text: string): string[] {
  return tokenize(text).filter(
    (token) => token.length > 2 && !STOPWORDS.has(token),
  );
}

function countSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length === 0) return 0;
  const groups = cleaned.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  // A trailing silent "e" (except "-le") does not add a syllable.
  if (cleaned.endsWith("e") && !cleaned.endsWith("le") && count > 1) {
    count -= 1;
  }
  return Math.max(1, count);
}

/**
 * Flesch Reading Ease (0–100). Higher is easier to read. Returns null when the
 * text is too short to measure.
 */
export function fleschReadingEase(text: string): number | null {
  const words = tokenize(text);
  if (words.length < 10) return null;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const score =
    206.835 -
    1.015 * (words.length / sentenceCount) -
    84.6 * (totalSyllables / words.length);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Title/description-to-content consistency (0–100): the fraction of
 * significant terms in the title and description that also appear in the body.
 * Returns null when there is nothing to compare against.
 */
function consistencyScore(
  title: string | null,
  description: string | null,
  text: string | null,
): number | null {
  const headingTerms = significantTerms(`${title ?? ""} ${description ?? ""}`);
  if (headingTerms.length === 0 || !text) return null;
  const bodyTerms = new Set(significantTerms(text));
  const matched = headingTerms.filter((term) => bodyTerms.has(term)).length;
  return Math.round((matched / headingTerms.length) * 100);
}

/** Count whole-word, case-insensitive occurrences of a term in a text. */
function countTermOccurrences(term: string, text: string | null): number {
  if (!text || term.length === 0) return 0;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text
    .toLowerCase()
    .match(new RegExp(`\\b${escaped}\\b`, "gi"));
  return matches ? matches.length : 0;
}

// ─── Score ───────────────────────────────────────────────────────────────────

export interface ScoreComponents {
  wordCount: number | null;
  heading: number | null;
  readability: number | null;
  consistency: number | null;
  lighthouse: number | null;
}

const WEIGHTS: Record<keyof ScoreComponents, number> = {
  wordCount: 0.3,
  heading: 0.2,
  readability: 0.2,
  consistency: 0.15,
  lighthouse: 0.15,
};

const FOCUS_LABELS: Record<keyof ScoreComponents, string> = {
  wordCount: "Word count",
  heading: "Heading structure",
  readability: "Readability",
  consistency: "Consistency",
  lighthouse: "Performance & SEO",
};

const FOCUS_THRESHOLD = 70;

const COMPONENT_KEYS: (keyof ScoreComponents)[] = [
  "wordCount",
  "heading",
  "readability",
  "consistency",
  "lighthouse",
];

function gradeForScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * Transparent weighted score. Each component is 0–100; missing components
 * (null) are dropped and the remaining weights renormalized, so a scan without
 * Lighthouse still produces a fair 0–100.
 */
export function computeScore(components: ScoreComponents): {
  score: number | null;
  grade: string;
  focusAreas: string[];
} {
  let weighted = 0;
  let totalWeight = 0;
  const focusAreas: string[] = [];
  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    if (value === null) continue;
    const weight = WEIGHTS[key];
    weighted += value * weight;
    totalWeight += weight;
    if (value < FOCUS_THRESHOLD) focusAreas.push(FOCUS_LABELS[key]);
  }
  if (totalWeight === 0) {
    // No component was measurable (e.g. the target and every competitor failed
    // to parse). Grading missing data as 0/F would be misleading, so report a
    // null score with a neutral grade.
    return { score: null, grade: "—", focusAreas };
  }
  const score = Math.round(weighted / totalWeight);
  return { score, grade: gradeForScore(score), focusAreas };
}

/** Map a target page's metrics to 0–100 component scores. */
export function scoreComponents(
  target: ParsedPage,
  page1Average: BenchmarkMetrics,
  lighthouseSeoScore: number | null,
  languageCode: string,
): ScoreComponents {
  // Word count: matching or exceeding the page-1 average earns full marks.
  const wordCount =
    target.wordCount === null || !page1Average.word_count
      ? null
      : clampPct((target.wordCount / page1Average.word_count) * 100);

  // Heading structure: H2 density vs the average, with a penalty for no H1.
  const h2Ratio =
    page1Average.h2_count && target.h2Count !== null
      ? (target.h2Count / page1Average.h2_count) * 100
      : null;
  let heading = h2Ratio === null ? null : clampPct(h2Ratio);
  if (heading !== null && target.h1Count === 0) heading = Math.min(heading, 50);

  // Flesch Reading Ease is an English-language formula; for other locales it
  // would be meaningless, so readability is only measured for English.
  const readability =
    languageCode === "en" ? fleschReadingEase(target.text ?? "") : null;

  const consistency = consistencyScore(
    target.title,
    target.description,
    target.text,
  );

  return {
    wordCount,
    heading,
    readability,
    consistency,
    lighthouse:
      lighthouseSeoScore === null ? null : clampPct(lighthouseSeoScore),
  };
}

function clampPct(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

// ─── Report section builders ─────────────────────────────────────────────────

function average(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return Math.round(present.reduce((sum, v) => sum + v, 0) / present.length);
}

function toBenchmarkMetrics(page: ParsedPage): BenchmarkMetrics {
  return {
    word_count: page.wordCount,
    h1_count: page.h1Count,
    h2_count: page.h2Count,
    h3_count: page.h3Count,
    image_count: page.imageCount,
    entity_count: null,
    keyword_variation_count: null,
  };
}

export function buildBenchmarks(
  target: ParsedPage,
  page1: ParsedPage[],
): OnPageReport["benchmarks"] {
  const page1Average: BenchmarkMetrics = {
    word_count: average(page1.map((p) => p.wordCount)),
    h1_count: average(page1.map((p) => p.h1Count)),
    h2_count: average(page1.map((p) => p.h2Count)),
    h3_count: average(page1.map((p) => p.h3Count)),
    image_count: average(page1.map((p) => p.imageCount)),
    entity_count: null,
    keyword_variation_count: null,
  };
  return { page1_average: page1Average, your_url: toBenchmarkMetrics(target) };
}

export function buildCompetitorTermCoverage(
  target: ParsedPage,
  page1: ParsedPage[],
  terms: string[],
): OnPageReport["competitor_term_coverage"] {
  const domains = page1.map((p) => hostOf(p.url));
  const covered = terms
    .map((term) => {
      const yourCount = countTermOccurrences(term, target.text);
      const competitorCounts = page1.map((p) =>
        countTermOccurrences(term, p.text),
      );
      return {
        keyword: term,
        importance: 0,
        your_url_count: yourCount,
        competitor_counts: competitorCounts,
      };
    })
    .filter(
      (t) => t.your_url_count > 0 || t.competitor_counts.some((c) => c > 0),
    );
  return { domains, terms: covered };
}

export function buildInternalLinking(
  target: ParsedPage,
  page1: ParsedPage[],
): OnPageReport["internal_linking"] {
  const host = hostOf(target.url);
  // Suggest same-site page-1 pages that could link to the target (heuristic:
  // page-1 results on the target's own domain).
  const addInternalLinksFrom = page1
    .filter((p) => hostOf(p.url) === host && p.url !== target.url)
    .map((p) => p.url);
  return {
    add_internal_links_from: addInternalLinksFrom,
    to_your_url: target.url,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ─── Report assembly ─────────────────────────────────────────────────────────

export interface ReportInput {
  url: string;
  keyword: string;
  region: string;
  target: ParsedPage;
  page1: ParsedPage[];
  relatedKeywords: string[];
  lighthouseSeoScore: number | null;
  reportDate: string;
  languageCode?: string;
}

function deterministicSummary(
  keyword: string,
  score: number | null,
  grade: string,
  focusAreas: string[],
): string {
  if (score === null) {
    return `Not enough data was available to score "${keyword}" for this page.`;
  }
  const focus =
    focusAreas.length > 0
      ? ` Priority areas: ${focusAreas.join(", ")}.`
      : " The page is well optimized for this keyword.";
  return `This page scores ${score}/100 (grade ${grade}) for "${keyword}".${focus}`;
}

/**
 * Assemble the data-driven scaffold of the report. The entity-coverage and
 * topic-classification sections start empty and are filled by
 * `applyLlmAnalysis`.
 */
export function buildReport(input: ReportInput): OnPageReport {
  const benchmarks = buildBenchmarks(input.target, input.page1);
  const components = scoreComponents(
    input.target,
    benchmarks.page1_average,
    input.lighthouseSeoScore,
    input.languageCode ?? "en",
  );
  const { score, grade, focusAreas } = computeScore(components);

  return {
    meta: {
      report_date: input.reportDate,
      target_keyword: input.keyword,
      location: input.region,
      url: input.url,
    },
    on_page_optimization: {
      score,
      grade,
      summary: deterministicSummary(input.keyword, score, grade, focusAreas),
      focus_areas: focusAreas,
    },
    benchmarks,
    entity_coverage: {
      your_url_related_entity_density_score: null,
      competitor_related_entity_density_score: null,
      natural_language_entities: [],
      highly_related_terms: [],
      keyword_variations: [],
    },
    topic_and_classification: {
      page_classification: [],
      your_page: null,
      swipe_content: { suggested_title: null, topic_coverage: [] },
      topical_authority_questions: {},
    },
    internal_linking: buildInternalLinking(input.target, input.page1),
    competitor_term_coverage: buildCompetitorTermCoverage(
      input.target,
      input.page1,
      input.relatedKeywords,
    ),
    poweredBy: "DataForSEO + AI",
  };
}
