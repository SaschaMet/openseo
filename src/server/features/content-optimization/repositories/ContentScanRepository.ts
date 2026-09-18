import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contentScans } from "@/db/schema";

export type ContentScanRecord = typeof contentScans.$inferSelect;

const HISTORY_LIMIT = 50;

/**
 * Persistence for content-optimization scans. One row per scan; the report is
 * stored as JSON once completed so reopening a scan costs nothing.
 */
export const ContentScanRepository = {
  async insertPending(args: {
    projectId: string;
    jobId: string;
    url: string;
    keyword: string;
    region: string;
  }): Promise<void> {
    await db
      .insert(contentScans)
      .values({
        id: crypto.randomUUID(),
        projectId: args.projectId,
        jobId: args.jobId,
        url: args.url,
        keyword: args.keyword,
        region: args.region,
        status: "running",
      })
      .onConflictDoNothing();
  },

  async setProgress(jobId: string, progress: number): Promise<void> {
    await db
      .update(contentScans)
      .set({ progress })
      .where(eq(contentScans.jobId, jobId));
  },

  async complete(args: {
    jobId: string;
    score: number | null;
    grade: string | null;
    pageCategory: string | null;
    report: string;
  }): Promise<void> {
    await db
      .update(contentScans)
      .set({
        status: "completed",
        progress: 100,
        score: args.score,
        grade: args.grade,
        pageCategory: args.pageCategory,
        report: args.report,
      })
      .where(eq(contentScans.jobId, args.jobId));
  },

  async fail(jobId: string, error: string): Promise<void> {
    await db
      .update(contentScans)
      .set({ status: "failed", error })
      .where(eq(contentScans.jobId, jobId));
  },

  async listForProject(
    projectId: string,
  ): Promise<
    Omit<ContentScanRecord, "report" | "progress" | "error" | "id">[]
  > {
    return db
      .select({
        projectId: contentScans.projectId,
        jobId: contentScans.jobId,
        url: contentScans.url,
        keyword: contentScans.keyword,
        region: contentScans.region,
        status: contentScans.status,
        score: contentScans.score,
        grade: contentScans.grade,
        pageCategory: contentScans.pageCategory,
        createdAt: contentScans.createdAt,
      })
      .from(contentScans)
      .where(eq(contentScans.projectId, projectId))
      .orderBy(desc(contentScans.createdAt))
      .limit(HISTORY_LIMIT);
  },

  async getForProjectByJobId(
    projectId: string,
    jobId: string,
  ): Promise<ContentScanRecord | null> {
    const rows = await db
      .select()
      .from(contentScans)
      .where(eq(contentScans.jobId, jobId))
      .limit(1);
    const row = rows[0];
    if (!row || row.projectId !== projectId) return null;
    return row;
  },

  async deleteForProject(projectId: string, jobId: string): Promise<void> {
    await db
      .delete(contentScans)
      .where(
        and(
          eq(contentScans.projectId, projectId),
          eq(contentScans.jobId, jobId),
        ),
      );
  },
};
