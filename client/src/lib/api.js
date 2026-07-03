async function json(res) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch { /* keep default message */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  createTask: (data) =>
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(json),

  getTask: (taskId) => fetch(`/api/tasks/${taskId}`).then(json),

  listFounderTasks: (email) =>
    fetch(`/api/founder/tasks?email=${encodeURIComponent(email)}`).then(json),

  listAttempts: (taskId) => fetch(`/api/tasks/${taskId}/attempts`).then(json),

  createAttempt: (taskId, data) =>
    fetch(`/api/tasks/${taskId}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(json),

  uploadChunk: (attemptId, stream, blob) =>
    fetch(`/api/attempts/${attemptId}/chunk?stream=${stream}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }).then(json),

  sendEvents: (attemptId, events) =>
    fetch(`/api/attempts/${attemptId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    }).then(json),

  submitAttempt: (attemptId, data) =>
    fetch(`/api/attempts/${attemptId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(json),

  getAttempt: (attemptId) => fetch(`/api/attempts/${attemptId}`).then(json),

  reviewIntegrity: (attemptId, decision, note = '') =>
    fetch(`/api/attempts/${attemptId}/integrity-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, note }),
    }).then(json),
};
