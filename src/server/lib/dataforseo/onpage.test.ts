import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import { AppError } from "@/server/lib/errors";
import {
  fetchContentParsing,
  withoutTarget,
} from "@/server/lib/dataforseo/onpage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withoutTarget", () => {
  it("removes the target URL (case-insensitive) from the list", () => {
    expect(
      withoutTarget(
        ["https://example.com/", "https://a.com", "https://example.com/"],
        "https://example.com/",
      ),
    ).toEqual(["https://a.com"]);
  });

  it("keeps the list unchanged when the target is not present", () => {
    expect(
      withoutTarget(["https://a.com", "https://b.com"], "https://example.com/"),
    ).toEqual(["https://a.com", "https://b.com"]);
  });

  it("returns an empty list when only the target is present", () => {
    expect(
      withoutTarget(["https://example.com/"], "https://example.com/"),
    ).toEqual([]);
  });
});

function stubFetch(body: unknown) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// A representative content_parsing item (fields we read; the rest is passthrough).
function item(overrides: Record<string, unknown> = {}) {
  return {
    type: "content_parsing_element",
    word_count: 800,
    character_count: 4600,
    title: "Example title",
    description: "Example description",
    text: "Some body copy repeated enough to count as words.",
    headings: [
      { tag: "h1", text: "Main", level: 1 },
      { tag: "h2", text: "Sub A", level: 2 },
      { tag: "h2", text: "Sub B", level: 2 },
      { tag: "h3", text: "Sub-sub", level: 3 },
    ],
    images: [{ src: "a.png" }, { src: "b.png" }],
    internal_links: [{ url: "https://example.com/a" }],
    external_links: [
      { url: "https://other.com" },
      { url: "https://other2.com" },
    ],
    ...overrides,
  };
}

describe("fetchContentParsing", () => {
  it("parses a batched response and sums billing across tasks", async () => {
    stubFetch({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "0",
          status_code: 20000,
          cost: 0.002,
          result: [item()],
        },
        {
          id: "1",
          status_code: 20000,
          cost: 0.0015,
          result: [item({ word_count: 120, title: "Short" })],
        },
      ],
    });

    const res = await fetchContentParsing([
      "https://example.com/",
      "https://example.com/short",
    ]);

    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({
      url: "https://example.com/",
      wordCount: 800,
      title: "Example title",
      h1Count: 1,
      h2Count: 2,
      h3Count: 1,
      imageCount: 2,
      internalLinkCount: 1,
      externalLinkCount: 2,
    });
    expect(res.data[1]).toMatchObject({
      url: "https://example.com/short",
      wordCount: 120,
      title: "Short",
    });
    expect(res.billing).toMatchObject({
      costUsd: 0.0035,
    });
  });

  it("skips per-task failures but keeps the successful URLs", async () => {
    stubFetch({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "0",
          status_code: 20000,
          cost: 0.002,
          result: [item()],
        },
        {
          id: "1",
          status_code: 16006,
          status_message: "Page not found.",
          cost: 0,
          result: [],
        },
      ],
    });

    const res = await fetchContentParsing([
      "https://example.com/",
      "https://example.com/missing",
    ]);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].url).toBe("https://example.com/");
  });

  it("reads the content item whether it is nested under items[] or at result[0]", async () => {
    stubFetch({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "0",
          status_code: 20000,
          cost: 0.002,
          result: [{ items: [item()] }],
        },
      ],
    });

    const res = await fetchContentParsing(["https://example.com/"]);
    expect(res.data[0].wordCount).toBe(800);
  });

  it("throws an AppError when the top-level envelope is not ok", async () => {
    stubFetch({
      status_code: 16010,
      status_message: "Insufficient credits.",
      tasks: [],
    });

    await expect(
      fetchContentParsing(["https://example.com/"]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("returns empty data (not an error) when a task succeeds but has no content", async () => {
    stubFetch({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "0",
          status_code: 20000,
          cost: 0.002,
          result: [],
        },
      ],
    });

    const res = await fetchContentParsing(["https://example.com/"]);
    expect(res.data).toHaveLength(0);
  });
});
