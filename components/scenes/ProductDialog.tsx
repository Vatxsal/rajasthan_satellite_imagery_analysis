"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import type { Scene, SceneProduct } from "@/lib/data";
import { buildCopernicusBrowserUrl } from "@/lib/copernicusBrowser";
import Button from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

interface ProductDialogProps {
  scene: Scene;
  onClose: () => void;
}

const STEPS = [
  "Log in with your free Copernicus account.",
  "Select the tile.",
  "Use the download icon to get the ZIP.",
];

/** Each tile deep-links into Copernicus Browser on that tile's footprint. */
function productUrl(scene: Scene, product: SceneProduct): string {
  return buildCopernicusBrowserUrl({
    date: scene.date,
    composite: scene.composite,
    bbox: product.bbox,
  });
}

/**
 * Full-product dialog: the daily mosaic id ("S2_DAILY_…") is ours, so this
 * lists the ORIGINAL Sentinel-2 catalogue products (one per MGRS tile) that
 * make up the scene, ready to copy or follow into Copernicus Browser.
 * The .SAFE ZIPs are never proxied — they come straight from the user's own
 * Copernicus account and quota.
 */
export default function ProductDialog({ scene, onClose }: ProductDialogProps) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const products = scene.products ?? [];
  const allIds = products.map((product) => product.id).join("\n");

  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(value);
        window.setTimeout(() => setCopied((c) => (c === value ? null : c)), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4 max-sm:p-0"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-dialog-title"
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-float max-sm:h-full max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id="product-dialog-title" className="text-sm font-semibold text-text">
              Full product (.SAFE ZIP)
            </h2>
            <p className="mono-nums mt-0.5 text-[11px] text-muted">
              {scene.date} · {products.length || scene.tileCount || 1} tile
              {(products.length || scene.tileCount || 1) > 1 ? "s" : ""} · original Sentinel-2
              catalogue ids
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 pt-3">
            <ol className="space-y-1 text-xs leading-relaxed text-muted">
              {STEPS.map((step, index) => (
                <li key={step} className="flex gap-2">
                  <span className="mono-nums text-accent">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Data Space downloads use your own account and quota — this app never stores your
              credentials or proxies the ZIP.
            </p>
          </div>

          <div className="space-y-2 p-4">
          {products.length === 0 && (
            <p className="rounded border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
              This scene carries no per-tile catalogue id. Copy the scene id instead:
              <span className="mono-nums mt-1 block break-all text-text">{scene.sceneId}</span>
            </p>
          )}
          {products.map((product) => {
            const isCopied = copied === product.id;
            return (
              <div
                key={product.id}
                className="rounded border border-border bg-surface-2 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="mono-nums text-xs font-medium text-text">
                    {product.tile || "Tile"}
                  </span>
                  <span className="mono-nums text-[11px] text-muted">
                    Cloud {product.cloudCover.toFixed(1)}%
                  </span>
                </div>
                <p
                  className="mono-nums mt-1 break-all text-[11px] text-muted"
                  title={product.id}
                >
                  {product.id}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => copy(product.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors duration-150",
                      isCopied
                        ? "border-accent text-accent"
                        : "border-border text-muted hover:bg-surface hover:text-text",
                    )}
                  >
                    {isCopied ? <Check size={12} /> : <Copy size={12} />}
                    {isCopied ? "Copied" : "Copy id"}
                  </button>
                  <a
                    href={productUrl(scene, product)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted transition-colors duration-150 hover:bg-surface hover:text-text"
                  >
                    <ExternalLink size={12} />
                    Open in Copernicus Browser
                  </a>
                </div>
              </div>
            );
          })}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {products.length > 1 && (
            <Button variant="ghost" onClick={() => copy(allIds)}>
              {copied === allIds ? "Copied all" : `Copy ${products.length} ids`}
            </Button>
          )}
          <Button variant="primary" onClick={onClose} className="ml-auto">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
