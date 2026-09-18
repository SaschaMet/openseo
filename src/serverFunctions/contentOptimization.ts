import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { ContentOptimizationService } from "@/server/features/content-optimization/services/ContentOptimizationService";
import { CONTENT_SCAN_REGIONS } from "@/shared/content-optimization";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";

export type { OnPageReport } from "@/shared/content-optimization";

const startScanInputSchema = z.object({
  projectId: z.string().min(1),
  url: z.string().trim().url().max(2048),
  keyword: z.string().trim().min(1).max(150),
  region: z.enum(CONTENT_SCAN_REGIONS).optional(),
});

const jobInputSchema = z.object({
  projectId: z.string().min(1),
  jobId: z.string().trim().min(1).max(128),
});

// Module state is deployment-wide (one BYO DataForSEO key per install), so the
// status is app-scoped rather than project-scoped. Toggling it is an operator
// action, so only owners/admins may change it (canManage is exposed so the UI
// can disable the control for other members).
function canManageModule(role: string): boolean {
  return role === "owner" || role === "admin";
}

export const getContentOptimizationStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => ({
    ...(await ContentOptimizationService.connectionStatus()),
    canManage: canManageModule(context.role),
  }));

export const setContentOptimizationEnabled = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ enabled: z.boolean() }))
  .handler(async ({ data, context }) => {
    if (!canManageModule(context.role)) {
      throw new AppError(
        "FORBIDDEN",
        "Only owners and admins can change this setting.",
      );
    }
    return ContentOptimizationService.setModuleEnabled(data.enabled);
  });

export const startContentScan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startScanInputSchema)
  .handler(async ({ data, context }) =>
    ContentOptimizationService.startScan({
      projectId: data.projectId,
      url: data.url,
      keyword: data.keyword,
      region: data.region,
      billingCustomer: context,
    }),
  );

export const getContentScanView = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(jobInputSchema)
  .handler(async ({ data }) =>
    ContentOptimizationService.getView(data.projectId, data.jobId),
  );

export const deleteContentScan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(jobInputSchema)
  .handler(async ({ data }) => {
    await ContentOptimizationService.deleteScan(data.projectId, data.jobId);
    return { ok: true };
  });

export const listContentScans = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(async ({ data }) =>
    ContentOptimizationService.listHistory(data.projectId),
  );
