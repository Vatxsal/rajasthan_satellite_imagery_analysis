import assert from "node:assert/strict";
import test from "node:test";
import type { CompareEngine } from "../lib/analysis/types";
import { binaryChange, validateCase, type CaseReport } from "../validation/engine";
import { buildScenarios } from "../validation/scenarios";

/**
 * Phase 4 regression: synthetic scenarios run through the real engine
 * pipeline (validation/scenarios.ts). Thresholds sit below the observed
 * ~99% scores but catch structural regressions — e.g. the Phase-4 bug
 * where bare→built leaked to veg_loss and the builtup_gain class scored 0.
 */

const ENGINES: CompareEngine[] = ["v1", "v2"];

function f1Of(report: CaseReport, cls: string): number | null {
  const m = report.metrics.find((x) => x.cls === cls);
  return m ? m.f1 : null;
}

function changePrecision(report: CaseReport): number | null {
  const b = binaryChange(report.confusion);
  if (!b) return null;
  const denom = b.tp + b.fp;
  return denom > 0 ? b.tp / denom : 1;
}

for (const engine of ENGINES) {
  test(`scenarios (${engine}): macroF1 ≥ 0.95, changeF1 ≥ 0.90 on every case`, () => {
    const cases = buildScenarios(engine);
    assert.equal(cases.length, 3, "three scenarios per engine");
    for (const c of cases) {
      const r = validateCase(c);
      assert.ok(
        r.macroF1 !== null && r.macroF1 >= 0.95,
        `${c.name}: macroF1 ${r.macroF1} < 0.95`,
      );
      assert.ok(
        r.changeF1 !== null && r.changeF1 >= 0.9,
        `${c.name}: changeF1 ${r.changeF1} < 0.9`,
      );
    }
  });

  test(`scenarios (${engine}): classes case keeps builtup_increase F1 ≥ 0.90`, () => {
    const cases = buildScenarios(engine, "scenario-classes");
    assert.equal(cases.length, 1, "classes scenario found");
    const r = validateCase(cases[0]);
    const f1 = f1Of(r, "builtup_increase");
    assert.ok(f1 !== null && f1 >= 0.9, `${cases[0].name}: builtup_increase F1 ${f1} < 0.9`);
  });

  test(`scenarios (${engine}): speckle case change precision ≥ 0.95`, () => {
    const cases = buildScenarios(engine, "scenario-speckle");
    assert.equal(cases.length, 1, "speckle scenario found");
    const r = validateCase(cases[0]);
    const prec = changePrecision(r);
    assert.ok(prec !== null && prec >= 0.95, `${cases[0].name}: change precision ${prec} < 0.95`);
  });
}
