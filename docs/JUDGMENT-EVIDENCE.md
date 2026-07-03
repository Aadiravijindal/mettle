# Judgment Evidence — biases the stress tests caught, with before/after numbers

This file exists because "our scoring is fair" is a claim, and claims need
receipts. Below are the failures our own stress suite caught in the decision
engine before any real candidate hit them, with the exact numbers before and
after the fix. The suite runs on every `npm test`
(`server/test/scoring-stress.mjs`) and each scenario's expected verdict was
written down *before* the engine ran — so a mismatch indicts the engine, not
the test.

## S1 — The performance-of-thinking bias (caught 2026-07-03)

**The failure mode:** rewarding candidates who *narrate* their thinking over
candidates who simply think. A fast, silent expert produces few visible
"thinking signals" (no ceremonial tests, no comments, no prompts) — a scoring
model built on visible behavior punishes exactly that.

**It actually happened.** Before the fix (engine as of commit `6404306`):

| Candidate | Score | Verdict |
|---|---|---|
| Fast quiet expert (12 of 45 min, 95% own work, correct, quality 9/10) | **87** | strong hire |
| Narrating mediocre candidate (44 of 45 min, quality 6/10, tests + comments + visible decomposition) | **90** | strong hire |

The mediocre narrator **outranked** the expert by 3 points. That is theater
beating skill, in our own numbers.

**The fix** (commit `dd1579c`):
1. *Silent-mastery floor*: a correct, clean (quality ≥7), ≥85%-own-work pass
   floors the thinking layer at 85 — the work itself is accepted as the
   evidence of understanding.
2. *Completion de-saturation*: quality now weighs ×4 (−20..+20) on a rescaled
   base, so a complete-but-mediocre submission can no longer saturate the
   completion layer alongside an excellent one.

**After:**

| Candidate | Score | Verdict |
|---|---|---|
| Fast quiet expert | **89** | strong hire |
| Narrating mediocre candidate | **88** | strong hire |

Both remain strong hires — narrating your work is not bad — but the ordering
is now correct, and a permanent cross-check (`S1 expert ≥ narrating mediocre
candidate`) fails the suite if this bias ever regresses.

## S6 — The rules-lawyer loophole (caught 2026-07-03)

Every literal requirement ticked, code "works", but brittle/minimal
(quality 3/10, no error handling, no edge cases).

- **Before:** completion layer saturated → composite **77 → hire**. A real
  founder seeing this candidate recommended for hire would have been right to
  stop trusting the report.
- **After:** quality ×4 pulls completion down, and a hard gate
  (`brittle_minimal_solution`: quality ≤3 caps at borderline) closes the
  loophole → **73 → borderline** with the gate named on the report.

## S3 — "Didn't edit" is not "didn't understand" (resolved 2026-07-03)

The blind-AI gate originally fired on `noEvidenceOfUnderstanding` + ≥80% AI.
But its only understanding signal was *visible editing* — false-positive
territory for careful candidates who read/ran the pasted code and correctly
left it alone.

- **Fix:** a distinct `verifiedBeforeSubmit` observation (ran it, visibly read
  it through, exercised an edge case). The gate now requires *neither editing
  nor verification*.
- **Numbers:** unverified paste-and-pray: **61 → no hire** (gate fires).
  Same paste, visibly verified: **82 → strong hire** (no gate).

## Validation status — what is proven and what is still hypothesis

| Concern | Status |
|---|---|
| S1, S2, S3, S4, S5, S6, S9, S10 (engine judgment) | **Engine-proven** — deterministic, regression-tested on every `npm test` |
| S5 review UX (10-second clear) | Verified live against the API + UI |
| S7 language fairness | **Hypothesis.** The prompt contains a hard fairness rule ("judge technical substance, never fluency or verbosity"), but a prompt rule is a hypothesis about model behavior, not a guarantee. `server/test/fairness-probe.mjs` runs a paired-observation A/B test (identical technical substance, different language fluency) against the real model — run it before trusting reports on non-native-English candidates, and re-run it whenever the prompt or model changes. Real non-native candidate sessions remain the definitive test. |
| S8 ambiguous briefs | Prompt rule only — watch real usage; if it recurs, the fix is founder-side task-writing tooling |
| Perception accuracy overall (does Claude *see* verification, scope cuts, faces correctly) | Only validated by comparing observations against real recorded sessions — do this with the first 5–10 real candidates |
