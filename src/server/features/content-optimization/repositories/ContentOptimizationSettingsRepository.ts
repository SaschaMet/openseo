import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contentOptimizationSettings } from "@/db/schema";

const DEFAULT_ROW_ID = "default";

/**
 * Deployment-wide switch for the Content Optimization module. A single row
 * (id = "default"); the operator toggles it under Settings > Features. The
 * module additionally requires DATAFORSEO_API_KEY to actually run scans.
 */
export const ContentOptimizationSettingsRepository = {
  async getEnabled(): Promise<boolean> {
    const rows = await db
      .select({ enabled: contentOptimizationSettings.enabled })
      .from(contentOptimizationSettings)
      .where(eq(contentOptimizationSettings.id, DEFAULT_ROW_ID))
      .limit(1);
    // Absent row means the operator has never touched the switch: on by
    // default (the module still gates on the DataForSEO key).
    return rows[0]?.enabled ?? true;
  },

  async setEnabled(enabled: boolean): Promise<void> {
    await db
      .insert(contentOptimizationSettings)
      .values({ id: DEFAULT_ROW_ID, enabled })
      .onConflictDoUpdate({
        target: contentOptimizationSettings.id,
        set: { enabled },
      });
  },
};
