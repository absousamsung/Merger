// sanitize.ts — the AI client never sees key/balance errors (spec 5.3.5).
export const GENERIC_UNAVAILABLE = "الخدمة غير متاحة مؤقتًا، حاول لاحقًا";

const KEYISH = /(api[-_ ]?key|bearer\s|authorization|secret|token)/i;
const BALANCEISH =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|unauthorized|invalid api key|forbidden|401|402/i;
const INTERNALISH = /stuck|STUCK_TASK|all keys failed|no usable key|check blocked by key loss/i;

export function sanitizeForClient(msg: string | null | undefined): string {
  const m = (msg || "").trim();
  if (!m) return GENERIC_UNAVAILABLE;
  if (KEYISH.test(m) || BALANCEISH.test(m) || INTERNALISH.test(m)) return GENERIC_UNAVAILABLE;
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}
