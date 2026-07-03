import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tasks, attempts, save, attemptDir, UPLOADS_DIR } from './store.js';
import { enqueueAnalysis, recoverPendingJobs, remuxRecording } from './analysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------------------------------------------------------------------------
// Tasks (founder side)
// ---------------------------------------------------------------------------
app.post('/api/tasks', (req, res) => {
  const { title, brief, timeLimitMinutes, starterCode, language, founderEmail } = req.body || {};
  if (!title || !brief) return res.status(400).json({ error: 'title and brief are required' });
  const minutes = Math.min(240, Math.max(5, Number(timeLimitMinutes) || 45));
  const id = crypto.randomUUID();
  tasks[id] = {
    id,
    title: String(title).slice(0, 200),
    brief: String(brief).slice(0, 20000),
    timeLimitMinutes: minutes,
    starterCode: typeof starterCode === 'string' ? starterCode.slice(0, 100000) : '',
    language: typeof language === 'string' ? language.slice(0, 40) : 'javascript',
    founderEmail: typeof founderEmail === 'string' ? founderEmail.toLowerCase().slice(0, 256) : '',
    createdAt: new Date().toISOString(),
  };
  save();
  res.json(tasks[id]);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

app.get('/api/founder/tasks', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email query parameter is required' });
  const list = Object.values(tasks)
    .filter((t) => t.founderEmail === email)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.get('/api/tasks/:id/attempts', (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: 'task not found' });
  const list = Object.values(attempts)
    .filter((a) => a.taskId === task.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(({ id, candidateName, status, createdAt, submittedAt, durationSeconds }) => {
      const row = { id, candidateName, status, createdAt, submittedAt, durationSeconds };
      // Comparison-table summary for completed attempts.
      if (status === 'complete') {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(attemptDir(id), 'report.json'), 'utf8'));
          row.summary = {
            score: r.scoring?.score,
            recommendation: r.recommendation,
            pendingReview: r.scoring?.pendingReview || false,
            completion: r.completion?.verdict,
            percentOwnWork: r.toolUsage?.percentOwnWork,
            thinkingRating: r.thinking?.rating,
            integrityStatus: r.integrity?.status,
          };
        } catch { /* report unreadable — row stays bare */ }
      }
      return row;
    });
  res.json(list);
});

// ---------------------------------------------------------------------------
// Attempts (candidate side)
// ---------------------------------------------------------------------------
app.post('/api/tasks/:id/attempts', (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: 'task not found' });
  const id = crypto.randomUUID();
  attempts[id] = {
    id,
    taskId: task.id,
    candidateName: String(req.body?.candidateName || '').slice(0, 120),
    webcamEnabled: Boolean(req.body?.webcamEnabled),
    consentAt: new Date().toISOString(),
    status: 'in_progress',
    createdAt: new Date().toISOString(),
  };
  attemptDir(id);
  save();
  res.json({ id });
});

// Periodic video chunk upload. ?stream=screen|webcam, chunks arrive in order
// from the client, so appending is safe.
app.post(
  '/api/attempts/:id/chunk',
  express.raw({ type: () => true, limit: '200mb' }),
  (req, res) => {
    const attempt = attempts[req.params.id];
    if (!attempt) return res.status(404).json({ error: 'attempt not found' });
    if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'attempt already submitted' });
    const stream = req.query.stream === 'webcam' ? 'webcam' : 'recording';
    fs.appendFileSync(path.join(attemptDir(attempt.id), `${stream}.webm`), req.body);
    res.json({ ok: true });
  },
);

// Editor event batches (paste/typing log).
app.post('/api/attempts/:id/events', (req, res) => {
  const attempt = attempts[req.params.id];
  if (!attempt) return res.status(404).json({ error: 'attempt not found' });
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (events.length > 0) {
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(path.join(attemptDir(attempt.id), 'events.jsonl'), lines);
  }
  res.json({ ok: true });
});

app.post('/api/attempts/:id/submit', async (req, res) => {
  const attempt = attempts[req.params.id];
  if (!attempt) return res.status(404).json({ error: 'attempt not found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'attempt already submitted' });

  const dir = attemptDir(attempt.id);
  const { finalCode, durationSeconds, events } = req.body || {};
  fs.writeFileSync(path.join(dir, 'final-code.txt'), typeof finalCode === 'string' ? finalCode : '');
  if (Array.isArray(events) && events.length > 0) {
    fs.appendFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  attempt.durationSeconds = Math.max(0, Number(durationSeconds) || 0);
  attempt.submittedAt = new Date().toISOString();
  attempt.status = 'queued';
  save();
  res.json({ ok: true });

  // Remux in the background so the video is seekable, then analyze.
  await remuxRecording(dir);
  enqueueAnalysis(attempt.id);
});

// ---------------------------------------------------------------------------
// Results (founder side)
// ---------------------------------------------------------------------------
app.get('/api/attempts/:id', (req, res) => {
  const attempt = attempts[req.params.id];
  if (!attempt) return res.status(404).json({ error: 'attempt not found' });
  const task = tasks[attempt.taskId];
  let report = null;
  const reportPath = path.join(attemptDir(attempt.id), 'report.json');
  if (attempt.status === 'complete' && fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  }
  const hasVideo = ['recording-fixed.webm', 'recording.webm'].some((f) =>
    fs.existsSync(path.join(attemptDir(attempt.id), f)),
  );
  const hasWebcam = ['webcam-fixed.webm', 'webcam.webm'].some((f) =>
    fs.existsSync(path.join(attemptDir(attempt.id), f)),
  );
  res.json({ ...attempt, taskTitle: task?.title, taskId: attempt.taskId, report, hasVideo, hasWebcam });
});

function sendRecording(req, res, candidates) {
  const attempt = attempts[req.params.id];
  if (!attempt) return res.status(404).json({ error: 'attempt not found' });
  const dir = attemptDir(attempt.id);
  const file = candidates.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return res.status(404).json({ error: 'no recording' });
  res.sendFile(file, { headers: { 'Content-Type': 'video/webm' } });
}

app.get('/api/attempts/:id/video', (req, res) =>
  sendRecording(req, res, ['recording-fixed.webm', 'recording.webm']));

app.get('/api/attempts/:id/webcam-video', (req, res) =>
  sendRecording(req, res, ['webcam-fixed.webm', 'webcam.webm']));

// ---------------------------------------------------------------------------
// Retention: recordings are deleted after RETENTION_DAYS; reports are kept.
// ---------------------------------------------------------------------------
function retentionSweep() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const attempt of Object.values(attempts)) {
    if (!attempt.submittedAt || new Date(attempt.submittedAt).getTime() > cutoff) continue;
    const dir = path.join(UPLOADS_DIR, attempt.id);
    for (const f of ['recording.webm', 'recording-fixed.webm', 'webcam.webm', 'webcam-fixed.webm']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) {
        fs.rmSync(p);
        console.log(`Retention: deleted ${p}`);
      }
    }
    fs.rmSync(path.join(dir, 'frames'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'webcam-frames'), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Static client (production build)
// ---------------------------------------------------------------------------
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`mettle server listening on http://localhost:${PORT}`);
  recoverPendingJobs();
  retentionSweep();
  setInterval(retentionSweep, 24 * 60 * 60 * 1000).unref();
});
