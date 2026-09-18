import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  DEFAULT_LOCATION_CODE,
  LOCATION_OPTIONS,
} from "@/shared/keyword-locations";
import {
  onPageReportSchema,
  type ContentScanRegion,
  type OnPageReport,
} from "@/shared/content-optimization";
import { isRecord } from "@/server/lib/dataforseo/envelope";
import type { SerpLiveItem } from "@/server/lib/dataforseo/serp";
import type { ParsedPage } from "../engine";
import { buildReport } from "../engine";
import { applyLlmAnalysis, runLlmContentAnalysis } from "../llm";
import { ContentScanRepository } from "../repositories/ContentScanRepository";
import { ContentOptimizationSettingsRepository } from "../repositories/ContentOptimizationSettingsRepository";

/**
 * Content optimization scans, powered by the operator's DataForSEO key (no
 * separate provider connection). A scan is an in-process background task: the
 * server function inserts a `running` row and returns the job id immediately,
 * then the pipeline (SERP → content parsing → Lighthouse → related keywords →
 * engine → LLM pass) runs to completion and persists the report. Self-hosted
 * Node has no durable workflow runtime, so a scan that outlives a process
 * restart is recovered as `failed` on the next poll (see getView).
 */

const PAGE1_LIMIT = 10;
const RELATED_KEYWORD_LIMIT = 30;
const LIGHHOUSE_TIMEOUT_MS = 45_000;
const STALE_SCAN_MS = 10 * 60 * 1000;

// In-memory set of scans whose background task is live in this process.
const activeScans = new Set<string>();

function locationForRegion(region: string): {
  locationCode: number;
  languageCode: string;
} {
  const option = LOCATION_OPTIONS.find(
    (o) => o.shortLabel === region.toUpperCase(),
  );
  return {
    locationCode: option?.code ?? DEFAULT_LOCATION_CODE,
    languageCode: option?.languageCode ?? "en",
  };
}

function parseStoredReport(raw: string | null): OnPageReport | null {
  if (!raw) return null;
  try {
    const parsed = onPageReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pageCategoryOf(report: OnPageReport): string | null {
  return report.topic_and_classification.your_page?.category ?? null;
}

function organicUrls(items: SerpLiveItem[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of items) {
    if (item.type !== "organic" || !item.url) continue;
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(item.url);
  }
  return urls;
}

function relatedKeywordTerms(items: unknown[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const keyword = item.keyword;
    if (typeof keyword !== "string" || keyword.length === 0) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(keyword);
  }
  return terms.slice(0, RELATED_KEYWORD_LIMIT);
}

async function fetchLighthouseSeo(
  url: string,
  billingCustomer: BillingCustomerContext,
): Promise<number | null> {
  const dataforseo = createDataforseoClient(billingCustomer);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIGHHOUSE_TIMEOUT_MS);
    try {
      const payload = await dataforseo.lighthouse.live({
        url,
        strategy: "mobile",
      });
      return payload.scores.seo;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Lighthouse is a best-effort score component; a failure renormalizes the
    // score over the remaining components rather than failing the scan.
    return null;
  }
}

async function runScan(input: {
  jobId: string;
  url: string;
  keyword: string;
  region: string;
  billingCustomer: BillingCustomerContext;
}): Promise<void> {
  const { jobId, url, keyword, region, billingCustomer } = input;
  try {
    const dataforseo = createDataforseoClient(billingCustomer);
    const { locationCode, languageCode } = locationForRegion(region);

    // 1. SERP: page-1 organic URLs for the keyword.
    await ContentScanRepository.setProgress(jobId, 10);
    const serpItems = await dataforseo.serp.live({
      keyword,
      locationCode,
      languageCode,
      depth: PAGE1_LIMIT,
    });
    const page1Urls = organicUrls(serpItems).slice(0, PAGE1_LIMIT);

    // 2. Content parsing: the target page plus the page-1 results, batched.
    await ContentScanRepository.setProgress(jobId, 35);
    const parsed = await dataforseo.onPage.contentParsing([url, ...page1Urls]);
    const byUrl = new Map(parsed.map((page) => [page.url, page]));
    const target: ParsedPage = byUrl.get(url) ?? {
      url,
      title: null,
      description: null,
      wordCount: null,
      text: null,
      h1Count: 0,
      h2Count: 0,
      h3Count: 0,
      imageCount: 0,
      internalLinkCount: 0,
      externalLinkCount: 0,
    };
    const page1: ParsedPage[] = page1Urls
      .map((u) => byUrl.get(u))
      .filter((page): page is ParsedPage => page !== undefined);

    // 3. Lighthouse SEO score (best-effort).
    await ContentScanRepository.setProgress(jobId, 60);
    const lighthouseSeoScore = await fetchLighthouseSeo(url, billingCustomer);

    // 4. Related keywords: candidate terms for term-coverage.
    await ContentScanRepository.setProgress(jobId, 75);
    const related = await dataforseo.keywords.related({
      keyword,
      locationCode,
      languageCode,
      limit: RELATED_KEYWORD_LIMIT,
    });
    const relatedKeywords = relatedKeywordTerms(related);

    // 5. Build the data-driven report, then merge the LLM pass.
    await ContentScanRepository.setProgress(jobId, 85);
    const report = buildReport({
      url,
      keyword,
      region,
      target,
      page1,
      relatedKeywords,
      lighthouseSeoScore,
      reportDate: new Date().toISOString().slice(0, 10),
    });
    const llm = await runLlmContentAnalysis({
      keyword,
      targetText: target.text,
      page1Texts: page1.map((page) => ({ url: page.url, text: page.text })),
      relatedKeywords,
    });
    const finalReport = applyLlmAnalysis(report, llm);

    await ContentScanRepository.complete({
      jobId,
      score: finalReport.on_page_optimization.score,
      grade: finalReport.on_page_optimization.grade,
      pageCategory: pageCategoryOf(finalReport),
      report: JSON.stringify(finalReport),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ContentScanRepository.fail(jobId, message).catch(() => {
      // The row update is best-effort; the scan is already failed.
    });
  } finally {
    // Remove from the active set only after the row is persisted, so a poll
    // that lands in the gap never misreads a finished scan as stale.
    activeScans.delete(jobId);
  }
}

export const ContentOptimizationService = {
  async connectionStatus(): Promise<{
    enabled: boolean;
    configured: boolean;
    ok: boolean;
  }> {
    const enabled = await this.isModuleEnabled();
    const configured =
      (await getOptionalEnvValue("DATAFORSEO_API_KEY")) !== null;
    return { enabled, configured, ok: enabled && configured };
  },

  async isModuleEnabled(): Promise<boolean> {
    return ContentOptimizationSettingsRepository.getEnabled();
  },

  async setModuleEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    await ContentOptimizationSettingsRepository.setEnabled(enabled);
    return { enabled };
  },

  async startScan(input: {
    projectId: string;
    url: string;
    keyword: string;
    region?: ContentScanRegion;
    billingCustomer: BillingCustomerContext;
  }): Promise<{ jobId: string }> {
    const status = await this.connectionStatus();
    if (!status.enabled) {
      throw new AppError(
        "FORBIDDEN",
        "Content Optimization is disabled. Enable it under Settings.",
      );
    }
    if (!status.configured) {
      throw new AppError(
        "AUTH_CONFIG_MISSING",
        "Content Optimization needs a DataForSEO API key. Set DATAFORSEO_API_KEY.",
      );
    }

    const region = input.region ?? "US";
    const jobId = crypto.randomUUID();
    await ContentScanRepository.insertPending({
      projectId: input.projectId,
      jobId,
      url: input.url,
      keyword: input.keyword,
      region,
    });

    // Fire-and-forget: the row is the source of truth, so the UI can poll it
    // across navigations. We intentionally do not await the pipeline.
    activeScans.add(jobId);
    void runScan({
      jobId,
      url: input.url,
      keyword: input.keyword,
      region,
      billingCustomer: input.billingCustomer,
    });

    return { jobId };
  },

  async getView(
    projectId: string,
    jobId: string,
  ): Promise<
    | {
        status: "completed";
        report: OnPageReport;
        pageCategory: string | null;
      }
    | { status: "running"; progress: number | null }
    | { status: "failed"; error: string | null }
  > {
    const row = await ContentScanRepository.getForProjectByJobId(
      projectId,
      jobId,
    );
    if (!row) {
      throw new AppError("NOT_FOUND", "Content scan not found");
    }

    if (row.status === "completed") {
      const report = parseStoredReport(row.report);
      if (report) {
        return {
          status: "completed",
          report,
          pageCategory: pageCategoryOf(report),
        };
      }
      // A completed row whose report failed to parse is unrecoverable.
      return { status: "failed", error: "Stored report could not be read" };
    }

    if (row.status === "running") {
      // Stale recovery: a running row with no live in-process task either lost
      // its process (restart) or its task crashed. Mark it failed so the UI
      // stops polling forever.
      const isLive = activeScans.has(jobId);
      const isStale =
        Date.now() - new Date(row.createdAt).getTime() > STALE_SCAN_MS;
      if (!isLive && isStale) {
        await ContentScanRepository.fail(
          jobId,
          "The scan did not complete (the server may have restarted).",
        );
        return {
          status: "failed",
          error: "The scan did not complete (the server may have restarted).",
        };
      }
      return { status: "running", progress: row.progress };
    }

    return { status: "failed", error: row.error };
  },

  async listHistory(projectId: string) {
    return ContentScanRepository.listForProject(projectId);
  },

  async deleteScan(projectId: string, jobId: string): Promise<void> {
    await ContentScanRepository.deleteForProject(projectId, jobId);
  },
};
