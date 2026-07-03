import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const STATUS_STYLES = {
  in_progress: 'bg-amber-100 text-amber-800',
  queued: 'bg-sky-100 text-sky-800',
  processing: 'bg-sky-100 text-sky-800',
  complete: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
};
const REC_STYLES = {
  strong_hire: 'bg-emerald-600 text-white',
  hire: 'bg-emerald-500 text-white',
  borderline: 'bg-amber-500 text-white',
  no_hire: 'bg-red-500 text-white',
};
const REC_RANK = { strong_hire: 0, hire: 1, borderline: 2, no_hire: 3 };
const RATING_RANK = { high: 0, medium: 1, low: 2 };

const COLUMNS = [
  { key: 'name', label: 'Candidate' },
  { key: 'verdict', label: 'Verdict' },
  { key: 'completion', label: 'Completed' },
  { key: 'ownWork', label: 'Own work' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'integrity', label: 'Integrity' },
  { key: 'time', label: 'Time used' },
  { key: 'status', label: 'Status' },
];

function sortValue(a, key) {
  const s = a.summary;
  switch (key) {
    case 'name': return (a.candidateName || '').toLowerCase();
    case 'verdict': return s ? REC_RANK[s.recommendation] ?? 9 : 99;
    case 'completion': return s ? { pass: 0, partial: 1, fail: 2 }[s.completion] ?? 9 : 99;
    case 'ownWork': return s?.percentOwnWork != null ? -s.percentOwnWork : 999;
    case 'thinking': return s ? RATING_RANK[s.thinkingRating] ?? 9 : 99;
    case 'integrity': return s ? (s.integrityStatus === 'clean' ? 0 : 1) : 99;
    case 'time': return a.durationSeconds ?? Infinity;
    case 'status': return a.status;
    default: return 0;
  }
}

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function FounderTask() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [sortKey, setSortKey] = useState('verdict');

  const shareUrl = `${window.location.origin}/attempt/${taskId}`;

  useEffect(() => {
    api.getTask(taskId).then(setTask).catch((e) => setError(e.message));
    let cancelled = false;
    async function poll() {
      try {
        const list = await api.listAttempts(taskId);
        if (!cancelled) setAttempts(list);
      } catch { /* transient */ }
    }
    poll();
    const iv = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [taskId]);

  const sorted = useMemo(
    () => [...attempts].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      return va < vb ? -1 : va > vb ? 1 : 0;
    }),
    [attempts, sortKey],
  );

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!task) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <Link to="/" className="text-sm text-indigo-600 hover:underline">← All tasks</Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900">{task.title}</h1>
          <p className="text-sm text-slate-500">Time limit: {task.timeLimitMinutes} minutes</p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Shareable candidate link</h2>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm"
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(shareUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Send this link to a candidate. They'll see the brief and a consent screen before anything records.
          </p>
        </section>

        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Brief</h2>
          <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{task.brief}</pre>
        </section>

        <section>
          <h2 className="mb-1 text-lg font-semibold text-slate-900">Candidates</h2>
          <p className="mb-3 text-xs text-slate-400">
            Click a column to sort, click a row for the full layered report. Refreshes automatically.
          </p>
          {attempts.length === 0 ? (
            <p className="text-sm text-slate-500">No attempts yet. This list refreshes automatically.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                    {COLUMNS.map((c) => (
                      <th key={c.key} className="px-4 py-2.5">
                        <button
                          onClick={() => setSortKey(c.key)}
                          className={`hover:text-slate-700 ${sortKey === c.key ? 'font-bold text-slate-700' : ''}`}
                        >
                          {c.label}{sortKey === c.key ? ' ↓' : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((a) => {
                    const s = a.summary;
                    return (
                      <tr
                        key={a.id}
                        onClick={() => navigate(`/founder/attempts/${a.id}`)}
                        className="cursor-pointer border-b last:border-0 hover:bg-indigo-50/50"
                      >
                        <td className="px-4 py-3">
                          <span className="font-medium text-slate-800">{a.candidateName || 'Anonymous'}</span>
                          <span className="ml-2 block text-xs text-slate-400 sm:ml-0">{new Date(a.createdAt).toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-3">
                          {s?.recommendation ? (
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${REC_STYLES[s.recommendation] || 'bg-slate-100'}`}>
                              {s.recommendation.replace('_', ' ')}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 capitalize text-slate-700">{s?.completion || '—'}</td>
                        <td className="px-4 py-3 text-slate-700">{s?.percentOwnWork != null ? `${s.percentOwnWork}%` : '—'}</td>
                        <td className="px-4 py-3 capitalize text-slate-700">{s?.thinkingRating || '—'}</td>
                        <td className="px-4 py-3">
                          {s?.integrityStatus ? (
                            <span className={s.integrityStatus === 'clean' ? 'text-emerald-600' : 'font-semibold text-amber-600'}>
                              {s.integrityStatus === 'clean' ? '✓ clean' : '⚠ flagged'}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">{fmtDuration(a.durationSeconds)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status] || 'bg-slate-100 text-slate-600'}`}>
                            {a.status.replace('_', ' ')}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
