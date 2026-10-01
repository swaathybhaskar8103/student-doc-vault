import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(path.join(DATA_DIR, 'vault.db'));
// Owner-only: the database holds names and emails. New -wal/-shm files copy the main file's mode.
for (const suffix of ['', '-wal', '-shm']) {
  const file = path.join(DATA_DIR, `vault.db${suffix}`);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
}
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS students (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    doc_type      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    iv            TEXT NOT NULL,
    auth_tag      TEXT NOT NULL,
    uploaded_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_student ON documents(student_id);

  CREATE TABLE IF NOT EXISTS admins (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_login_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id    TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    used        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    used        INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT,
    ip          TEXT,
    user_agent  TEXT,
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_student ON audit_log(student_id, at);
`);

// Columns added after the first release; older databases get them on startup.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Bumped on password change so every other logged-in session for that student stops working.
addColumn('students', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
// College review: pending until staff mark it verified or rejected.
// Departments: a student's department; a staff member's department, or 'ALL' (college office).
// Existing staff become 'ALL' so they can still manage everything.
addColumn('students', 'department', 'TEXT');
addColumn('admins', 'department', "TEXT NOT NULL DEFAULT 'ALL'");
addColumn('documents', 'title', 'TEXT'); // the student's own name for an "Other certificate"
addColumn('documents', 'status', "TEXT NOT NULL DEFAULT 'pending'");
addColumn('documents', 'review_note', 'TEXT');
addColumn('documents', 'reviewed_by', 'TEXT');
addColumn('documents', 'reviewed_at', 'INTEGER');
// Local AI first-pass check: queued -> checking -> done | error (NULL = not checked).
addColumn('documents', 'ai_status', 'TEXT');
addColumn('documents', 'ai_verdict', 'TEXT'); // ok | warn | fail
addColumn('documents', 'ai_summary', 'TEXT');
addColumn('documents', 'ai_details', 'TEXT'); // JSON of what the model read
addColumn('documents', 'ai_checked_at', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS documents_status ON documents(status, uploaded_at)');
