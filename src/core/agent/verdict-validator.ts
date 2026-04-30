import type { TriageVerdict } from "../models/verdict.js";

const MIN_QUOTE_LEN = 20;

export interface ValidateVerdictResult {
  verdict: TriageVerdict;
  downgraded: boolean;
  note?: string;
}

// Strip Read-tool line-number prefix ("36\t") so substring matching works on
// the raw code as the model would quote it.
function stripLineNumbers(readOutput: string): string {
  return readOutput.replace(/^\s*\d+\t/gm, "");
}

export function validateVerdict(
  verdict: TriageVerdict,
  readOutputs: string[],
): ValidateVerdictResult {
  // needs_review is the safe verdict — never downgrade further.
  if (verdict.verdict === "needs_review") {
    return { verdict, downgraded: false };
  }

  const quote = (verdict.sink_line_quoted ?? "").trim();
  const haystack = readOutputs.map(stripLineNumbers).join("\n");
  const quoteLongEnough = quote.length >= MIN_QUOTE_LEN;
  const quoteFound = quoteLongEnough && haystack.includes(quote);

  if (!quoteFound) {
    return {
      verdict: {
        ...verdict,
        verdict: "needs_review",
        reasoning:
          `[Auto-downgraded] sink_line_quoted not found in any read tool output ` +
          `(or shorter than ${MIN_QUOTE_LEN} chars). Original verdict was ${verdict.verdict}. ` +
          (verdict.reasoning || ""),
      },
      downgraded: true,
      note: "sink_quote_missing",
    };
  }

  if (verdict.verdict === "true_positive") {
    const payload = (verdict.attacker_payload ?? "").trim();
    if (!payload || payload.toUpperCase() === "N/A") {
      return {
        verdict: {
          ...verdict,
          verdict: "needs_review",
          reasoning:
            `[Auto-downgraded] attacker_payload missing or "N/A" for true_positive. ` +
            (verdict.reasoning || ""),
        },
        downgraded: true,
        note: "payload_missing",
      };
    }
  }

  return { verdict, downgraded: false };
}
