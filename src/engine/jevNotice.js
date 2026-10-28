// ────────────────────────────────────────────────────────────────────────────
// Semantic triage for an unusable Chomusuke answer (docs/jev.md proposal 14).
//
// `answerKind()` can only say "empty" or "format". A refusal, a truncated block,
// an answer to the wrong job, and a prose reply all look like "format" to it, and
// they have different fixes. JEV names the kind; the recovery stays the existing
// one (a message, Read again, or a model suggestion). No retries are added, no
// profile is switched, and nothing is applied.
//
// Off, shadow, low confidence, or a failed request all fall through to exactly
// the warning that was there before.
// ────────────────────────────────────────────────────────────────────────────

import { answerKind, joinJobNames, warnChomusuke } from "./chomusukeNotice.js";
import { jevTriageAnswer } from "../state/jev.js";

const HINT = {
    wrong_task: "it answered a different job",
    refusal: "the model declined to answer",
    truncated: "the answer was cut off before it finished",
    format_drift: "the shape of the answer was wrong",
    prose_only: "it wrote story prose instead of the block",
    context_confusion: "it mixed up who or where it was answering about",
};

const ADVICE = {
    refusal: "A censored model can refuse an NSFW story without saying so: pick a less censored one in the Chomusuke tab.",
    truncated: "Raise Chomusuke's reply length, then use Read again.",
    prose_only: "A stronger model for Chomusuke usually fixes this.",
    wrong_task: "Use Read again; if it repeats, check that the job's prompt was not edited.",
    context_confusion: "Use Read again after the current exchange has settled.",
    format_drift: "Use Read again, or pick a stronger model for Chomusuke.",
};

/**
 * Shows the right warning for one unusable answer.
 * @param {string|null} raw       the worker's answer (null: the request failed)
 * @param {string[]} jobs         feature keys
 * @param {{ kind?: string, error?: any, switchedBack?: boolean }} [opts]
 * @returns {Promise<string>}     the kind that was reported
 */
export async function warnUnusableAnswer(raw, jobs, { kind, error, switchedBack } = {}) {
    const base = kind || (raw === null ? "failed" : answerKind(raw));
    if (base === "format" && raw) {
        const semantic = await jevTriageAnswer(jobs[0], raw);
        if (semantic && HINT[semantic]) {
            toastr.warning(
                `${joinJobNames(jobs)} came back unusable: ${HINT[semantic]}. ${ADVICE[semantic] || ""}`.trim(),
                "Chomusuke",
                { timeOut: 8000 },
            );
            return semantic;
        }
    }
    warnChomusuke(base, jobs, { error, switchedBack });
    return base;
}
