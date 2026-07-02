import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import '../lib/monacoSetup.js';
import { api } from '../lib/api.js';
import { startSessionRecording } from '../lib/recorder.js';

const EVENT_FLUSH_MS = 15_000;
const MAX_VIOLATIONS = 3; // tab-outs / focus losses before the attempt auto-submits

function formatCountdown(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function Attempt() {
  const { taskId } = useParams();
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  // intro → consent → starting → working → submitting → done
  const [phase, setPhase] = useState('intro');
  const [candidateName, setCandidateName] = useState('');
  const [remaining, setRemaining] = useState(null);
  const [violations, setViolations] = useState(0);

  const attemptIdRef = useRef(null);
  const sessionRef = useRef(null); // recorder handle
  const startedAtRef = useRef(null);
  const codeRef = useRef('');
  const pendingEventsRef = useRef([]);
  const webcamVideoRef = useRef(null);
  const submittingRef = useRef(false);
  const violationsRef = useRef(0);

  useEffect(() => {
    api.getTask(taskId).then((t) => {
      setTask(t);
      codeRef.current = t.starterCode || '';
    }).catch((e) => setError(e.message));
  }, [taskId]);

  const pushEvent = useCallback((event) => {
    if (!startedAtRef.current) return;
    pendingEventsRef.current.push({ t: Date.now() - startedAtRef.current, ...event });
  }, []);

  const flushEvents = useCallback(async () => {
    const events = pendingEventsRef.current.splice(0);
    if (events.length === 0 || !attemptIdRef.current) return [];
    try {
      await api.sendEvents(attemptIdRef.current, events);
      return [];
    } catch {
      // keep them for the submit payload
      return events;
    }
  }, []);

  const handleSubmit = useCallback(async (reason) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPhase('submitting');
    const endEvent =
      reason === 'timeout' ? 'time_expired'
      : reason === 'lockdown' ? 'ended_by_lockdown'
      : reason === 'screen_share_ended' ? 'screen_share_ended'
      : reason === 'webcam_ended' ? 'webcam_ended'
      : 'submitted';
    pushEvent({ type: endEvent });
    try {
      // Stop recording first so the final chunk is flushed and uploaded.
      await sessionRef.current?.stop();
    } catch (e) {
      console.error('recorder stop failed:', e);
    }
    const leftover = await flushEvents().catch(() => []);
    const durationSeconds = Math.round((Date.now() - startedAtRef.current) / 1000);
    try {
      await api.submitAttempt(attemptIdRef.current, {
        finalCode: codeRef.current,
        durationSeconds,
        events: leftover,
      });
      setPhase('done');
    } catch (e) {
      setError(`Submission failed: ${e.message}. Please contact the company that sent you this link.`);
    }
  }, [flushEvents, pushEvent]);

  // Countdown timer + auto-submit on expiry.
  useEffect(() => {
    if (phase !== 'working' || remaining === null) return;
    if (remaining <= 0) {
      handleSubmit('timeout');
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, remaining, handleSubmit]);

  // Periodic event log flush.
  useEffect(() => {
    if (phase !== 'working') return;
    const iv = setInterval(flushEvents, EVENT_FLUSH_MS);
    return () => clearInterval(iv);
  }, [phase, flushEvents]);

  // Lockdown: the assessment must stay in this tab. Leaving the tab or
  // switching focus to another window is a violation; MAX_VIOLATIONS
  // auto-submits the attempt. Every violation is logged for the analysis.
  useEffect(() => {
    if (phase !== 'working') return;
    function violation(type) {
      if (submittingRef.current) return;
      violationsRef.current += 1;
      setViolations(violationsRef.current);
      pushEvent({ type, violation: violationsRef.current });
      if (violationsRef.current >= MAX_VIOLATIONS) {
        handleSubmit('lockdown');
      }
    }
    function onVisibilityChange() {
      if (document.hidden) violation('tab_out');
      else pushEvent({ type: 'tab_in' });
    }
    function onBlur() {
      // Tab switches already fire visibilitychange; blur alone means focus
      // moved to another window (second monitor, other app) with the tab
      // still visible.
      if (!document.hidden) violation('focus_lost');
    }
    function onFocus() {
      if (!document.hidden) pushEvent({ type: 'focus_gained' });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [phase, pushEvent, handleSubmit]);

  async function handleConsent() {
    setPhase('starting');
    setError(null);
    try {
      const { id } = await api.createAttempt(taskId, { candidateName, webcamEnabled: true });
      attemptIdRef.current = id;
      const session = await startSessionRecording({ attemptId: id });
      sessionRef.current = session;
      session.onScreenShareEnded(() => {
        // Candidate hit the browser's "Stop sharing" — treat as submit.
        if (!submittingRef.current) handleSubmit('screen_share_ended');
      });
      session.onWebcamEnded(() => {
        // Camera turned off mid-session — recording is mandatory, so submit.
        if (!submittingRef.current) handleSubmit('webcam_ended');
      });
      startedAtRef.current = Date.now();
      setRemaining(task.timeLimitMinutes * 60);
      setPhase('working');
      pushEvent({ type: 'session_started' });
    } catch (e) {
      console.error(e);
      setError(
        e.name === 'NotAllowedError'
          ? 'Recording permission was declined. Tab recording, camera, and microphone are all required — click Start again and allow them.'
          : e.name === 'WrongSurfaceError' || e.name === 'WebcamRequiredError'
            ? e.message
            : `Could not start the session: ${e.message}`,
      );
      setPhase('consent');
    }
  }

  // Attach the live webcam preview once working.
  useEffect(() => {
    if (phase !== 'working') return;
    const video = webcamVideoRef.current;
    const stream = sessionRef.current?.webcamStream;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {}); // autoplay policies; muted so this succeeds
    }
  }, [phase]);

  function handleEditorMount(editor) {
    editor.onDidPaste((e) => {
      const model = editor.getModel();
      const chars = model?.getValueLengthInRange(e.range) ?? 0;
      // A snippet of what was pasted lets the analysis compare pasted content
      // against the final submission (how much survived unedited).
      const snippet = (model?.getValueInRange(e.range) ?? '').slice(0, 400);
      pushEvent({ type: 'paste', chars, snippet });
    });
    let typedSinceFlush = 0;
    editor.onDidChangeModelContent((e) => {
      codeRef.current = editor.getValue();
      for (const change of e.changes) {
        // Pastes are logged separately via onDidPaste; count small inserts as typing.
        if (change.text.length > 0 && change.text.length <= 10) typedSinceFlush += change.text.length;
        if (change.rangeLength > 0 && change.text.length === 0) {
          // deletions — aggregate below alongside typing
        }
      }
    });
    const agg = setInterval(() => {
      if (typedSinceFlush > 0) {
        pushEvent({ type: 'typing', chars: typedSinceFlush });
        typedSinceFlush = 0;
      }
    }, 10_000);
    editor.onDidDispose(() => clearInterval(agg));
  }

  if (error && phase !== 'consent') {
    return (
      <Shell>
        <div className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">{error}</div>
      </Shell>
    );
  }
  if (!task) return <Shell><p className="text-center text-slate-500">Loading…</p></Shell>;

  if (phase === 'intro') {
    return (
      <Shell>
        <div className="mx-auto max-w-2xl space-y-6">
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Hiring assessment</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">{task.title}</h1>
            <p className="mt-2 text-sm text-slate-500">
              Time limit: <strong>{task.timeLimitMinutes} minutes</strong> · This is a proctored session: it runs
              locked to this tab with your camera and microphone recording. Leaving the tab is tracked, and
              leaving it {MAX_VIOLATIONS} times ends your attempt.
            </p>
            <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{task.brief}</pre>
          </div>
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Your name</span>
              <input
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                placeholder="Jane Doe"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <button
              onClick={() => setPhase('consent')}
              className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700"
            >
              Continue
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (phase === 'consent' || phase === 'starting') {
    return (
      <Shell>
        <div className="mx-auto max-w-2xl rounded-xl border bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-slate-900">Before you start: recording consent</h1>
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <p>
              This session will <strong>record this browser tab, your camera, and your microphone</strong> for
              the hiring evaluation of the company that sent you this link. Recording starts only after you
              click "I agree — start the assessment" and stops when you submit or time runs out.
            </p>
            <ul className="list-inside list-disc space-y-1">
              <li><strong>Only this tab is shared</strong> — the browser will ask you to confirm sharing this tab. There is no option to share other windows or your screen, and nothing outside this tab is recorded.</li>
              <li><strong>Camera and microphone are required.</strong> The camera feed is reviewed to confirm you are present, alone, and working at the screen.</li>
              <li><strong>Stay on this tab.</strong> Switching to another tab or window is logged as a violation; {MAX_VIOLATIONS} violations end your attempt automatically.</li>
              <li>You can stop at any time (stopping the share or camera submits your attempt as-is).</li>
              <li>The recordings are used only for this hiring decision and are automatically deleted after 90 days.</li>
            </ul>
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-5 flex gap-3">
            <button
              onClick={handleConsent}
              disabled={phase === 'starting'}
              className="rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {phase === 'starting' ? 'Starting…' : 'I agree — start the assessment'}
            </button>
            <button onClick={() => setPhase('intro')} className="rounded-lg border px-4 py-2.5 text-slate-600 hover:bg-slate-50">
              Back
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  if (phase === 'submitting') {
    return <Shell><p className="text-center text-slate-600">Uploading your session and submitting… don't close this tab.</p></Shell>;
  }

  if (phase === 'done') {
    return (
      <Shell>
        <div className="mx-auto max-w-xl rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <h1 className="text-2xl font-bold text-emerald-800">Submitted ✓</h1>
          <p className="mt-2 text-emerald-700">Your work and session recording were uploaded. You can close this tab now — good luck!</p>
        </div>
      </Shell>
    );
  }

  // phase === 'working'
  const low = remaining !== null && remaining <= 300;
  return (
    <div className="flex h-screen flex-col bg-slate-900">
      {violations > 0 && (
        <div className="bg-red-600 px-4 py-1.5 text-center text-sm font-semibold text-white">
          Warning {violations}/{MAX_VIOLATIONS}: stay on this tab. Leaving it{' '}
          {MAX_VIOLATIONS - violations === 1 ? 'one more time' : `${MAX_VIOLATIONS - violations} more times`} will
          end your attempt automatically.
        </div>
      )}
      <header className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> REC
          </span>
          <h1 className="truncate text-sm font-semibold text-white">{task.title}</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className={`font-mono text-lg font-bold ${low ? 'text-red-400' : 'text-white'}`}>
            {formatCountdown(remaining ?? 0)}
          </span>
          <button
            onClick={() => handleSubmit('manual')}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            Submit
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-slate-700 bg-slate-800 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Brief</h2>
          <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-200">{task.brief}</pre>
          <p className="mt-4 text-xs text-slate-500">
            This tab, your camera, and your microphone are being recorded. Stay on this tab — leaving it counts
            as a violation and {MAX_VIOLATIONS} violations end the attempt.
          </p>
        </aside>
        <main className="min-w-0 flex-1">
          <Editor
            height="100%"
            theme="vs-dark"
            language={task.language || 'javascript'}
            defaultValue={task.starterCode || ''}
            onMount={handleEditorMount}
            options={{ fontSize: 14, minimap: { enabled: false }, wordWrap: 'on' }}
          />
        </main>
      </div>

      <video
        ref={webcamVideoRef}
        autoPlay
        muted
        playsInline
        className="fixed bottom-4 left-4 z-10 h-28 w-40 rounded-lg border-2 border-red-500/70 bg-black object-cover shadow-lg"
        title="Your camera is recording"
      />
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-50 px-6 py-12">
      {children}
    </div>
  );
}
