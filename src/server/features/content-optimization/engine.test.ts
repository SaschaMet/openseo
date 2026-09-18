import { describe, expect, it } from "vitest";

import {
  buildBenchmarks,
  buildCompetitorTermCoverage,
  buildInternalLinking,
  buildReport,
  computeScore,
  fleschReadingEase,
  type ParsedPage,
} from "@/server/features/content-optimization/engine";
import { applyLlmAnalysis } from "@/server/features/content-optimization/llm";
import {
  onPageReportSchema,
  type LlmContentAnalysis,
} from "@/shared/content-optimization";

function page(overrides: Partial<ParsedPage> = {}): ParsedPage {
  return {
    url: "https://example.com/",
    title: "Example Page",
    description: "An example page description",
    wordCount: 800,
    text: "This is some example body copy with a few words in it.",
    h1Count: 1,
    h2Count: 5,
    h3Count: 3,
    imageCount: 4,
    internalLinkCount: 6,
    externalLinkCount: 2,
    ...overrides,
  };
}

describe("fleschReadingEase", () => {
  it("returns null for empty text", () => {
    expect(fleschReadingEase("")).toBeNull();
  });

  it("scores simple short-sentence text high", () => {
    const simple = "The cat sat. The dog ran. We ate food. It was good.";
    expect(fleschReadingEase(simple)).toBeGreaterThan(80);
  });

  it("scores long complex text lower than simple text", () => {
    const simple =
      "The cat sat on the mat. The dog ran fast. We ate good food today.";
    const complex =
      "The aforementioned organizational infrastructure necessitates a comprehensive reevaluation of the underlying methodological presuppositions.";
    expect(fleschReadingEase(simple)!).toBeGreaterThan(
      fleschReadingEase(complex)!,
    );
  });
});

describe("computeScore", () => {
  it("returns 100 / A when every component is full marks", () => {
    const { score, grade, focusAreas } = computeScore({
      wordCount: 100,
      heading: 100,
      readability: 100,
      consistency: 100,
      lighthouse: 100,
    });
    expect(score).toBe(100);
    expect(grade).toBe("A");
    expect(focusAreas).toEqual([]);
  });

  it("returns 0 / F when every component is zero", () => {
    const { score, grade } = computeScore({
      wordCount: 0,
      heading: 0,
      readability: 0,
      consistency: 0,
      lighthouse: 0,
    });
    expect(score).toBe(0);
    expect(grade).toBe("F");
  });

  it("renormalizes weights when lighthouse is unavailable", () => {
    // Without lighthouse (weight 0.15), the remaining weights sum to 0.85.
    // All four at 100 must still yield 100.
    const { score } = computeScore({
      wordCount: 100,
      heading: 100,
      readability: 100,
      consistency: 100,
      lighthouse: null,
    });
    expect(score).toBe(100);
  });

  it("produces a weighted average across components", () => {
    // wordCount 0.30*100 + heading 0.20*50 + readability 0.20*50 +
    // consistency 0.15*0 + lighthouse 0.15*100 = 30 + 10 + 10 + 0 + 15 = 65
    const { score, grade } = computeScore({
      wordCount: 100,
      heading: 50,
      readability: 50,
      consistency: 0,
      lighthouse: 100,
    });
    expect(score).toBe(65);
    expect(grade).toBe("D");
  });

  it("flags low components as focus areas", () => {
    const { focusAreas } = computeScore({
      wordCount: 100,
      heading: 100,
      readability: 100,
      consistency: 20,
      lighthouse: 100,
    });
    expect(focusAreas).toEqual(["Consistency"]);
  });
});

describe("buildBenchmarks", () => {
  it("averages page-1 metrics and maps the target metrics", () => {
    const target = page({ wordCount: 500, h2Count: 4, imageCount: 2 });
    const page1 = [
      page({ wordCount: 800, h2Count: 5, imageCount: 4 }),
      page({ wordCount: 1000, h2Count: 7, imageCount: 6 }),
    ];
    const benchmarks = buildBenchmarks(target, page1);
    expect(benchmarks.page1_average.word_count).toBe(900);
    expect(benchmarks.page1_average.h2_count).toBe(6);
    expect(benchmarks.your_url.word_count).toBe(500);
    expect(benchmarks.your_url.h2_count).toBe(4);
  });

  it("handles a single page-1 result", () => {
    const target = page({ wordCount: 500 });
    const page1 = [page({ wordCount: 900 })];
    const benchmarks = buildBenchmarks(target, page1);
    expect(benchmarks.page1_average.word_count).toBe(900);
  });

  it("yields null averages when there is no page-1 data", () => {
    const benchmarks = buildBenchmarks(page(), []);
    expect(benchmarks.page1_average.word_count).toBeNull();
  });
});

describe("buildCompetitorTermCoverage", () => {
  it("counts term occurrences in the target vs each competitor", () => {
    const target = page({
      text: "seo seo keyword keyword keyword research",
    });
    const page1 = [
      page({ url: "https://a.com", text: "seo keyword" }),
      page({ url: "https://b.com", text: "seo seo seo keyword keyword" }),
    ];
    const coverage = buildCompetitorTermCoverage(target, page1, [
      "seo",
      "keyword",
      "research",
    ]);
    const seo = coverage.terms.find((t) => t.keyword === "seo")!;
    expect(seo.your_url_count).toBe(2);
    expect(seo.competitor_counts).toEqual([1, 3]);
    expect(coverage.domains).toEqual(["a.com", "b.com"]);
  });

  it("omits terms that appear nowhere", () => {
    const target = page({ text: "hello world" });
    const page1 = [page({ url: "https://a.com", text: "nothing here" })];
    const coverage = buildCompetitorTermCoverage(target, page1, ["absent"]);
    expect(coverage.terms).toEqual([]);
  });
});

describe("buildInternalLinking", () => {
  it("suggests same-domain page-1 pages as internal link sources", () => {
    const target = page({ url: "https://example.com/target" });
    const page1 = [
      page({ url: "https://example.com/other" }),
      page({ url: "https://a.com" }),
    ];
    const linking = buildInternalLinking(target, page1);
    expect(linking.to_your_url).toBe("https://example.com/target");
    expect(linking.add_internal_links_from).toEqual([
      "https://example.com/other",
    ]);
  });
});

describe("buildReport", () => {
  it("assembles a report that satisfies the schema", () => {
    const report = buildReport({
      url: "https://example.com/",
      keyword: "seo tools",
      region: "US",
      target: page(),
      page1: [page({ url: "https://a.com" })],
      relatedKeywords: ["seo", "tools"],
      lighthouseSeoScore: 90,
      reportDate: "2026-07-10",
    });
    expect(onPageReportSchema.safeParse(report).success).toBe(true);
    expect(report.meta.target_keyword).toBe("seo tools");
    expect(report.on_page_optimization.score).toBeTypeOf("number");
    expect(report.on_page_optimization.summary).not.toBe("");
  });
});

describe("applyLlmAnalysis", () => {
  const base = buildReport({
    url: "https://example.com/",
    keyword: "seo tools",
    region: "US",
    target: page(),
    page1: [page({ url: "https://a.com" })],
    relatedKeywords: ["seo", "tools"],
    lighthouseSeoScore: 90,
    reportDate: "2026-07-10",
  });

  it("merges entity coverage and topic classification from the LLM", () => {
    const llm: LlmContentAnalysis = {
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
    const merged = applyLlmAnalysis(base, llm);
    expect(merged.entity_coverage.natural_language_entities).toHaveLength(1);
    expect(merged.topic_and_classification.your_page?.category).toBe(
      "Software",
    );
    expect(merged.on_page_optimization.summary).toBe("A crisp summary.");
    expect(onPageReportSchema.safeParse(merged).success).toBe(true);
  });

  it("leaves the report intact when the LLM returns nothing", () => {
    const empty: LlmContentAnalysis = {
      natural_language_entities: [],
      highly_related_terms: [],
      keyword_variations: [],
      your_url_related_entity_density_score: null,
      competitor_related_entity_density_score: null,
      page_classification: [],
      your_page: null,
      suggested_title: null,
      topic_coverage: [],
      topical_authority_questions: {},
      summary: null,
    };
    const merged = applyLlmAnalysis(base, empty);
    expect(merged.on_page_optimization.summary).toBe(
      base.on_page_optimization.summary,
    );
    expect(onPageReportSchema.safeParse(merged).success).toBe(true);
  });
});
