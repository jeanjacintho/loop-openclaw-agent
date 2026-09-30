import assert from "node:assert/strict";
import { test } from "node:test";
import { band, CUTS, FEATURES, parseFeatures, score, WEIGHTS, type Features } from "../skills/loop/scripts/confidence.ts";

const all = (over: Partial<Features> = {}): Features => ({
  first_person: true, delivery_verb: true, concrete_object: true, clear_counterparty: true,
  explicit_deadline: true, conditional: false, social_pleasantry: false, ...over,
});

test("a clear promise with a deadline is open, and without one still open", () => {
  assert.equal(band(all()), "open");
  assert.equal(band(all({ explicit_deadline: false })), "open");
});

test("a pleasantry about nothing concrete is dropped", () => {
  // "vamos marcar um café qualquer dia"
  assert.equal(band(all({ delivery_verb: false, concrete_object: false, explicit_deadline: false, social_pleasantry: true })), "drop");
  assert.equal(band(all({ social_pleasantry: true, concrete_object: false })), "drop");
});

test("a conditional or a missing counterparty is at most a candidate", () => {
  assert.equal(band(all({ conditional: true })), "candidate"); // "se der, mando amanhã"
  assert.equal(band(all({ clear_counterparty: false })), "candidate"); // "a gente manda" to a group
});

test("vague intentions are dropped", () => {
  // "vou ver isso"
  assert.equal(band(all({ delivery_verb: false, concrete_object: false, explicit_deadline: false })), "drop");
});

test("the calibration offset raises only the open cut, and is capped", () => {
  const f = all({ explicit_deadline: false }); // score 7
  assert.equal(score(f), 7);
  assert.equal(band(f, 0), "open");
  assert.equal(band(f, 1), "candidate");
  assert.equal(band(all(), 1), "open");
  assert.equal(band(all(), 99), "open", "never so high that nothing can be open");
});

test("the weights are the one table, and the best score reaches open", () => {
  assert.deepEqual(Object.keys(WEIGHTS).sort(), [...FEATURES].sort());
  assert.ok(score(all()) >= CUTS.open + 2);
});

test("features must all be booleans", () => {
  assert.deepEqual(parseFeatures(all()), all());
  assert.throws(() => parseFeatures({ ...all(), conditional: "no" }), /features.conditional/);
  assert.throws(() => parseFeatures({ first_person: true }), /features.delivery_verb/);
});
