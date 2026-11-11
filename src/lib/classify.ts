// classify.ts — unified provider error classifier (order matters!).
// Balance messages sometimes arrive as HTTP 400, so exhausted is tested before
// the generic 400/params rule.
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export function classifyProviderError(
  status: number | undefined,
  message: string,
  hint?: ErrorClass
): ErrorClass {
  if (hint) return hint; // adapters may pre-classify shapes the regexes can't see
  const msg = (message || "").toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(msg)) {
    return "disabled";
  }
  if (status === 402 || /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(msg)) {
    return "exhausted";
  }
  if ((status === 400 || status === 404 || status === 422) && /model not found|unsupported model/.test(msg)) {
    return "provider";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "params";
  }
  // 429, 5xx, network errors, timeouts, aborts
  return "temporary";
}
