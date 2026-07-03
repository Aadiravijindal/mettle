import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

function parseClock(str) {
  // "M:SS" or "H:MM:SS" → seconds
  const parts = String(str || '').split(':').map((n) => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const REC_STYLES = {
  strong_hire: 'bg-emerald-600',
  hire: 'bg-emerald-500',
  borderline: 'bg-amber-500',
  no_hire: 'bg-red-500',
};
const COMPLETION_STYLES = {
  pass: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  partial: 'text-amber-700 bg-amber-50 border-amber-200',
  fail: 'text-red-700 bg-red-50 border-red-200',
};
const KIND_LABEL = { ai: 'AI', search: 'Search', docs: 'Docs', editor: 'Editor', other: 'Other' };

function Section({ title, subtitle, children }) {
  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {subtitle && <p className="mt-0.5 mb-3 text-xs text-slate-400">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  );
}

function TimestampButton({ at, onSeek }) {
  return (
    <button
      onClick={() => onSeek(at)}
      className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
      title="Jump to this moment in the recordings"
    >
      {at}
    </button>
  );
}

export default function FounderReport() {
  const { attemptId } = useParams();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);
  const webcamRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let iv = null;
    async function poll() {
      try {
        const data = await api.getAttempt(attemptId);
        if (cancelled) return;
        setAttempt(data);
        if ((data.status === 'complete' || data.status === 'failed') && iv) {
          clearInterval(iv);
          iv = null;
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }
    poll();
    iv = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
  }, [attemptId]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!attempt) return <div className="p-8 text-slate-500">Loading…</div>;

  const report = attempt.report;

  // Both recordings started together, so one timestamp seeks both in sync.
  function seekTo(clock) {
    const t = parseClock(clock);
    for (const ref of [videoRef, webcamRef]) {
      const v = ref.current;
      if (!v) continue;
      v.currentTime = t;
      v.play().catch(() => {});
    }
    videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const integrity = report?.integrity;
  const flagged = integrity?.status === 'flagged';
  const review = report?.integrityReview;

  async function resolveIntegrity(decision) {
    try {
      await api.reviewIntegrity(attemptId, decision);
      const data = await api.getAttempt(attemptId);
      setAttempt(data);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <Link to={`/founder/tasks/${attempt.taskId}`} className="text-sm text-indigo-600 hover:underline">← Back to task</Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            {attempt.candidateName || 'Anonymous candidate'}
            <span className="ml-2 text-base font-normal text-slate-500">· {attempt.taskTitle}</span>
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {attempt.status !== 'complete' && attempt.status !== 'failed' && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 p-6 text-sky-800">
            <p className="font-medium">
              {attempt.status === 'in_progress'
                ? 'The candidate is still working on this attempt.'
                : 'Analyzing the session… this usually takes a few minutes.'}
            </p>
            <p className="mt-1 text-sm">This page refreshes automatically.</p>
          </div>
        )}

        {attempt.status === 'failed' && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
            <p className="font-medium">Analysis failed.</p>
            <p className="mt-1 text-sm">{attempt.error}</p>
          </div>
        )}

        {report && (
          <>
            {/* ── LAYER 0 — the verdict ─────────────────────────────── */}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div className={`rounded-xl p-5 text-white shadow-sm ${REC_STYLES[report.recommendation] || 'bg-slate-500'}`}>
                <p className="text-xs uppercase tracking-wide opacity-80">Recommendation</p>
                <p className="mt-1 text-2xl font-bold">{String(report.recommendation || '—').replace('_', ' ')}</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Task completed</p>
                <p className="mt-1 text-2xl font-bold capitalize text-slate-900">{report.completion?.verdict || '—'}</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Own work</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{report.toolUsage?.percentOwnWork ?? '—'}%</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Time used</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {report.durationUsed} <span className="text-sm font-normal text-slate-400">/ {report.timeLimit}</span>
                </p>
              </div>
            </section>
            <section className="rounded-xl border bg-white px-6 py-4 shadow-sm">
              <p className="text-slate-800">{report.oneLineSummary}</p>
              {report.scoring?.pendingReview && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                  ⚠ Capped at borderline pending your review — this session has integrity flags (Layer 2). Click the
                  timestamps there, watch the moments, and resolve with one click; the verdict updates instantly.
                </p>
              )}
              {review && (
                <p className={`mt-2 rounded-lg px-3 py-2 text-sm font-medium ${review.decision === 'cleared' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
                  {review.decision === 'cleared'
                    ? `✓ You reviewed the flagged moments and cleared them (${new Date(review.at).toLocaleString()}) — cap lifted.`
                    : `✗ You reviewed the flagged moments and confirmed the concern (${new Date(review.at).toLocaleString()}).`}
                </p>
              )}
            </section>

            {/* ── How the verdict was computed (the algorithm, transparent) ── */}
            {report.scoring && (
              <Section
                title={`How the verdict was computed — score ${report.scoring.score}/100`}
                subtitle="Deterministic: the AI only reports observations; this fixed formula turns them into the verdict. Same evidence always gives the same result."
              >
                <div className="space-y-3">
                  {Object.entries(report.scoring.layers).map(([key, layer]) => (
                    <div key={key}>
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="font-medium capitalize text-slate-700">
                          {key === 'toolUse' ? 'Tool use' : key} <span className="text-xs text-slate-400">× {Math.round(layer.weight * 100)}%</span>
                        </span>
                        <span className="font-mono text-slate-700">{layer.score}/100</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${layer.score >= 70 ? 'bg-emerald-500' : layer.score >= 40 ? 'bg-amber-400' : 'bg-red-400'}`}
                          style={{ width: `${layer.score}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{layer.parts.join(' · ')}</p>
                    </div>
                  ))}
                </div>
                {report.scoring.gates?.length > 0 && (
                  <div className="mt-4 border-t pt-3">
                    <p className="text-xs font-semibold uppercase text-slate-400">Rules triggered</p>
                    <ul className="mt-1 space-y-1 text-sm text-slate-700">
                      {report.scoring.gates.map((g, i) => (
                        <li key={i}>
                          <span className="font-medium">caps at {g.cap.replace('_', ' ')}:</span> {g.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-4 border-t pt-3 text-xs text-slate-400">
                  Bands: ≥80 strong hire · ≥62 hire · ≥42 borderline · below 42 no hire. Gates can only lower the
                  band, never raise it.
                </p>
              </Section>
            )}

            {/* ── LAYER 1 — did they complete the task ─────────────── */}
            <Section title="1 · Task completion">
              <div className={`mb-4 inline-block rounded-full border px-3 py-1 text-sm font-semibold capitalize ${COMPLETION_STYLES[report.completion?.verdict] || 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                {report.completion?.verdict || 'unknown'}
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase text-slate-400">What was required</p>
                  <p className="mt-1 text-sm text-slate-700">{report.completion?.required}</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase text-slate-400">What was delivered</p>
                  <p className="mt-1 text-sm text-slate-700">{report.completion?.delivered}</p>
                </div>
              </div>
              <p className="mt-4 text-sm text-slate-700"><span className="font-semibold">Reasoning: </span>{report.completion?.reasoning}</p>
              <p className="mt-2 text-sm text-slate-700"><span className="font-semibold">Output quality: </span>{report.completion?.outputQuality}</p>
            </Section>

            {/* ── LAYER 2 — session integrity ───────────────────────── */}
            <Section
              title="2 · Session integrity"
              subtitle="Flags are moments to review, with a link to the exact spot in the video — never an automatic verdict."
            >
              <div className={`mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold ${flagged ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                {flagged ? '⚠ Flagged — review the moments below' : '✓ Clean'}
              </div>
              <dl className="space-y-4 text-sm">
                <div>
                  <dt className="font-semibold text-slate-700">Face check</dt>
                  {integrity?.faceFlags?.length ? (
                    <ul className="mt-1 space-y-1">
                      {integrity.faceFlags.map((f, i) => (
                        <li key={i} className="text-slate-700">
                          <TimestampButton at={f.at} onSeek={seekTo} /> {f.note}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <dd className="text-slate-500">No face-related flags — candidate visible throughout the sampled frames.</dd>
                  )}
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Voice check (microphone)</dt>
                  {integrity?.voiceFlags?.length ? (
                    <ul className="mt-1 space-y-1">
                      {integrity.voiceFlags.map((f, i) => (
                        <li key={i} className="text-slate-700">
                          <TimestampButton at={f.at} onSeek={seekTo} /> {f.note}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <dd className="text-slate-500">Microphone was silent — no audio activity above the noise floor.</dd>
                  )}
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Tab / window behavior</dt>
                  <dd className="mt-1 text-slate-700">
                    {integrity?.windowBehavior?.tabSwitches ?? 0} tab switch(es) inside the recorded window ·{' '}
                    {integrity?.windowBehavior?.focusViolations ?? 0} focus escape(s) from it
                  </dd>
                  {integrity?.windowBehavior?.note && <dd className="mt-1 text-slate-600">{integrity.windowBehavior.note}</dd>}
                </div>
              </dl>
              {integrity?.notes && <p className="mt-4 border-t pt-3 text-sm text-slate-600">{integrity.notes}</p>}
              {flagged && !review && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-900">
                    Watched the flagged moments? Resolve them — the verdict recalculates immediately:
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button
                      onClick={() => resolveIntegrity('cleared')}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                    >
                      ✓ It's fine — clear the flags
                    </button>
                    <button
                      onClick={() => resolveIntegrity('confirmed')}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
                    >
                      ✗ Confirm the concern
                    </button>
                  </div>
                </div>
              )}
            </Section>

            {/* ── LAYER 3 — what tools, how much ───────────────────── */}
            <Section title="3 · Tools used, and how much">
              <div className="mb-1 flex justify-between text-sm font-medium text-slate-700">
                <span>Own work {report.toolUsage?.percentOwnWork ?? 0}%</span>
                <span>AI / tool-assisted {report.toolUsage?.percentAiAssisted ?? 0}%</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-indigo-100">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.max(0, report.toolUsage?.percentOwnWork ?? 0))}%` }}
                />
              </div>
              <table className="mt-5 w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-4">Tool</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Time spent</th>
                    <th className="py-2">Times opened</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.toolUsage?.tools || []).map((t, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium text-slate-800">{t.name}</td>
                      <td className="py-2 pr-4 text-slate-500">{KIND_LABEL[t.kind] || t.kind}</td>
                      <td className="py-2 pr-4 text-slate-700">{t.minutes} min</td>
                      <td className="py-2 text-slate-700">{t.timesOpened}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.toolUsage?.notes && <p className="mt-3 text-xs text-slate-500">{report.toolUsage.notes}</p>}
            </Section>

            {/* ── LAYER 4 — what each tool use was for ─────────────── */}
            <Section
              title="4 · What each tool use was for"
              subtitle="The why behind every AI/tool interaction — click a timestamp to watch that moment."
            >
              {(report.toolPurposes || []).length === 0 ? (
                <p className="text-sm text-slate-500">No AI/tool interactions were visible in the recording.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {report.toolPurposes.map((p, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <TimestampButton at={p.at} onSeek={seekTo} />
                      <span className="text-slate-700">
                        <span className="font-medium text-slate-900">{p.tool}</span> — {p.purpose}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* ── LAYER 5 — depth of their own thinking ────────────── */}
            <Section title="5 · Depth of their own thinking">
              <p className="mb-4 text-sm">
                <span className="text-slate-500">Overall rating: </span>
                <span className={`font-bold uppercase ${report.thinking?.rating === 'high' ? 'text-emerald-600' : report.thinking?.rating === 'low' ? 'text-red-600' : 'text-amber-600'}`}>
                  {report.thinking?.rating || '—'}
                </span>
              </p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-emerald-600">Green flags — real understanding</p>
                  {(report.thinking?.greenFlags || []).length === 0 ? (
                    <p className="mt-1 text-sm text-slate-500">None observed.</p>
                  ) : (
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-700">
                      {report.thinking.greenFlags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-red-600">Red flags — surface-level reliance</p>
                  {(report.thinking?.redFlags || []).length === 0 ? (
                    <p className="mt-1 text-sm text-slate-500">None observed.</p>
                  ) : (
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-700">
                      {report.thinking.redFlags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              {report.thinking?.evidence && (
                <p className="mt-4 border-t pt-3 text-sm text-slate-600">{report.thinking.evidence}</p>
              )}
            </Section>

            {/* ── LAYER 6 — the timeline ───────────────────────────── */}
            <Section title="6 · Session timeline" subtitle="Click a chapter to jump both recordings to that point.">
              <ol className="space-y-1">
                {(report.timeline || []).map((seg, i) => (
                  <li key={i}>
                    <button
                      onClick={() => seekTo(seg.start)}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-indigo-50"
                    >
                      <span className="font-mono text-xs text-indigo-600">{seg.start}–{seg.end}</span>
                      <span className="ml-2 text-slate-700">{seg.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}

        {/* ── LAYER 7 — the full session video ─────────────────────── */}
        {(attempt.hasVideo || attempt.hasWebcam) && (
          <Section title="7 · Full session recording" subtitle="The receipts — everything above is a summary of what's in here.">
            <div className={`grid grid-cols-1 gap-4 ${attempt.hasVideo && attempt.hasWebcam ? 'lg:grid-cols-3' : ''}`}>
              {attempt.hasVideo && (
                <div className={attempt.hasWebcam ? 'lg:col-span-2' : ''}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Browser window</p>
                  <video
                    ref={videoRef}
                    controls
                    preload="metadata"
                    src={`/api/attempts/${attemptId}/video`}
                    className="w-full rounded-lg bg-black"
                  />
                </div>
              )}
              {attempt.hasWebcam && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Webcam (with microphone audio)</p>
                  <video
                    ref={webcamRef}
                    controls
                    preload="metadata"
                    src={`/api/attempts/${attemptId}/webcam-video`}
                    className="w-full rounded-lg bg-black"
                  />
                </div>
              )}
            </div>
          </Section>
        )}
      </main>
    </div>
  );
}
