/** Shared GeoJSON helpers for map sources built at runtime. */

export const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function toFeature(
  properties: Record<string, unknown>,
  geometry: GeoJSON.Geometry,
): GeoJSON.Feature {
  return { type: "Feature", properties, geometry };
}

export function featureCollection(
  features: GeoJSON.Feature[],
): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

export function bboxToBounds(bbox: [number, number, number, number]): [[number, number], [number, number]] {
  return [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[3]],
  ];
}
