// How Loop names a person's address: an email, a phone, or a Plow member id.
// Normalization and matching are Meetly's (normalizeHandle / sameHandle).

export type HandleKind = "email" | "phone" | "plow";
export type Handle = { kind: HandleKind; value: string };

export function isEmail(h: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h.trim());
}

export function isPhone(h: string): boolean {
  return /^\+?[\d\s().-]{7,}$/.test(h.trim()) && h.replace(/\D/g, "").length >= 7;
}

export function normalizeHandle(h: string): string {
  const t = h.trim();
  if (isEmail(t)) return t.toLowerCase();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

// iMessage gives +15551234567 while Contacts gives (555) 123-4567: two phones
// match when the shorter one (7+ digits) is a suffix of the longer.
export function sameHandle(a: string, b: string): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  if (na === nb) return na !== "" && na !== "+";
  if (isEmail(na) || isEmail(nb)) return false;
  const da = na.replace("+", "");
  const db = nb.replace("+", "");
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 7 && long.endsWith(short);
}

// "plow:<member uid>", an email, or a phone → a typed, normalized handle.
export function parseHandle(raw: string): Handle {
  const t = raw.trim();
  if (t.startsWith("plow:")) {
    const value = t.slice(5).trim();
    if (!value) throw new Error(`empty Plow handle: ${raw}`);
    return { kind: "plow", value };
  }
  if (isEmail(t)) return { kind: "email", value: normalizeHandle(t) };
  if (isPhone(t)) return { kind: "phone", value: normalizeHandle(t) };
  throw new Error(`not an email, phone or plow:<uid> handle: ${raw}`);
}

// The address inside "Name <addr@x.com>", or the text itself.
export function bareAddress(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1]! : raw).trim();
}
