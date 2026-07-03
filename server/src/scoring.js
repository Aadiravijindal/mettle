// The decision engine. Claude's job is PERCEPTION ONLY — it reports factual,
// timestamped observations (requirements met, tested or not, caught an AI
// mistake or not, flags). This module is the JUDGMENT: a deterministic
// algorithm that turns those observations into the hiring verdict. Same
// observations always produce the same verdict, the weights and gates are
// explicit below, and every triggered rule is reported so the founder sees
// exactly why a candidate landed where they did.

export const SCORING_CONFIG = {
  // Layer weights — must sum to 1.
  weights: {
    completion: 0.35, // did they actually do the task
    thinking: 0.3, // depth of their own understanding
    toolUse: 0.2, // how well they leveraged AI/tools (leverage, not avoidance)
    integrity: 0.15, // was the session trustworthy
  },
  // Composite score → recommendation bands (checked top-down).
  bands: [
    { min: 80, recommendation: 'strong_hire' },
    { min: 62, recommendation: 'hire' },
    { min: 42, recommendation: 'borderline' },
    { min: 0, recommendation: 'no_hire' },
  ],
};

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const RANK = { no_hire: 0, borderline: 1, hire: 2, strong_hire: 3 };

// Scaled so a full-requirements pass does NOT saturate 100 on its own —
// quality must keep separating candidates at the top, or a mediocre-but-
// complete submission scores the same as an excellent one.
function completionScore(c) {
  const parts = [];
  let base = { pass: 75, partial: 45, fail: 10 }[c?.verdict] ?? 10;
  // A deliberate, communicated scope cut (triage) is judgment, not failure —
  // it raises the partial base and waives the partial-completion gate.
  if (c?.verdict === 'partial' && c?.deliberateScopeCut) {
    base = 60;
    parts.push('base 60 (partial via deliberate, communicated scope cut)');
  } else {
    parts.push(`base ${base} (verdict: ${c?.verdict ?? 'unknown'})`);
  }
  let s = base;
  if (c?.requirementsTotal > 0) {
    const ratio = clamp(c.requirementsMet / c.requirementsTotal, 0, 1);
    s = 0.5 * s + 45 * ratio;
    parts.push(`requirements ${c.requirementsMet}/${c.requirementsTotal} met`);
  }
  s += c?.worksCorrectly ? 8 : -8;
  parts.push(c?.worksCorrectly ? '+8 works correctly' : '−8 does not work correctly');
  if (Number.isFinite(c?.codeQuality)) {
    const delta = (c.codeQuality - 5) * 4; // 0-10 quality → −20..+20
    s += delta;
    parts.push(`quality ${c.codeQuality}/10 → ${delta >= 0 ? '+' : ''}${delta}`);
  }
  return { score: clamp(Math.round(s)), parts };
}

const THINKING_RULES = [
  ['caughtAiMistake', +18, 'caught and fixed a mistake in AI output'],
  ['testedOwnWork', +15, 'tested their own work'],
  ['modifiedAiOutputBeforeUse', +12, 'modified AI output before using it'],
  ['verifiedBeforeSubmit', +12, 'verified the work before submitting (ran it, read it back, checked an edge case)'],
  ['brokeProblemDown', +10, 'broke the problem into logical steps'],
  ['explainedReasoning', +10, 'left comments/explanations showing understanding'],
  ['promptsImproved', +8, 'follow-up prompts got more specific and informed'],
  ['pastedVerbatimNoTesting', -20, 'pasted large blocks verbatim with no verification'],
  ['noEvidenceOfUnderstanding', -25, 'no evidence of understanding pasted content'],
  ['outputDiverged', -12, 'final output diverged from what they built mid-session'],
  ['repeatedIdenticalPrompts', -8, 'repeated near-identical prompts with no refinement'],
];

const NEGATIVE_SIGNALS = ['pastedVerbatimNoTesting', 'noEvidenceOfUnderstanding', 'outputDiverged', 'repeatedIdenticalPrompts'];

function thinkingScore(signals = {}, context = {}) {
  let s = 50;
  const parts = [];
  for (const [key, delta, label] of THINKING_RULES) {
    if (signals[key]) {
      s += delta;
      parts.push(`${delta > 0 ? '+' : ''}${delta} ${label}`);
    }
  }
  if (parts.length === 0) parts.push('no thinking signals observed — neutral 50');
  s = clamp(Math.round(s));

  // Silent-mastery rule: a fast, correct, high-quality solution built almost
  // entirely by hand IS the evidence of understanding — an expert who just
  // knows the answer must not score below someone who narrates every step.
  const anyNegative = NEGATIVE_SIGNALS.some((k) => signals[k]);
  if (
    !anyNegative &&
    context.completionVerdict === 'pass' &&
    context.worksCorrectly &&
    (context.codeQuality ?? 0) >= 7 &&
    (context.percentOwnWork ?? 0) >= 85 &&
    s < 85
  ) {
    parts.push('floor 85: correct, clean, predominantly own work — the work itself is the evidence of understanding');
    s = 85;
  }
  return { score: s, parts };
}

export function thinkingRatingFromScore(score) {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function toolUseScore({ toolPurposes = [], percentOwnWork, durationSeconds, timeLimitMinutes, completionVerdict }) {
  let s = 50;
  const parts = [];
  const accel = toolPurposes.filter((p) => p.intent === 'accelerate').length;
  const understand = toolPurposes.filter((p) => p.intent === 'understand').length;
  const avoid = toolPurposes.filter((p) => p.intent === 'avoid_thinking').length;
  const purposeful = Math.min(accel + understand, 5);
  if (purposeful > 0) {
    s += 6 * purposeful;
    parts.push(`+${6 * purposeful} purposeful tool uses (${accel} to accelerate, ${understand} to understand)`);
  }
  if (avoid > 0) {
    // Capped so a rocky first stretch can't bury a session that visibly
    // recovered — the thinking layer carries the arc.
    const d = Math.min(12 * avoid, 36);
    s -= d;
    parts.push(`−${d} uses that avoided thinking (${avoid}${12 * avoid > 36 ? ', penalty capped' : ''})`);
  }
  if (Number.isFinite(percentOwnWork) && percentOwnWork >= 25 && percentOwnWork <= 85) {
    s += 10;
    parts.push(`+10 healthy own-work/AI mix (${percentOwnWork}% own)`);
  }
  const limit = (timeLimitMinutes || 0) * 60;
  if (limit > 0 && durationSeconds > 0 && completionVerdict === 'pass' && durationSeconds <= 0.8 * limit) {
    s += 10;
    parts.push('+10 finished the task well under the time limit');
  }
  if (parts.length === 0) parts.push('no tool interactions observed — neutral 50');
  return { score: clamp(Math.round(s)), parts };
}

function integrityScore(integrity = {}, integrityReview = null) {
  if (integrityReview === 'cleared') {
    return { score: 100, parts: ['founder reviewed the flagged moments and cleared them — restored to 100'] };
  }
  let s = 100;
  const parts = [];
  const face = integrity.faceFlags?.length ?? 0;
  const voice = integrity.voiceFlags?.length ?? 0;
  const violations = integrity.windowBehavior?.focusViolations ?? 0;
  if (face) { const d = Math.min(45, 15 * face); s -= d; parts.push(`−${d} ${face} face flag(s)`); }
  if (voice) { const d = Math.min(30, 10 * voice); s -= d; parts.push(`−${d} ${voice} voice flag(s)`); }
  if (violations) { const d = Math.min(60, 20 * violations); s -= d; parts.push(`−${d} ${violations} focus escape(s)`); }
  if (integrity.windowBehavior?.unrecordedActivity) { s -= 25; parts.push('−25 unrecorded off-window activity suspected'); }
  if (parts.length === 0) parts.push('clean session — 100');
  return { score: clamp(Math.round(s)), parts };
}

// Hard gates: rules that override the score. Each returns a cap on the final
// recommendation. Integrity NEVER hard-rejects — it caps at borderline and
// demands human review of the flagged moments, because flags are pointers,
// not verdicts. Once the founder reviews (integrityReview: 'cleared' or
// 'confirmed'), the cap resolves accordingly.
function evaluateGates({ completion, thinkingSignals, percentAiAssisted, integrity, finalCodeEmpty, integrityReview }) {
  const gates = [];
  if (finalCodeEmpty) {
    gates.push({ id: 'empty_submission', cap: 'no_hire', reason: 'Nothing was submitted.' });
  }
  if (completion?.verdict === 'fail') {
    gates.push({ id: 'task_failed', cap: 'no_hire', reason: 'The task requirements were not met.' });
  }
  // "Didn't edit it" is not "didn't understand it" — verification (running
  // it, reading it back, testing an edge case) counts as understanding, so
  // this gate only fires when there is neither editing NOR verification.
  if (
    thinkingSignals?.noEvidenceOfUnderstanding &&
    !thinkingSignals?.verifiedBeforeSubmit &&
    (percentAiAssisted ?? 0) >= 80
  ) {
    gates.push({
      id: 'blind_ai_submission',
      cap: 'no_hire',
      reason: 'Submission is ≥80% AI output with no evidence — neither editing nor verification — that the candidate understood it.',
    });
  }
  if (completion?.verdict === 'partial' && !completion?.deliberateScopeCut) {
    gates.push({ id: 'partial_completion', cap: 'hire', reason: 'Partial completion cannot be a strong hire.' });
  }
  // Rules-lawyer guard: literal requirement-ticking with a brittle, minimal
  // implementation is not a hire signal, however high the completion count.
  if (completion?.verdict !== 'fail' && Number.isFinite(completion?.codeQuality) && completion.codeQuality <= 3) {
    gates.push({
      id: 'brittle_minimal_solution',
      cap: 'borderline',
      reason: 'Requirements technically satisfied but the implementation is minimal/brittle (quality ≤3/10) — review the code before hiring.',
    });
  }
  if (integrity?.status === 'flagged') {
    if (integrityReview === 'cleared') {
      // Founder watched the flagged moments and cleared them — no cap.
    } else if (integrityReview === 'confirmed') {
      gates.push({
        id: 'integrity_confirmed',
        cap: 'no_hire',
        reason: 'The founder reviewed the flagged moments and confirmed the integrity concern.',
      });
    } else {
      gates.push({
        id: 'integrity_review_required',
        cap: 'borderline',
        reason: 'Integrity flags require human review of the flagged moments before any hire decision.',
        pendingReview: true,
      });
    }
  }
  return gates;
}

export function computeScoring(report, { durationSeconds, timeLimitMinutes, finalCodeEmpty, integrityReview } = {}) {
  const layers = {
    completion: completionScore(report.completion),
    thinking: thinkingScore(report.thinking?.signals, {
      completionVerdict: report.completion?.verdict,
      worksCorrectly: report.completion?.worksCorrectly,
      codeQuality: report.completion?.codeQuality,
      percentOwnWork: report.toolUsage?.percentOwnWork,
    }),
    toolUse: toolUseScore({
      toolPurposes: report.toolPurposes,
      percentOwnWork: report.toolUsage?.percentOwnWork,
      durationSeconds,
      timeLimitMinutes,
      completionVerdict: report.completion?.verdict,
    }),
    integrity: integrityScore(report.integrity, integrityReview),
  };

  const { weights, bands } = SCORING_CONFIG;
  const score = Math.round(
    Object.entries(weights).reduce((sum, [k, w]) => sum + w * layers[k].score, 0),
  );

  let recommendation = bands.find((b) => score >= b.min)?.recommendation ?? 'no_hire';
  const gates = evaluateGates({
    completion: report.completion,
    thinkingSignals: report.thinking?.signals,
    percentAiAssisted: report.toolUsage?.percentAiAssisted,
    integrity: report.integrity,
    finalCodeEmpty,
    integrityReview,
  });
  for (const gate of gates) {
    if (RANK[gate.cap] < RANK[recommendation]) recommendation = gate.cap;
  }

  return {
    score,
    recommendation,
    pendingReview: gates.some((g) => g.pendingReview),
    weights,
    layers: Object.fromEntries(
      Object.entries(layers).map(([k, v]) => [k, { score: v.score, weight: weights[k], parts: v.parts }]),
    ),
    gates,
    bands,
  };
}
