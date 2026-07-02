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

export default function FounderReport() {
  const { attemptId } = useParams();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

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

  function seekTo(clock) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = parseClock(clock);
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div className={`rounded-xl p-5 text-white shadow-sm ${REC_STYLES[report.recommendation] || 'bg-slate-500'}`}>
                <p className="text-xs uppercase tracking-wide opacity-80">Recommendation</p>
                <p className="mt-1 text-2xl font-bold">{String(report.recommendation).replace('_', ' ')}</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">AI-generated</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{report.aiUsageBreakdown?.percentEstimatedAIGenerated}%</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Own work</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{report.aiUsageBreakdown?.percentEstimatedOwnWork}%</p>
              </div>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-400">Time used</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{report.durationUsed} <span className="text-sm font-normal text-slate-400">/ {report.timeLimit}</span></p>
              </div>
            </section>

            <section className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="mb-2 text-lg font-semibold text-slate-900">Summary</h2>
              <p className="text-slate-700">{report.summary}</p>
              {report.aiUsageBreakdown?.notes && (
                <p className="mt-3 text-sm text-slate-500">AI usage: {report.aiUsageBreakdown.notes}</p>
              )}
            </section>

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="mb-3 text-lg font-semibold text-slate-900">Signals</h2>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-slate-500">Caught AI mistakes</dt><dd className="font-medium">{report.signals?.caughtAIMistakes ? 'Yes' : 'No'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Understood the code</dt><dd className="font-medium">{report.signals?.understoodTheCode}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Tested own work</dt><dd className="font-medium">{report.signals?.testedOwnWork ? 'Yes' : 'No'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Completed the task</dt><dd className="font-medium">{report.completed ? 'Yes' : 'No'}</dd></div>
                </dl>
                <p className="mt-3 text-sm text-slate-600">{report.signals?.problemBreakdown}</p>
                {report.signals?.greenFlags?.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase text-emerald-600">Green flags</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                      {report.signals.greenFlags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                )}
                {report.signals?.redFlags?.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase text-red-600">Red flags</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                      {report.signals.redFlags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              <div className="rounded-xl border bg-white p-6 shadow-sm">
                <h2 className="mb-3 text-lg font-semibold text-slate-900">Session timeline</h2>
                <p className="mb-3 text-xs text-slate-400">Click a chapter to jump to that point in the recording.</p>
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
              </div>
            </section>
          </>
        )}

        {attempt.hasVideo && (
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="mb-3 text-lg font-semibold text-slate-900">Session recording</h2>
            <video
              ref={videoRef}
              controls
              preload="metadata"
              src={`/api/attempts/${attemptId}/video`}
              className="w-full rounded-lg bg-black"
            />
          </section>
        )}
      </main>
    </div>
  );
}
