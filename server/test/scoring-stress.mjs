// Stress tests for the decision engine: 10 real-world edge cases where the
// JUDGMENT (not the code) is what's being tested. Each scenario declares its
// expected verdict BEFORE the engine runs — a mismatch means a weight or gate
// is wrong, not the test.
//
// Run: node server/test/scoring-stress.mjs
//
// Scenarios 5 (integrity-review UX), 7 (language fairness), 8 (ambiguous
// briefs), and 9 (unknown tools) are primarily perception/UX-layer rules —
// their prompt rules live in prompt.js; the engine-visible slice of each is
// tested here.

import { computeScoring } from '../src/scoring.js';

const SIGNALS_NONE = {
  modifiedAiOutputBeforeUse: false, caughtAiMistake: false, testedOwnWork: false,
  verifiedBeforeSubmit: false, brokeProblemDown: false, promptsImproved: false,
  explainedReasoning: false, pastedVerbatimNoTesting: false,
  noEvidenceOfUnderstanding: false, repeatedIdenticalPrompts: false, outputDiverged: false,
};
const CLEAN_INTEGRITY = {
  status: 'clean', faceFlags: [], voiceFlags: [],
  windowBehavior: { tabSwitches: 0, focusViolations: 0, unrecordedActivity: false },
};
const report = ({ completion = {}, signals = {}, toolUsage = {}, toolPurposes = [], integrity = CLEAN_INTEGRITY }) => ({
  completion: {
    verdict: 'pass', requirementsTotal: 3, requirementsMet: 3, deliberateScopeCut: false,
    worksCorrectly: true, codeQuality: 8, ...completion,
  },
  thinking: { signals: { ...SIGNALS_NONE, ...signals } },
  toolUsage: { percentOwnWork: 60, percentAiAssisted: 40, ...toolUsage },
  toolPurposes,
  integrity,
});

const RANK = { no_hire: 0, borderline: 1, hire: 2, strong_hire: 3 };
let failures = 0;
const results = {};

function expect(name, scoring, { atLeast, atMost, exactly, pendingReview, gateIds }) {
  results[name] = scoring;
  const problems = [];
  const got = scoring.recommendation;
  if (exactly && got !== exactly) problems.push(`expected exactly ${exactly}, got ${got}`);
  if (atLeast && RANK[got] < RANK[atLeast]) problems.push(`expected ≥ ${atLeast}, got ${got}`);
  if (atMost && RANK[got] > RANK[atMost]) problems.push(`expected ≤ ${atMost}, got ${got}`);
  if (pendingReview !== undefined && scoring.pendingReview !== pendingReview) {
    problems.push(`expected pendingReview=${pendingReview}, got ${scoring.pendingReview}`);
  }
  for (const id of gateIds || []) {
    if (!scoring.gates.some((g) => g.id === id)) problems.push(`expected gate ${id} to fire`);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} score=${String(scoring.score).padStart(3)} → ${got}` +
    (scoring.gates.length ? `  [${scoring.gates.map((g) => g.id).join(', ')}]` : '') +
    (ok ? '' : `\n      ${problems.join('; ')}`),
  );
}

// ── 1. The fast, quiet expert ──────────────────────────────────────────────
// 12 min of 45, one Google search, no narration, no tests — just correct,
// clean code. Must NOT lose to a narrating mediocre candidate.
expect('S1 fast quiet expert', computeScoring(report({
  completion: { codeQuality: 9 },
  toolUsage: { percentOwnWork: 95, percentAiAssisted: 5 },
  toolPurposes: [{ intent: 'accelerate' }],
}), { durationSeconds: 720, timeLimitMinutes: 45, finalCodeEmpty: false }),
  { exactly: 'strong_hire' });

// ── 2. The slow learner who gets there ─────────────────────────────────────
// 20 clumsy minutes (2 avoid_thinking uses), then visible adaptation: better
// prompts, caught the AI's mistake, fixed, tested, finished. The arc must win.
expect('S2 slow learner who recovers', computeScoring(report({
  completion: { codeQuality: 7 },
  signals: { promptsImproved: true, caughtAiMistake: true, testedOwnWork: true, modifiedAiOutputBeforeUse: true },
  toolUsage: { percentOwnWork: 40, percentAiAssisted: 60 },
  toolPurposes: [
    { intent: 'avoid_thinking' }, { intent: 'avoid_thinking' },
    { intent: 'understand' }, { intent: 'accelerate' }, { intent: 'accelerate' },
  ],
}), { durationSeconds: 2580, timeLimitMinutes: 45, finalCodeEmpty: false }),
  { atLeast: 'hire' });

// ── 3a. Paste-and-pray (no verification at all) ───────────────────────────
// Big verbatim paste, no edits, no verification, submits instantly. Correct
// by luck — the gate should still fire.
expect('S3a confident paster, never verified', computeScoring(report({
  signals: { pastedVerbatimNoTesting: true, noEvidenceOfUnderstanding: true },
  toolUsage: { percentOwnWork: 10, percentAiAssisted: 90 },
  toolPurposes: [{ intent: 'avoid_thinking' }],
}), { durationSeconds: 900, timeLimitMinutes: 45, finalCodeEmpty: false }),
  { exactly: 'no_hire', gateIds: ['blind_ai_submission'] });

// ── 3b. Same paste, but they verified ──────────────────────────────────────
// No edits, but visibly read it through / ran it. "Didn't edit" must not mean
// "didn't understand" — no blind gate.
const s3b = computeScoring(report({
  signals: { verifiedBeforeSubmit: true },
  toolUsage: { percentOwnWork: 10, percentAiAssisted: 90 },
  toolPurposes: [{ intent: 'accelerate' }],
}), { durationSeconds: 900, timeLimitMinutes: 45, finalCodeEmpty: false });
expect('S3b same paste, visibly verified', s3b, { atLeast: 'hire' });
if (s3b.gates.some((g) => g.id === 'blind_ai_submission')) { failures++; console.log('FAIL  S3b must not fire blind_ai_submission'); }

// ── 4. One loud paste in an otherwise great session ────────────────────────
// 35 min of evidenced own work, then one unedited AI chunk at the deadline.
// A single outlier event, not a pattern — must stay a strong outcome.
expect('S4 one loud paste, great session', computeScoring(report({
  signals: {
    brokeProblemDown: true, explainedReasoning: true, testedOwnWork: true,
    modifiedAiOutputBeforeUse: true, pastedVerbatimNoTesting: true,
  },
  toolUsage: { percentOwnWork: 70, percentAiAssisted: 30 },
  toolPurposes: [{ intent: 'understand' }, { intent: 'accelerate' }, { intent: 'avoid_thinking' }],
}), { durationSeconds: 2600, timeLimitMinutes: 45, finalCodeEmpty: false }),
  { atLeast: 'hire' });

// ── 5. The legitimate multitasker (false integrity flag) ──────────────────
// Excellent session; toddler in frame 15s + one background voice. Must cap at
// borderline pending review — then clear in one click back to the real verdict,
// or confirm down to no_hire.
const s5Report = report({
  completion: { codeQuality: 9 },
  signals: { testedOwnWork: true, explainedReasoning: true, brokeProblemDown: true },
  toolUsage: { percentOwnWork: 80, percentAiAssisted: 20 },
  toolPurposes: [{ intent: 'accelerate' }],
  integrity: {
    status: 'flagged',
    faceFlags: [{ at: '20:00', note: 'second face briefly in frame (~15s)' }],
    voiceFlags: [{ at: '20:02', note: 'second voice briefly audible' }],
    windowBehavior: { tabSwitches: 1, focusViolations: 0, unrecordedActivity: false },
  },
});
const s5Ctx = { durationSeconds: 2400, timeLimitMinutes: 45, finalCodeEmpty: false };
expect('S5 false flag — before review', computeScoring(s5Report, s5Ctx),
  { exactly: 'borderline', pendingReview: true, gateIds: ['integrity_review_required'] });
expect('S5 false flag — founder cleared', computeScoring(s5Report, { ...s5Ctx, integrityReview: 'cleared' }),
  { exactly: 'strong_hire', pendingReview: false });
expect('S5 real flag — founder confirmed', computeScoring(s5Report, { ...s5Ctx, integrityReview: 'confirmed' }),
  { exactly: 'no_hire', gateIds: ['integrity_confirmed'] });

// ── 6. The rules-lawyer ─────────────────────────────────────────────────────
// Every literal requirement ticked, works, but brittle/minimal (quality 3).
// Must NOT reach hire.
const s6 = computeScoring(report({
  completion: { codeQuality: 3 },
  toolUsage: { percentOwnWork: 70, percentAiAssisted: 30 },
}), { durationSeconds: 2000, timeLimitMinutes: 45, finalCodeEmpty: false });
expect('S6 rules-lawyer (brittle pass)', s6, { atMost: 'borderline', gateIds: ['brittle_minimal_solution'] });

// ── 9. Unknown tool (engine slice: names must not matter) ─────────────────
// The engine scores intents, never tool names — an unidentified AI plugin
// classified 'accelerate' must score identically to ChatGPT.
const named = computeScoring(report({ toolPurposes: [{ tool: 'ChatGPT', intent: 'accelerate' }] }),
  { durationSeconds: 1800, timeLimitMinutes: 45, finalCodeEmpty: false });
const unknown = computeScoring(report({ toolPurposes: [{ tool: 'AI chat interface (unidentified)', intent: 'accelerate' }] }),
  { durationSeconds: 1800, timeLimitMinutes: 45, finalCodeEmpty: false });
const s9ok = named.score === unknown.score;
if (!s9ok) failures++;
console.log(`${s9ok ? 'PASS' : 'FAIL'}  S9 unknown tool scores same as named tool     ${unknown.score} vs ${named.score}`);

// ── 10. The strategic skipper ───────────────────────────────────────────────
// Deliberately deprioritized 1 of 4 requirements, said so in a comment,
// delivered the rest polished and tested. Triage is judgment: no partial cap,
// and they must outscore the rules-lawyer who "finished" sloppily.
const s10 = computeScoring(report({
  completion: { verdict: 'partial', requirementsTotal: 4, requirementsMet: 3, deliberateScopeCut: true, codeQuality: 9 },
  signals: { testedOwnWork: true, explainedReasoning: true, brokeProblemDown: true },
  toolUsage: { percentOwnWork: 75, percentAiAssisted: 25 },
  toolPurposes: [{ intent: 'accelerate' }, { intent: 'understand' }],
}), { durationSeconds: 2700, timeLimitMinutes: 45, finalCodeEmpty: false });
expect('S10 strategic skipper (communicated triage)', s10, { atLeast: 'hire' });
if (s10.gates.some((g) => g.id === 'partial_completion')) { failures++; console.log('FAIL  S10 must not fire partial_completion'); }
const s10beats6 = s10.score > s6.score;
if (!s10beats6) failures++;
console.log(`${s10beats6 ? 'PASS' : 'FAIL'}  S10 skipper outscores S6 rules-lawyer         ${s10.score} vs ${s6.score}`);

// Contrast: same partial but silent (panic, not triage) → capped at hire.
expect('S10b silent partial (no communicated cut)', computeScoring(report({
  completion: { verdict: 'partial', requirementsTotal: 4, requirementsMet: 3, codeQuality: 9 },
  signals: { testedOwnWork: true, explainedReasoning: true, brokeProblemDown: true },
  toolUsage: { percentOwnWork: 75, percentAiAssisted: 25 },
}), { durationSeconds: 2700, timeLimitMinutes: 45, finalCodeEmpty: false }),
  { atMost: 'hire', gateIds: ['partial_completion'] });

// ── Cross-check: S1 expert must not lose to a narrating mediocre candidate ──
const narrator = computeScoring(report({
  completion: { codeQuality: 6 },
  signals: { explainedReasoning: true, testedOwnWork: true, brokeProblemDown: true },
  toolUsage: { percentOwnWork: 50, percentAiAssisted: 50 },
  toolPurposes: [{ intent: 'accelerate' }, { intent: 'understand' }],
}), { durationSeconds: 2650, timeLimitMinutes: 45, finalCodeEmpty: false });
const s1beats = results['S1 fast quiet expert'].score >= narrator.score;
if (!s1beats) failures++;
console.log(`${s1beats ? 'PASS' : 'FAIL'}  S1 expert ≥ narrating mediocre candidate      ${results['S1 fast quiet expert'].score} vs ${narrator.score}`);

console.log(failures === 0 ? '\nAll stress tests passed.' : `\n${failures} FAILURE(S) — a weight or gate needs fixing.`);
process.exit(failures === 0 ? 0 : 1);
