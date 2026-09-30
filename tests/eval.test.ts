import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// The weights must keep the labelled set above the v0.1 bar even when the
// model says yes to everything, and the prefilter must never drop a labelled
// commitment. A weight change that breaks either fails here.
test("offline eval: open precision >= 0.85 on weights alone, and the prefilter drops no commitment", () => {
  const out = spawnSync(process.execPath, [join(import.meta.dirname, "..", "checks", "eval-detection.ts")], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const weightsOnly = out.stdout.split("### ")[1]!;
  const open = /\| open \| (\d+) \| (\d+) \| ([\d.]+) \|/.exec(weightsOnly)!;
  assert.ok(Number(open[3]) >= 0.85, `open precision ${open[3]}`);
  assert.match(out.stdout, /true commitments among them: none/);
  assert.match(weightsOnly, /recall \(open or candidate\): (\d+)\/\1 /);
});
