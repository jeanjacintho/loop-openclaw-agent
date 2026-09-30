// The model never scores a commitment. It reports features of the message
// (who speaks, is there a delivery verb, a concrete object, a clear other
// side, an explicit deadline, is it conditional or a pleasantry) and this
// table turns them into a band. All weights and cuts live here; LP-7's eval
// and the owner's corrections (ledger.ts calibrate) tune them.

export type Features = {
  first_person: boolean; // the owner speaks for themselves: "I'll send", or asks directly: "can you send"
  delivery_verb: boolean; // send, pay, intro, review, reply, decide…
  concrete_object: boolean; // the deck, the contract, the numbers, an intro to X
  clear_counterparty: boolean; // one identifiable other side
  explicit_deadline: boolean; // tomorrow, Friday, by the 10th, after the board
  conditional: boolean; // "if I can", "maybe", "se der"
  social_pleasantry: boolean; // "let's grab coffee sometime", "vamos marcar"
};

export type Band = "open" | "candidate" | "drop";

export const FEATURES: readonly (keyof Features)[] = [
  "first_person", "delivery_verb", "concrete_object", "clear_counterparty",
  "explicit_deadline", "conditional", "social_pleasantry",
];

export const WEIGHTS: Record<keyof Features, number> = {
  first_person: 2,
  delivery_verb: 2,
  concrete_object: 2,
  clear_counterparty: 1,
  explicit_deadline: 2,
  conditional: -3,
  social_pleasantry: -4,
};

// Score at or above `open` is tracked; at or above `candidate` is asked about
// in the digest; below is dropped (counted only). The highest score is 9.
export const CUTS = { open: 7, candidate: 4 } as const;

// How far one automatic recalibration raises the open cut (ledger.ts calibrate).
export const RAISE_STEP = 1;
export const MAX_RAISE = 2;

export function parseFeatures(raw: unknown): Features {
  if (raw === null || typeof raw !== "object") throw new Error("features must be an object");
  const f = raw as Record<string, unknown>;
  const out = {} as Features;
  for (const key of FEATURES) {
    if (typeof f[key] !== "boolean") throw new Error(`features.${key} must be true or false, got ${JSON.stringify(f[key])}`);
    out[key] = f[key] as boolean;
  }
  return out;
}

export function score(f: Features): number {
  return FEATURES.reduce((sum, key) => sum + (f[key] ? WEIGHTS[key] : 0), 0);
}

// `raise` is the calibration offset on the open cut (0 until the owner's
// corrections say open is too noisy).
export function band(f: Features, raise = 0): Band {
  // A pleasantry about nothing in particular is never a commitment.
  if (f.social_pleasantry && !f.concrete_object) return "drop";
  const s = score(f);
  if (s < CUTS.candidate) return "drop";
  // A condition, or no clear other side, is never certain enough to track unasked.
  if (f.conditional || !f.clear_counterparty) return "candidate";
  return s >= CUTS.open + Math.max(0, Math.min(raise, MAX_RAISE)) ? "open" : "candidate";
}
