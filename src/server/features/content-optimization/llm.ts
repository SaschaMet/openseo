import { generateObject } from "ai";
import { buildChatAgentModel } from "@/server/lib/openrouter";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  llmContentAnalysisSchema,
  type LlmContentAnalysis,
  type OnPageReport,
} from "@/shared/content-optimization";

/**
 * Merge the LLM pass output into the report. Pure and total: it never throws
 * and degrades gracefully — when a section is empty the report keeps its
 * scaffold value. The natural-language summary is replaced only when the LLM
 * produced one.
 */
export function applyLlmAnalysis(
  report: OnPageReport,
  llm: LlmContentAnalysis | null,
): OnPageReport {
  if (!llm) return report;

  const summary = llm.summary ?? report.on_page_optimization.summary;
  return {
    ...report,
    on_page_optimization: {
      ...report.on_page_optimization,
      summary,
    },
    entity_coverage: {
      your_url_related_entity_density_score:
        llm.your_url_related_entity_density_score,
      competitor_related_entity_density_score:
        llm.competitor_related_entity_density_score,
      natural_language_entities: llm.natural_language_entities,
      highly_related_terms: llm.highly_related_terms,
      keyword_variations: llm.keyword_variations,
    },
    topic_and_classification: {
      page_classification: llm.page_classification,
      your_page: llm.your_page,
      swipe_content: {
        suggested_title: llm.suggested_title,
        topic_coverage: llm.topic_coverage,
      },
      topical_authority_questions: llm.topical_authority_questions,
    },
  };
}

// ─── LLM pass ────────────────────────────────────────────────────────────────

const TARGET_TEXT_LIMIT = 6000;
const COMPETITOR_TEXT_LIMIT = 1500;
const MAX_COMPETITORS = 5;

function truncate(text: string | null, limit: number): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Run the LLM entity-coverage + topic-classification pass. Returns null when
 * no OpenRouter key is configured or the call fails — the scan still completes
 * with the data-driven sections, so the LLM is an enhancement, never a
 * dependency.
 */
export async function runLlmContentAnalysis(input: {
  keyword: string;
  targetText: string | null;
  page1Texts: Array<{ url: string; text: string | null }>;
  relatedKeywords: string[];
}): Promise<LlmContentAnalysis | null> {
  const apiKey = await getOptionalEnvValue("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  const model = buildChatAgentModel(
    apiKey,
    await getOptionalEnvValue("OPENROUTER_MODEL"),
    "low",
  );
  try {
    const { object } = await generateObject({
      model,
      schema: llmContentAnalysisSchema,
      prompt: buildAnalysisPrompt(input),
    });
    return object;
  } catch (error) {
    console.warn("content-optimization.llm-failed", error);
    return null;
  }
}

function buildAnalysisPrompt(input: {
  keyword: string;
  targetText: string | null;
  page1Texts: Array<{ url: string; text: string | null }>;
  relatedKeywords: string[];
}): string {
  const competitors = input.page1Texts
    .slice(0, MAX_COMPETITORS)
    .map(
      (page, i) =>
        `--- Competitor ${i + 1} (${page.url}) ---\n${truncate(page.text, COMPETITOR_TEXT_LIMIT)}`,
    )
    .join("\n\n");

  return `You are an SEO content analyst. Analyze the target page below against the top-ranking competitor pages for the keyword "${input.keyword}".

TARGET PAGE TEXT:
${truncate(input.targetText, TARGET_TEXT_LIMIT) || "(no text)"}

COMPETITOR PAGES:
${competitors || "(none)"}

RELATED KEYWORDS TO CONSIDER: ${input.relatedKeywords.join(", ") || "(none)"}

Produce the structured analysis. For coverage_status use "good" when the term/entity is well covered, "present_not_entity" when it appears but is not a true entity, and "missing" when it is absent. Base entity density scores (0-100) on how thoroughly the page covers the topic's key entities relative to competitors. Keep the summary to 2-3 concrete sentences.`;
}
