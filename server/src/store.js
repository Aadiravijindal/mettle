import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads', 'attempts');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db = { tasks: {}, attempts: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Could not parse db.json, starting fresh:', err.message);
  }
}

let saveTimer = null;
export function save() {
  // Debounce writes; the dataset is tiny (JSON metadata only), so a full rewrite is fine.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 100);
}

export const tasks = db.tasks;
export const attempts = db.attempts;

export function attemptDir(attemptId) {
  const dir = path.join(UPLOADS_DIR, attemptId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
