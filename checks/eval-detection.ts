// Loop's detection eval: how precise is each band?
//
//   node checks/eval-detection.ts                 offline: the labelled features, scored by confidence.ts
//   node checks/eval-detection.ts --live          the real model through Plow (PLOW_API_BASE, PLOW_AGENT_TOKEN)
//   node checks/eval-detection.ts --file F.json   another labelled set (the owner's real messages)
//
// Offline runs two scenarios on the labelled features: "model says yes to
// everything" (the weight table alone has to separate commitments from the
// rest) and "model's yes/no is right" (the table only has to split open from
// candidate). Live asks the model exactly what the poll asks it (the Extract
// section of skills/loop-poll/SKILL.md) and scores its answer the same way.
// Updates (renegotiations, cancellations) are scored apart: they must come
// back as updates, never as new commitments.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { band, FEATURES, parseFeatures, type Band, type Features } from "../skills/loop/scripts/confidence.ts";
import { prefilter } from "../skills/loop/scripts/prefilter.ts";

type Example = {
  id: string; lang: string; category: string; text: string; features: string;
  gold: { is_commitment: boolean; updates?: "deadline" | "cancel" };
};
type Prediction = { isCommitment: boolean; features: Features | null; update: boolean };

const ROOT = join(import.meta.dirname, "..");

function decode(bits: string): Features {
  if (!/^[01]{7}$/.test(bits)) throw new Error(`features must be 7 bits, got ${bits}`);
  return Object.fromEntries(FEATURES.map((k, i) => [k, bits[i] === "1"])) as Features;
}

function extractSection(): string {
  const skill = readFileSync(join(ROOT, "skills", "loop-poll", "SKILL.md"), "utf8");
  const start = skill.indexOf("## Extract");
  if (start < 0) throw new Error("loop-poll has no Extract section");
  return skill.slice(start);
}

async function askModel(e: Example): Promise<Prediction> {
  const base = (process.env.PLOW_API_BASE ?? "").replace(/\/+$/, "");
  const token = process.env.PLOW_AGENT_TOKEN ?? "";
  if (!base || !token) throw new Error("--live needs PLOW_API_BASE and PLOW_AGENT_TOKEN");
  const candidate = { source: "imessage", item: `imessage:${e.id}`, to: ["+5511900000000"], cc: [], toNames: ["Alex"], sentAt: "2026-09-28T13:00:00Z", text: e.text };
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.LOOP_EVAL_MODEL ?? "z-ai/glm-5.2",
      temperature: 0,
      messages: [
        { role: "system", content: `${extractSection()}\n\nThere are no live commitments with this person. Answer with the extraction JSON only.` },
        { role: "user", content: JSON.stringify(candidate) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return {
    isCommitment: json.is_commitment === true,
    features: json.is_commitment === true && json.features ? parseFeatures(json.features) : null,
    update: !!json.updates,
  };
}

type Row = { band: Band | "none" | "update"; gold: boolean; category: string };

function table(title: string, rows: Row[]): string {
  const lines = [`### ${title}`, "", "| band | n | true commitments | precision |", "|---|---|---|---|"];
  for (const b of ["open", "candidate", "drop", "none"] as const) {
    const inBand = rows.filter((r) => r.band === b);
    const hits = inBand.filter((r) => r.gold).length;
    lines.push(`| ${b} | ${inBand.length} | ${hits} | ${inBand.length && b !== "drop" && b !== "none" ? (hits / inBand.length).toFixed(2) : "–"} |`);
  }
  const positives = rows.filter((r) => r.gold);
  const tracked = positives.filter((r) => r.band === "open" || r.band === "candidate").length;
  const open = positives.filter((r) => r.band === "open").length;
  lines.push("", `recall (open or candidate): ${tracked}/${positives.length} = ${(tracked / positives.length).toFixed(2)}; open only: ${(open / positives.length).toFixed(2)}`);
  const wrongOpen = rows.filter((r) => r.band === "open" && !r.gold).map((r) => r.category);
  if (wrongOpen.length) lines.push(`false opens by category: ${JSON.stringify(Object.fromEntries([...new Set(wrongOpen)].map((c) => [c, wrongOpen.filter((x) => x === c).length])))}`);
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean" }, file: { type: "string" } } });
  const set = JSON.parse(readFileSync(values.file ?? join(ROOT, "tests", "fixtures", "eval", "detection.json"), "utf8")) as { examples: Example[] };
  const creates = set.examples.filter((e) => !e.gold.updates);
  const updates = set.examples.filter((e) => e.gold.updates);
  const out: string[] = [`${set.examples.length} examples (${creates.length} new-or-not, ${updates.length} updates)`, ""];

  const dropped = creates.filter((e) => !prefilter({ text: e.text, recipients: ["x@y.com"], ownerHandles: ["me@me.com"] }).keep);
  out.push(`prefilter drops ${dropped.length}; true commitments among them: ${dropped.filter((e) => e.gold.is_commitment).map((e) => e.id).join(", ") || "none"}`, "");

  if (!values.live) {
    out.push(table("Offline — model says yes to everything (weights alone)", creates.map((e) => ({ band: band(decode(e.features)), gold: e.gold.is_commitment, category: e.category }))), "");
    out.push(table("Offline — model's yes/no is right", creates.map((e) => ({ band: e.gold.is_commitment ? band(decode(e.features)) : "none", gold: e.gold.is_commitment, category: e.category }))));
  } else {
    const rows: Row[] = [];
    for (const e of creates) {
      const p = await askModel(e);
      rows.push({ band: p.isCommitment && p.features ? band(p.features) : "none", gold: e.gold.is_commitment, category: e.category });
    }
    out.push(table("Live — model", rows), "");
    let asUpdate = 0;
    for (const e of updates) if ((await askModel(e)).update) asUpdate++;
    out.push(`updates recognised as updates: ${asUpdate}/${updates.length} (asked with no live commitment in context, so this is a lower bound)`);
  }
  console.log(out.join("\n"));
}

await main();
