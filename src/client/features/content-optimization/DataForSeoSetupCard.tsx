import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { setContentOptimizationEnabled } from "@/serverFunctions/contentOptimization";

function useSetModuleEnabled(onDone?: (enabled: boolean) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      setContentOptimizationEnabled({ data: { enabled } }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["contentOptimizationModule"],
      });
      onDone?.(result.enabled);
    },
    onError: (error: Error) => toast.error(error.message),
  });
}

/** Shown in place of the page content when the module is switched off. */
export function ModuleDisabledCard() {
  const enableMutation = useSetModuleEnabled();
  return (
    <div className="card border border-base-300 bg-base-100">
      <div className="card-body flex-row flex-wrap items-center gap-4 p-6">
        <p className="text-[15px] text-base-content/70">
          Content Optimization is turned off for this OpenSEO install.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={enableMutation.isPending}
          onClick={() => enableMutation.mutate(true)}
        >
          Turn it back on
        </button>
      </div>
    </div>
  );
}

/**
 * Shown when the module is on but no DataForSEO key is configured. Content
 * optimization reuses the same bring-your-own DataForSEO key as the rest of
 * the app, so there is no separate connect flow — just set the env var.
 */
export function DataForSeoSetupCard() {
  const disableMutation = useSetModuleEnabled((enabled) => {
    if (!enabled) {
      toast.success(
        "Content Optimization turned off. Re-enable it any time in Settings.",
      );
    }
  });

  return (
    <div className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4 p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h2 className="text-lg font-semibold">Add your DataForSEO key</h2>
        </div>
        <p className="max-w-[640px] text-[15px] leading-relaxed text-base-content/70">
          Content optimization scans run through your DataForSEO account — the
          same bring-your-own key the rest of OpenSEO uses. Set the key and
          restart to enable scans.
        </p>
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <KeyRound className="size-4" />
          <span>
            Add <code className="font-mono">DATAFORSEO_API_KEY</code> to your
            deployment&apos;s environment, then restart.
          </span>
        </div>
        <pre className="rounded-[3px] bg-base-200 px-4 py-3 font-mono text-xs">
          DATAFORSEO_API_KEY=your_key_here
        </pre>
        <p className="text-xs text-base-content/50">
          Without the key this page stays dormant and nothing else in OpenSEO is
          affected.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-xs w-fit text-base-content/50"
            disabled={disableMutation.isPending}
            onClick={() => disableMutation.mutate(false)}
          >
            Don&apos;t want this? Turn the module off
          </button>
        </div>
      </div>
    </div>
  );
}
