import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const STATUS_STYLES = {
  in_progress: 'bg-amber-100 text-amber-800',
  queued: 'bg-sky-100 text-sky-800',
  processing: 'bg-sky-100 text-sky-800',
  complete: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
};

export default function FounderTask() {
  const { taskId } = useParams();
  const [task, setTask] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

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

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!task) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <Link to="/" className="text-sm text-indigo-600 hover:underline">← All tasks</Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900">{task.title}</h1>
          <p className="text-sm text-slate-500">Time limit: {task.timeLimitMinutes} minutes</p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-6 py-8">
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
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Attempts</h2>
          {attempts.length === 0 ? (
            <p className="text-sm text-slate-500">No attempts yet. This list refreshes automatically.</p>
          ) : (
            <ul className="space-y-2">
              {attempts.map((a) => (
                <li key={a.id}>
                  <Link
                    to={`/founder/attempts/${a.id}`}
                    className="flex items-center justify-between rounded-lg border bg-white px-4 py-3 shadow-sm hover:border-indigo-400"
                  >
                    <div>
                      <span className="font-medium text-slate-800">{a.candidateName || 'Anonymous candidate'}</span>
                      <span className="ml-3 text-xs text-slate-400">{new Date(a.createdAt).toLocaleString()}</span>
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status] || 'bg-slate-100 text-slate-600'}`}>
                      {a.status.replace('_', ' ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
