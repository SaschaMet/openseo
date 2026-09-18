import { describe, expect, it } from "vitest";
import type { OnPageReport } from "@/serverFunctions/contentOptimization";
import { buildWorklistEntities } from "./EntityWorklist";

function coverage(
  entities: Array<{
    entity: string;
    coverage_status: "good" | "present_not_entity" | "missing";
    importance?: number;
  }>,
): OnPageReport["entity_coverage"] {
  return {
    natural_language_entities: entities,
    highly_related_terms: [],
    keyword_variations: [],
    your_url_related_entity_density_score: null,
    competitor_related_entity_density_score: null,
  };
}

describe("buildWorklistEntities", () => {
  it("defaults omitted importance into the renderable 1-10 tier range", () => {
    const worklist = buildWorklistEntities(
      coverage([
        { entity: "SEO", coverage_status: "good" },
        { entity: "Backlinks", coverage_status: "missing", importance: 8 },
      ]),
    );
    expect(worklist.find((e) => e.name === "SEO")?.importance).toBe(1);
    expect(worklist.find((e) => e.name === "Backlinks")?.importance).toBe(8);
  });

  it("clamps out-of-range importance into the tier range", () => {
    const worklist = buildWorklistEntities(
      coverage([
        { entity: "Zero", coverage_status: "good", importance: 0 },
        { entity: "Over", coverage_status: "good", importance: 15 },
      ]),
    );
    expect(worklist.find((e) => e.name === "Zero")?.importance).toBe(1);
    expect(worklist.find((e) => e.name === "Over")?.importance).toBe(10);
  });

  it("folds highly related terms in at importance 10", () => {
    const cov: OnPageReport["entity_coverage"] = {
      natural_language_entities: [],
      highly_related_terms: [
        { entity: "Technical SEO", coverage_status: "missing" },
      ],
      keyword_variations: [],
      your_url_related_entity_density_score: null,
      competitor_related_entity_density_score: null,
    };
    const worklist = buildWorklistEntities(cov);
    expect(worklist.find((e) => e.name === "Technical SEO")?.importance).toBe(
      10,
    );
  });
});
