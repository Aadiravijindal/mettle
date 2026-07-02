import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

const DEFAULT_BRIEF = `Our checkout page has a bug: when a discount code is applied and the user then changes the item quantity, the total no longer reflects the discount.

Your task:
1. Reproduce the bug in the provided code.
2. Fix it.
3. Add at least one test (or test-like check) that would have caught it.

You may use any AI tool, search engine, or documentation you like — we want to see how you actually work.`;

export default function FounderHome() {
  const [founderEmail, setFounderEmail] = useState('');
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [timeLimit, setTimeLimit] = useState(45);
  const [language, setLanguage] = useState('javascript');
  const [starterCode, setStarterCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [myTasks, setMyTasks] = useState([]);

  async function handleEmailSubmit(e) {
    e.preventDefault();
    if (!founderEmail.trim()) {
      setError('Email is required');
      return;
    }
    setLoadingTasks(true);
    setError(null);
    try {
      const tasks = await api.listFounderTasks(founderEmail);
      setMyTasks(tasks);
      setEmailSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTasks(false);
    }
  }

  async function createTask(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const task = await api.createTask({
        title,
        brief,
        timeLimitMinutes: timeLimit,
        starterCode,
        language,
        founderEmail,
      });
      setMyTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
      setTitle('');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (!emailSubmitted) {
    return (
      <div className="min-h-screen bg-slate-50">
        <header className="border-b bg-white">
          <div className="mx-auto max-w-4xl px-6 py-4">
            <h1 className="text-xl font-bold text-slate-900">
              Mettle <span className="ml-2 text-sm font-normal text-slate-500">AI-fluency hiring assessments</span>
            </h1>
          </div>
        </header>

        <main className="mx-auto max-w-4xl px-6 py-12">
          <div className="mx-auto max-w-xl rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Sign in to your account</h2>
            <p className="mt-2 text-sm text-slate-500">
              Enter your email to view and create assessment tasks.
            </p>
            <form onSubmit={handleEmailSubmit} className="mt-6 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Your email</span>
                <input
                  type="email"
                  required
                  value={founderEmail}
                  onChange={(e) => setFounderEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loadingTasks}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {loadingTasks ? 'Loading…' : 'View your tasks'}
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-slate-900">
              Mettle <span className="ml-2 text-sm font-normal text-slate-500">AI-fluency hiring assessments</span>
            </h1>
            <button
              onClick={() => {
                setEmailSubmitted(false);
                setFounderEmail('');
                setMyTasks([]);
              }}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <section className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-semibold text-slate-900">Create an assessment task</h2>
          <p className="mb-4 text-sm text-slate-500">
            Give candidates a real task from your work. They can use any AI tool — the report tells you how they worked, not just what they produced.
          </p>
          <form onSubmit={createTask} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-slate-700">Task title</span>
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Fix the checkout bug"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Time limit (minutes)</span>
                <input
                  type="number"
                  min={5}
                  max={240}
                  value={timeLimit}
                  onChange={(e) => setTimeLimit(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Brief (what the candidate sees)</span>
              <textarea
                required
                rows={6}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Editor language</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                >
                  {['javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'plaintext'].map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-slate-700">Starter code (optional)</span>
                <textarea
                  rows={3}
                  value={starterCode}
                  onChange={(e) => setStarterCode(e.target.value)}
                  placeholder="// pre-filled contents of the candidate's editor"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={creating}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create task & get shareable link'}
            </button>
          </form>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Your tasks</h2>
          {myTasks.length === 0 ? (
            <p className="text-sm text-slate-500">No tasks yet — create one above.</p>
          ) : (
            <ul className="space-y-2">
              {myTasks.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`/founder/tasks/${t.id}`}
                    className="flex items-center justify-between rounded-lg border bg-white px-4 py-3 shadow-sm hover:border-indigo-400"
                  >
                    <span className="font-medium text-slate-800">{t.title}</span>
                    <span className="text-xs text-slate-400">{new Date(t.createdAt).toLocaleString()}</span>
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
