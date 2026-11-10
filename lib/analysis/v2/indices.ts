/**
 * Phase 2.3 — extended index stack from the 7 optical composite bands.
 *
 * NDVI / MNDWI / NDBI keep the exact v1 formulas (zero denominator → 0) so
 * parity with the v1 classifier is measurable. The additions (NDWI, NDMI,
 * BSI, AWEI, brightness, NBR, vBare, vBright) are the inputs of the
 * multi-index vote (§2.5): moisture for vegetation, bare-soil + brightness
 * for built-up, AWEI for water. vBare/vBright are 10 m-native visible-band
 * indices — the anchor/corroboration for bare-built change that does not
 * depend on the 20 m SWIR bands (B11/B12 vote only as supporting evidence).
 */
import type { CompositeBands } from "../composite";

export interface V2Indices {
  ndvi: Float32Array;
  mndwi: Float32Array;
  ndbi: Float32Array;
  /** Normalized Difference Moisture Index (B08−B11)/(B08+B11). */
  ndmi: Float32Array;
  /** McFeeters water index (B03−B08)/(B03+B08) — open-water corroboration. */
  ndwi: Float32Array;
  /** Bare Soil Index ((B11+B04)−(B08+B02))/((B11+B04)+(B08+B02)). */
  bsi: Float32Array;
  /** AWEIsh 4(B03−B11)−(0.25·B08+0.75·B04) — water mapping, unnormalised. */
  awei: Float32Array;
  /** Brightness = mean of the 7 optical bands (exposure/construction cue). */
  brightness: Float32Array;
  /** Normalized Burn Ratio (B08−B12)/(B08+B12) — CVA dimension. */
  nbr: Float32Array;
  /** Visible bareness (B02−B03)/(B02+B03) — blue/green contrast; rises on
   *  bright built surfaces, flat for bare soil. 10 m native (anchor index). */
  vBare: Float32Array;
  /** Visible brightness = mean of B02/B03/B04 (10 m native exposure cue). */
  vBright: Float32Array;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/** Derives the full v2 index stack (all pixels; masking happens later). */
export function deriveV2Indices(b: CompositeBands): V2Indices {
  const n = b.b04.length;
  const out: V2Indices = {
    ndvi: new Float32Array(n),
    mndwi: new Float32Array(n),
    ndbi: new Float32Array(n),
    ndmi: new Float32Array(n),
    ndwi: new Float32Array(n),
    bsi: new Float32Array(n),
    awei: new Float32Array(n),
    brightness: new Float32Array(n),
    nbr: new Float32Array(n),
    vBare: new Float32Array(n),
    vBright: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const g = b.b08[i];
    const r = b.b04[i];
    const gr = b.b03[i];
    const bl = b.b02[i];
    const sw1 = b.b11[i];
    const sw2 = b.b12[i];
    out.ndvi[i] = ratio(g - r, g + r);
    out.mndwi[i] = ratio(gr - sw1, gr + sw1);
    out.ndbi[i] = ratio(sw1 - g, sw1 + g);
    out.ndmi[i] = ratio(g - sw1, g + sw1);
    out.ndwi[i] = ratio(gr - g, gr + g);
    out.bsi[i] = ratio(sw1 + r - (g + bl), sw1 + r + (g + bl));
    out.awei[i] = 4 * (gr - sw1) - (0.25 * g + 0.75 * r);
    out.brightness[i] =
      (b.b02[i] + gr + r + b.b05[i] + g + sw1 + sw2) / 7;
    out.nbr[i] = ratio(g - sw2, g + sw2);
    out.vBare[i] = ratio(bl - gr, bl + gr);
    out.vBright[i] = (bl + gr + r) / 3;
  }
  return out;
}

/** Recent-orbit index triple extracted from a parsed composite (persistence check). */
export interface RecentIndices {
  ndvi: Float32Array;
  mndwi: Float32Array;
  ndbi: Float32Array;
}
