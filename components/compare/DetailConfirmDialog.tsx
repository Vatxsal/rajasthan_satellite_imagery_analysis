"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import Button from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Phase 3 estimate/confirm card. A detailed/smart run starts only after the
 * user accepts the block count and the PU cost — smart estimates run the
 * coarse screening pass first (cached for the run itself), so the card can
 * spend up to one quick-analysis time loading.
 */
export default function DetailConfirmDialog() {
  const open = useCompareStore((s) => s.detailConfirmOpen);
  const estimating = useCompareStore((s) => s.detailEstimating);
  const estimate = useCompareStore((s) => s.detailEstimate);
  const detail = useCompareStore((s) => s.detail);
  const confirmDetailRun = useCompareStore((s) => s.confirmDetailRun);
  const cancelDetailRun = useCompareStore((s) => s.cancelDetailRun);

  const smart = detail === "smart";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelDetailRun();
      }}
    >
      <DialogContent>
        <DialogTitle>{smart ? "Confirm smart detail run" : "Confirm detailed run"}</DialogTitle>
        <DialogDescription>
          {smart
            ? "A coarse screening pass finds the changed blocks, then only those are classified at native 10 m."
            : "The whole area is classified in native 10 m blocks — detailed runs cost the most."}
        </DialogDescription>
        {estimating || !estimate ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {smart ? "Screening the area for hot blocks…" : "Estimating block count…"}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted">Blocks</dt>
              <dd className="mono-nums">
                {estimate.blocksSelected} of {estimate.blocksTotal} (native 10 m)
              </dd>
              {smart && (
                <>
                  <dt className="text-muted">Screening pass</dt>
                  <dd className="mono-nums">
                    {estimate.screeningMeters
                      ? `~${estimate.screeningMeters} m resolution`
                      : "coarse overview"}
                  </dd>
                  <dt className="text-muted">Screening cost</dt>
                  <dd className="mono-nums">{estimate.screeningPu} PU</dd>
                </>
              )}
              <dt className="text-muted">Block cost</dt>
              <dd className="mono-nums">{estimate.blocksPu} PU</dd>
              <dt className="text-muted">Estimated cost</dt>
              <dd className="mono-nums font-semibold">{estimate.estimatedPu} PU</dd>
            </dl>
            {estimate.overQuickLimit && (
              <p className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-text">
                <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                This costs more than a standard analysis. Confirm to proceed — progress streams
                block by block and you can cancel any time.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={cancelDetailRun}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmDetailRun}>
                Run · {estimate.estimatedPu} PU
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
