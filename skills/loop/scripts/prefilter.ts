// The deterministic first pass over what the owner sent, before any model
// reads it. High recall on purpose: it only throws away what cannot hold a
// commitment (auto-replies, list mail, notes to self, attachments with no
// words, one-word replies, text with no commitment phrase at all), and every
// drop is counted by reason. Portuguese and English. No model.

export type Message = {
  text: string; // the owner's own words (quoted history already stripped)
  subject?: string;
  recipients: string[]; // normalized handles the message went to
  ownerHandles: string[]; // the owner's own addresses and numbers
  attachments?: number;
  listId?: string | null;
  autoSubmitted?: boolean;
};

export type DropReason = "auto_reply" | "mailing_list" | "self_recipient" | "attachment_only" | "empty" | "too_short" | "no_commitment_phrase";
export type Verdict = { keep: true; signals: Signal[] } | { keep: false; reason: DropReason };
export type Signal = "promise" | "request" | "delegation" | "deadline";

// Accents off and lower case, so "Amanhã" and "amanha" match the same words.
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'");
}

const words = (list: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}'])(?:${list})(?=$|[^\\p{L}\\p{N}])`, "u");

// First person, future: the owner commits to something.
const PROMISE = words([
  "vou", "irei", "te mando", "mando", "te envio", "envio", "te passo", "passo", "te aviso", "aviso", "te retorno", "retorno",
  "te apresento", "apresento", "te conecto", "faco", "preparo", "fecho", "reviso", "pago", "a gente manda", "a gente envia",
  "i'll", "i will", "will send", "let me", "i'm going to", "im going to", "i am going to", "i can send", "we'll", "we will",
  "i'll get back", "will get back", "i'll follow up", "will follow up",
].join("|"));

// The owner asks someone for something.
const REQUEST = words([
  "consegue", "consegues", "pode", "poderia", "podes", "me manda", "me envia", "me passa", "me mande", "me envie", "me passe",
  "voce manda", "voce envia", "preciso que", "precisamos que", "por favor mand", "por favor envi",
  "can you", "could you", "would you", "will you", "please send", "pls send", "send me", "please share", "can we get",
  "i need you to", "we need you to", "let me know",
].join("|"));

// An imperative that hands someone a task; it counts as delegation with a deadline.
const IMPERATIVE = words([
  "manda", "envia", "prepara", "revisa", "faz", "fecha", "termina", "atualiza", "agenda", "marca", "liga", "responde",
  "send", "prepare", "review", "finish", "draft", "update", "schedule", "call", "reply", "follow up with", "reach out",
].join("|"));

export const DEADLINE = words([
  "amanha", "hoje", "hoje a noite", "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "semana que vem", "proxima semana", "fim do mes", "final do mes", "fim da semana", "fim do dia", "ate", "depois do", "depois da",
  "tomorrow", "today", "tonight", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "next week", "end of day", "end of the day", "end of week", "end of the week", "end of month", "end of the month",
  "eod", "eow", "by", "asap", "after the",
].join("|"));
const DATE = /(?:^|\D)\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\D|$)|\b\d{4}-\d{2}-\d{2}\b/;

const AUTO_REPLY = /^(?:auto(?:matic)?[ -]?reply|out of (?:the )?office|resposta automatica|fora do escritorio|ausencia|ausente)\b|\b(?:out of office|resposta automatica|automatic reply)\b/;

// Everything after the first line that starts quoted history in a reply.
const QUOTE_HEADERS = [
  /^\s*on .{3,200} wrote:\s*$/im,
  /^\s*em .{3,200} escreveu:\s*$/im,
  /^\s*-{2,}\s*(?:original message|mensagem original|forwarded message|mensagem encaminhada)\s*-{2,}\s*$/im,
  /^\s*from: .+$/im,
  /^\s*de: .+$/im,
];

// The owner's new words in a reply: no quoted history, no "> " lines, no signature.
export function ownText(body: string): string {
  let text = body.replace(/\r\n/g, "\n");
  let cut = text.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);
  const sig = /^--\s*$/m.exec(text);
  if (sig) text = text.slice(0, sig.index);
  return text.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n").trim();
}

export function signals(text: string): Signal[] {
  const t = fold(text);
  const out: Signal[] = [];
  if (PROMISE.test(t)) out.push("promise");
  if (REQUEST.test(t)) out.push("request");
  const deadline = DEADLINE.test(t) || DATE.test(t);
  if (IMPERATIVE.test(t) && deadline) out.push("delegation");
  if (deadline) out.push("deadline");
  return out;
}

export function prefilter(m: Message): Verdict {
  const subject = fold(m.subject ?? "");
  const text = m.text.trim();
  if (m.autoSubmitted || AUTO_REPLY.test(subject) || AUTO_REPLY.test(fold(text.slice(0, 120)))) return { keep: false, reason: "auto_reply" };
  if (m.listId) return { keep: false, reason: "mailing_list" };
  const owner = new Set(m.ownerHandles.map((h) => h.toLowerCase()));
  if (m.recipients.length > 0 && m.recipients.every((r) => owner.has(r.toLowerCase()))) return { keep: false, reason: "self_recipient" };
  if (!text) return { keep: false, reason: (m.attachments ?? 0) > 0 ? "attachment_only" : "empty" };
  if (text.split(/\s+/).filter(Boolean).length <= 3) return { keep: false, reason: "too_short" };
  const found = signals(text);
  if (!found.some((s) => s !== "deadline")) return { keep: false, reason: "no_commitment_phrase" };
  return { keep: true, signals: found };
}
