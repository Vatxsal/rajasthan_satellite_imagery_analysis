import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAG_CLICK_THRESHOLD_PX,
  basemapWordsAt,
  describeQueriedFeatures,
  isCustomLayer,
  isDragClick,
  pickHit,
  pipAdminAgainst,
  type AdminFcLike,
  type MapQueryable,
  type QueriedFeature,
} from "../lib/inspect/hits";

/**
 * Map inspector hit-testing: tap-vs-drag suppression, event > field > empty
 * click priority, admin point-in-polygon, and the plain-words basemap
 * description — exactly what bindInspectorMap runs on every map click.
 */

function feature(partial: Partial<QueriedFeature>): QueriedFeature {
  return { layer: { id: "x", type: "fill" }, properties: {}, ...partial };
}

test("pickHit: a change event beats a fields parcel", () => {
  const hit = pickHit({
    eventFeatures: [
      feature({ properties: { rank: 7, centroid: [73.5, 26.2] } }),
    ],
    fieldFeatures: [feature({ id: "field-1" })],
  });
  assert.deepEqual(hit, { kind: "event", rank: 7, centroid: [73.5, 26.2] });
});

test("pickHit: a fields parcel beats an empty spot", () => {
  const hit = pickHit({ eventFeatures: [], fieldFeatures: [feature({ id: "field-1" })] });
  assert.deepEqual(hit, { kind: "field", fieldId: "field-1" });
});

test("pickHit: nothing queried → empty spot", () => {
  assert.deepEqual(pickHit({ eventFeatures: [], fieldFeatures: [] }), { kind: "empty" });
});

test("pickHit: event without a usable rank/centroid falls through to the field", () => {
  const noRank = pickHit({
    eventFeatures: [feature({ properties: { centroid: [73, 26] } })],
    fieldFeatures: [feature({ id: "f2" })],
  });
  assert.deepEqual(noRank, { kind: "field", fieldId: "f2" });

  const badCentroid = pickHit({
    eventFeatures: [feature({ properties: { rank: 2, centroid: [Number.NaN, 26] } })],
    fieldFeatures: [],
  });
  assert.deepEqual(badCentroid, { kind: "empty" });
});

test("pickHit: field id comes from feature.id, then properties.id", () => {
  const fromFeatureId = pickHit({
    eventFeatures: [],
    fieldFeatures: [feature({ id: 42, properties: {} })],
  });
  assert.deepEqual(fromFeatureId, { kind: "field", fieldId: "42" });

  const fromProps = pickHit({
    eventFeatures: [],
    fieldFeatures: [feature({ properties: { id: "prop-id" } })],
  });
  assert.deepEqual(fromProps, { kind: "field", fieldId: "prop-id" });

  const noId = pickHit({ eventFeatures: [], fieldFeatures: [feature({ properties: {} })] });
  assert.deepEqual(noId, { kind: "empty" });
});

test("isDragClick: movement over the threshold is a pan, not a tap", () => {
  assert.equal(DRAG_CLICK_THRESHOLD_PX, 6);
  assert.equal(isDragClick({ x: 0, y: 0 }, { x: 4, y: 3 }), false); // 5 px
  assert.equal(isDragClick({ x: 0, y: 0 }, { x: 6, y: 6 }), true); // 8.5 px
  assert.equal(isDragClick(null, { x: 400, y: 400 }), false); // no down event
});

test("isCustomLayer: app layers never describe themselves as basemap context", () => {
  for (const id of [
    "fields-fill",
    "compare-hotspot-fill",
    "admin-tehsils",
    "districts-line",
    "active-scene",
    "measure-line",
  ]) {
    assert.ok(isCustomLayer(id), `${id} should be custom`);
  }
  assert.ok(!isCustomLayer("water"));
  assert.ok(!isCustomLayer("place-village"));
});

test("describeQueriedFeatures: name + plain type, custom layers excluded, deduped and capped", () => {
  const features: QueriedFeature[] = [
    feature({
      layer: { id: "waterway", type: "line" },
      properties: { name: "Banas", class: "river" },
    }),
    feature({
      layer: { id: "waterway", type: "line" },
      properties: { name: "Banas", class: "river" }, // duplicate
    }),
    feature({ layer: { id: "road", type: "line" }, properties: { class: "residential" } }),
    feature({ layer: { id: "fields-fill", type: "fill" }, properties: { name: "Parcel" } }),
    feature({ layer: { id: "place-village", type: "symbol" }, properties: { class: "village" } }),
  ];
  assert.deepEqual(describeQueriedFeatures(features), ["Banas — river", "street"]);

  const words = ["farmland", "forest", "grass", "park"];
  const many: QueriedFeature[] = Array.from({ length: 9 }, (_, index) =>
    feature({
      layer: { id: `l${index}`, type: "fill" },
      properties: { class: words[index % words.length] },
    }),
  );
  assert.equal(describeQueriedFeatures(many, 3).length, 3);
  assert.equal(describeQueriedFeatures(many, 3)[0], "farmland");
});

test("basemapWordsAt: returns words for a working map, [] while the style reloads", () => {
  const working = {
    queryRenderedFeatures: () => [
      feature({ layer: { id: "highway", type: "line" }, properties: { class: "primary" } }),
    ],
  } as unknown as MapQueryable;
  assert.deepEqual(basemapWordsAt(working, { x: 10, y: 20 }), ["road"]);

  const broken = {
    queryRenderedFeatures: () => {
      throw new Error("style mid-reload");
    },
  } as unknown as MapQueryable;
  assert.deepEqual(basemapWordsAt(broken, { x: 10, y: 20 }), []);
});

/* ---------------------------------------------------------------- admin PIP */

const districts: AdminFcLike = {
  features: [
    {
      id: "d1",
      properties: { id: "d1", name: "Ajmer" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

const tehsils: AdminFcLike = {
  features: [
    {
      id: "t1",
      properties: { id: "t1", name: "Kishangarh", districtId: "d1" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
    // A tehsil whose polygon lies elsewhere — only reachable by id cascade.
    {
      id: "t9",
      properties: { id: "t9", name: "Far away", districtId: "d1" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10],
          ],
        ],
      },
    },
  ],
};

const ilrs: AdminFcLike = {
  features: [
    {
      id: "i1",
      properties: { id: "i1", name: "ILR-7", tehsilId: "t1", districtId: "d1" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0.5, 0],
            [0.5, 0.5],
            [0, 0.5],
            [0, 0],
          ],
        ],
      },
    },
    // ILR present but its tehsil polygon is the far-away one → id cascade.
    {
      id: "i2",
      properties: { id: "i2", name: "ILR-9", tehsilId: "t9", districtId: "d1" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1.5, 1.5],
            [1.6, 1.5],
            [1.6, 1.6],
            [1.5, 1.6],
            [1.5, 1.5],
          ],
        ],
      },
    },
  ],
};

test("pipAdminAgainst: nested point resolves ILR → tehsil → district", () => {
  const hit = pipAdminAgainst(districts, tehsils, ilrs, 0.2, 0.2);
  assert.equal(hit.ilr?.id, "i1");
  assert.equal(hit.tehsil?.id, "t1");
  assert.equal(hit.district?.id, "d1");
});

test("pipAdminAgainst: district-only point reports just the district", () => {
  const hit = pipAdminAgainst(districts, tehsils, ilrs, 1.5, 1.5);
  assert.equal(hit.ilr?.id, "i2"); // ILR contains it (bbox + polygon)
  assert.equal(hit.tehsil?.id, "t9"); // via id cascade — t1's polygon missed
  assert.equal(hit.district?.id, "d1");
});

test("pipAdminAgainst: outside every bbox → all null (no turf call)", () => {
  const hit = pipAdminAgainst(districts, tehsils, ilrs, 50, 50);
  assert.deepEqual(hit, { district: null, tehsil: null, ilr: null });
});

test("pipAdminAgainst: non-polygon geometries are skipped", () => {
  const lineDistricts: AdminFcLike = {
    features: [
      {
        id: "dL",
        properties: { id: "dL", name: "Line" },
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      },
    ],
  };
  const hit = pipAdminAgainst(lineDistricts, { features: [] }, { features: [] }, 0.5, 0.5);
  assert.equal(hit.district, null);
});
