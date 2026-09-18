import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(),
}));
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));
vi.mock("@/server/lib/openrouter", () => ({
  buildChatAgentModel: vi.fn(() => ({ id: "test-model" })),
}));

import { generateObject } from "ai";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { runLlmContentAnalysis } from "@/server/features/content-optimization/llm";

const getEnv = vi.mocked(getOptionalEnvValue);
const genObject = vi.mocked(generateObject);

afterEach(() => {
  vi.resetAllMocks();
});

const input = {
  keyword: "seo tools",
  targetText: "A page about seo tools and keyword research.",
  page1Texts: [
    { url: "https://a.com", text: "seo tools for backlinks and rankings" },
    { url: "https://b.com", text: "keyword research and technical seo" },
  ],
  relatedKeywords: ["seo", "backlinks", "rankings"],
};

describe("runLlmContentAnalysis", () => {
  it("returns null when no OpenRouter key is configured", async () => {
    getEnv.mockResolvedValue(undefined);
    const result = await runLlmContentAnalysis(input);
    expect(result).toBeNull();
    expect(genObject).not.toHaveBeenCalled();
  });

  it("returns the LLM analysis when generateObject succeeds", async () => {
    getEnv.mockResolvedValue("sk-test");
    const llmObject = {
      natural_language_entities: [
        { entity: "Search engines", coverage_status: "good" },
      ],
      highly_related_terms: [
        { entity: "backlinks", coverage_status: "missing" },
      ],
      keyword_variations: [
        { variation: "seo software", coverage_status: "good" },
      ],
      your_url_related_entity_density_score: 72,
      competitor_related_entity_density_score: 80,
      page_classification: [
        {
          rank: 1,
          category: "Software",
          url: "https://a.com",
          confidence: 0.9,
        },
      ],
      your_page: { category: "Software", confidence: 0.85 },
      suggested_title: "Better title",
      topic_coverage: ["Backlinks", "Technical SEO"],
      topical_authority_questions: { "What is X?": ["a", "b"] },
      summary: "A crisp summary.",
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture: only `.object` is consumed by the code under test
    genObject.mockResolvedValue({
      object: llmObject,
    } as unknown as Awaited<ReturnType<typeof generateObject>>);

    const result = await runLlmContentAnalysis(input);
    expect(result).toMatchObject({
      natural_language_entities: llmObject.natural_language_entities,
      your_page: llmObject.your_page,
      summary: "A crisp summary.",
    });
    expect(genObject).toHaveBeenCalledOnce();
  });

  it("returns null when generateObject throws", async () => {
    getEnv.mockResolvedValue("sk-test");
    genObject.mockRejectedValue(new Error("boom"));
    const result = await runLlmContentAnalysis(input);
    expect(result).toBeNull();
  });
});
