import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  isRecord,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/**
 * DataForSEO OnPage content parsing (live).
 *
 * One batched POST parses the content of many URLs at once — no crawl task or
 * task_get polling required. We use it to gather per-page content metrics
 * (word count, heading structure, images, links, body text) for the target
 * page and the page-1 SERP results, which the content-optimization engine
 * turns into benchmarks, a score, and the raw text for the LLM entity pass.
 */

const CONTENT_PARSING_PATH = "/v3/on_page/content_parsing/live";
const OK_STATUS = 20000;
const BILLING_PATH: string[] = ["v3", "on_page", "content_parsing", "live"];

export interface ParsedPage {
  url: string;
  title: string | null;
  description: string | null;
  wordCount: number | null;
  /** Body text (for the LLM entity-extraction pass). May be large. */
  text: string | null;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  imageCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function countHeadings(headings: unknown): {
  h1: number;
  h2: number;
  h3: number;
} {
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  if (!Array.isArray(headings)) return { h1, h2, h3 };
  for (const heading of headings) {
    if (!isRecord(heading)) continue;
    const tag =
      typeof heading.tag === "string" ? heading.tag.toLowerCase() : null;
    const level = typeof heading.level === "number" ? heading.level : null;
    if (tag === "h1" || level === 1) h1 += 1;
    else if (tag === "h2" || level === 2) h2 += 1;
    else if (tag === "h3" || level === 3) h3 += 1;
  }
  return { h1, h2, h3 };
}

/**
 * Return the first record element of an unknown that is (or may be) an array.
 * Iterates as `unknown[]` so no `any` leaks into the candidates.
 */
function firstRecordOf(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value as unknown[]) {
    if (isRecord(entry)) return entry;
  }
  return null;
}

/**
 * The parsed content item can appear at a few different shapes depending on the
 * endpoint flavor: `result[0]`, `result[0].items[0]`, or
 * `result[0].se_results[0].items[0]`. Prefer the first candidate that looks
 * like a content item (has any of the fields we read).
 */
function extractContentItem(result: unknown): Record<string, unknown> | null {
  const first = firstRecordOf(result);
  if (!first) return null;
  const candidates: Record<string, unknown>[] = [first];
  const fromItems = firstRecordOf(first.items);
  if (fromItems) candidates.push(fromItems);
  const se = firstRecordOf(first.se_results);
  if (se) {
    const seItem = firstRecordOf(se.items);
    if (seItem) candidates.push(seItem);
  }
  for (const candidate of candidates) {
    if (
      "word_count" in candidate ||
      "headings" in candidate ||
      "text" in candidate
    ) {
      return candidate;
    }
  }
  return candidates[0] ?? null;
}

export async function fetchContentParsing(
  urls: string[],
): Promise<DataforseoApiResponse<ParsedPage[]>> {
  const billingPath = BILLING_PATH;
  if (urls.length === 0) {
    return { data: [], billing: { path: billingPath, costUsd: 0 } };
  }

  // One task per URL; the echoed position maps the result back to the URL
  // (DataForSEO preserves task order in live responses).
  const tasks = urls.map((url, index) => ({ id: String(index), url }));
  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    CONTENT_PARSING_PATH,
    tasks,
  );

  if (!response || response.status_code !== OK_STATUS) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      response?.status_message || "DataForSEO content_parsing failed",
    );
  }

  const parsed: ParsedPage[] = [];
  let costUsd = 0;
  const taskList = response.tasks ?? [];
  for (let i = 0; i < taskList.length; i += 1) {
    const task = taskList[i];
    costUsd += task.cost ?? 0;
    // A per-URL failure (404, JS-heavy page, timeout) skips that URL but keeps
    // the rest of the batch — a scan of 10 SERP pages should not die because one
    // competitor page is unreachable.
    if (task.status_code !== OK_STATUS) continue;
    const item = extractContentItem(task.result);
    if (!item) continue;
    const { h1, h2, h3 } = countHeadings(item.headings);
    parsed.push({
      url: urls[i] ?? (typeof item.url === "string" ? item.url : ""),
      title: readString(item.title),
      description: readString(item.description),
      wordCount: readNumber(item.word_count),
      text: readString(item.text),
      h1Count: h1,
      h2Count: h2,
      h3Count: h3,
      imageCount: readArrayLength(item.images),
      internalLinkCount: readArrayLength(item.internal_links),
      externalLinkCount: readArrayLength(item.external_links),
    });
  }

  return {
    data: parsed,
    billing: {
      path: BILLING_PATH,
      costUsd,
    },
  };
}

/**
 * Return `urls` minus any that match `target` (case-insensitive). Used to keep
 * the scanned page out of the competitor batch so it is parsed (and billed) only
 * once and never benchmarked against itself.
 */
export function withoutTarget(urls: string[], target: string): string[] {
  const key = target.toLowerCase();
  return urls.filter((url) => url.toLowerCase() !== key);
}
