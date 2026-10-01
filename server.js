import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { db, FILES_DIR } from './src/db.js';
import { SqliteSessionStore } from './src/sessionStore.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, safeEqual,
  encryptFile, decryptFile, sniffFileType, randomStudentId, randomResetCode, hashResetCode,
} from './src/security.js';
import {
  DOC_TYPES, documentLabel, isUploadable, docInfo, canReplace, isDepartment, deptLabel, MAX_FILE_BYTES, MAX_DOCS_PER_STUDENT, LOCK_AFTER_FAILS, LOCK_MINUTES, SESSION_MINUTES,
} from './src/config.js';
import * as views from './src/views.js';
import { isUnlocked, unlock, keyFileExists, keyFromEnv } from './src/keyVault.js';
import { isStaffNetwork, STAFF_NETWORKS_CONFIGURED, describeStaffNetworks } from './src/network.js';
import { mountAdmin } from './src/admin.js';
import { startAiWorker, initialAiStatus, AI_ENABLED, AI_AUTO_DECISION } from './src/aiCheck.js';
import {
  sendWelcomeEmail, sendStudentIdReminder, sendPasswordChangedEmail, sendPasswordResetCode, sendAccountDeletedEmail,
  sendUnlockAlert,
} from './src/mailer.js';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Online (production) mode refuses to start with settings that would leave students' documents exposed.
if (IS_PROD) {
  const problems = [];
  if (!/^https:\/\//.test(process.env.APP_URL ?? '')) problems.push('APP_URL must be the public https:// address of the site');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) problems.push('Email (SMTP_USER / SMTP_PASS) is required: password resets and notifications use it');
  if ((process.env.SESSION_SECRET ?? '').length < 32) problems.push('SESSION_SECRET is too short');
  if (!STAFF_NETWORKS_CONFIGURED) problems.push('STAFF_ALLOWED_NETWORKS must list the college network (its public IP address), so staff pages only open from the college');
  if (problems.length) {
    console.error(`Refusing to start in production:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  if (!process.env.BACKUP_PASSPHRASE) console.warn('Warning: BACKUP_PASSPHRASE is not set, so npm run backup will not work.');
  if (keyFromEnv()) console.warn('Warning: MASTER_KEY is stored in .env on this disk. Run npm run protect-key so the key is only unlocked by staff.');
  if (process.env.STAFF_TWO_STEP === 'false') console.warn('Warning: staff two-step login is off (STAFF_TWO_STEP=false). Staff log in with a password only.');
}

const app = express();
if (IS_PROD) app.set('trust proxy', 1); // behind one HTTPS proxy on this machine (Caddy or cloudflared)

app.use(helmet());
app.use(express.static(path.join(import.meta.dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(session({
  store: new SqliteSessionStore(),
  name: 'dv.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // idle timeout: expires SESSION_MINUTES after the last request
  // 'auto': Secure whenever the visitor came in over HTTPS (always, through the HTTPS proxy or tunnel), while
  // staff on the server itself can still use http://localhost.
  cookie: { httpOnly: true, sameSite: 'strict', secure: IS_PROD ? 'auto' : false, maxAge: SESSION_MINUTES * 60 * 1000 },
}));

// Every page shows private data or a form token, so never let the browser or a proxy cache it.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  req.session.csrf ??= crypto.randomBytes(32).toString('hex');
  if (req.session.studentId) {
    const student = db.prepare('SELECT id, name, department, session_version FROM students WHERE id = ?').get(req.session.studentId);
    // Password was changed elsewhere since this session logged in: treat it as logged out.
    if (student && student.session_version === req.session.sessionVersion) req.student = student;
    else delete req.session.studentId;
  }
  if (req.session.adminId) {
    const admin = db.prepare('SELECT id, name, email, department, session_version FROM admins WHERE id = ?').get(req.session.adminId);
    if (admin && admin.session_version === req.session.adminSessionVersion) req.admin = admin;
    else delete req.session.adminId;
  }
  next();
});

// While the encryption key is locked, nothing but the unlock page works.
app.use((req, res, next) => {
  if (isUnlocked() || req.path === '/unlock') return next();
  res.status(503).set('Retry-After', '60')
    .send(views.lockedPage({ csrf: req.session.csrf, staffHere: isStaffNetwork(req.ip) }));
});

// ---------- helpers ----------

const render = (req, res, page, data = {}, status = 200) =>
  res.status(status).send(views[page]({ csrf: req.session.csrf, student: req.student, ...data }));

const insertAudit = db.prepare(
  'INSERT INTO audit_log (student_id, action, detail, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?)',
);
const audit = (req, studentId, action, detail = null) =>
  insertAudit.run(studentId, action, detail, req.ip, (req.get('user-agent') ?? '').slice(0, 200), Date.now());

const flash = (req, res, type, msg) => {
  req.session.flash = { type, msg };
  res.redirect('/dashboard');
};

const regenerateSession = (req) =>
  new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));

function requireAuth(req, res, next) {
  if (!req.student) return res.redirect('/login');
  // A student must choose their department before using anything else.
  if (!req.student.department && req.path !== '/account/department') return res.redirect('/account/department');
  next();
}

function checkCsrf(req, res, next) {
  if (!safeEqual(req.body?._csrf ?? '', req.session.csrf)) {
    return render(req, res, 'errorPage', { status: 403, message: 'Your session expired. Please go back and try again.' }, 403);
  }
  next();
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Too many attempts from this network. Please wait 15 minutes and try again.',
});

// Per student, not per IP: stops one account flooding the AI queue and the disk.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.student.id,
  handler: (req, res) => flash(req, res, 'error', 'You have uploaded a lot in the last hour. Please wait a while before uploading more.'),
});

const upload = multer({
  storage: multer.memoryStorage(), // nothing unencrypted ever touches the disk
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 },
});

function cleanFilename(original, ext) {
  const base = path.basename(String(original))
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w\- ]+/g, '_')
    .trim()
    .slice(0, 80);
  return `${base || 'document'}.${ext}`;
}

function newStudentId() {
  const exists = db.prepare('SELECT 1 FROM students WHERE id = ?');
  let id;
  do id = randomStudentId(); while (exists.get(id));
  return id;
}

// ---------- pages ----------

// ---------- unlock (college network only) ----------

const unlockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  message: 'Too many unlock attempts. Wait 15 minutes.' });

function staffNetworkOnly(req, res, next) {
  if (isStaffNetwork(req.ip)) return next();
  res.status(403).send(views.errorPage({ csrf: req.session.csrf, status: 403, message: 'This page can only be opened from the college network.' }));
}

app.get('/unlock', staffNetworkOnly, (req, res) => (isUnlocked() ? res.redirect('/') : render(req, res, 'unlockPage')));

app.post('/unlock', staffNetworkOnly, unlockLimiter, checkCsrf, async (req, res) => {
  if (isUnlocked()) return res.redirect('/');
  const passphrase = String(req.body.passphrase ?? '').slice(0, 200);
  if (!(await unlock(passphrase))) {
    audit(req, 'system', 'unlock_failed');
    console.warn(`Failed unlock attempt from ${req.ip}`);
    return render(req, res, 'unlockPage', { errors: ['That passphrase is not correct.'] }, 401);
  }
  audit(req, 'system', 'unlocked');
  console.log(`DocVault unlocked from ${req.ip}`);
  sendUnlockAlert({ to: db.prepare('SELECT email FROM admins').all().map((a) => a.email), ip: req.ip, at: Date.now() });
  res.redirect('/admin/login');
});

app.get('/', (req, res) => (req.student ? res.redirect('/dashboard') : render(req, res, 'home')));

app.get('/register', (req, res) => (req.student ? res.redirect('/dashboard') : render(req, res, 'register')));

app.post('/register', authLimiter, checkCsrf, async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  const confirm = String(req.body.confirm ?? '');
  const department = String(req.body.department ?? '');

  const errors = [];
  if (name.length < 2 || name.length > 100) errors.push('Please enter your full name.');
  if (!isDepartment(department)) errors.push('Please choose your department.');
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Please enter a valid email address.');
  if (password.length < 8 || password.length > 128) errors.push('Password must be 8 to 128 characters.');
  else if (password !== confirm) errors.push('The two passwords do not match.');
  if (!errors.length && db.prepare('SELECT 1 FROM students WHERE email = ?').get(email)) {
    errors.push('An account with this email already exists. Please log in instead.');
  }
  if (errors.length) return render(req, res, 'register', { errors, values: { name, email, department } }, 400);

  const id = newStudentId();
  db.prepare('INSERT INTO students (id, name, email, department, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, email, department, await hashPassword(password), Date.now());

  await regenerateSession(req); // fresh session id on privilege change
  req.session.studentId = id;
  req.session.sessionVersion = 0;
  req.session.newStudentId = id;
  audit(req, id, 'register');
  sendWelcomeEmail({ email, name, id });
  res.redirect('/welcome');
});

app.get('/welcome', requireAuth, (req, res) => {
  const newId = req.session.newStudentId;
  if (!newId) return res.redirect('/dashboard');
  delete req.session.newStudentId;
  const { email } = db.prepare('SELECT email FROM students WHERE id = ?').get(newId);
  render(req, res, 'welcome', { newId, email });
});

app.get('/forgot-id', (req, res) => render(req, res, 'forgotId'));

app.post('/forgot-id', authLimiter, checkCsrf, (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return render(req, res, 'forgotId', { errors: ['Please enter a valid email address.'], values: { email } }, 400);
  }
  const student = db.prepare('SELECT id, name, email FROM students WHERE email = ?').get(email);
  // At most one reminder per 2 minutes per account, so this can't be used to spam someone's inbox.
  const recent = student && db.prepare(
    "SELECT 1 FROM audit_log WHERE student_id = ? AND action = 'id_reminder' AND at > ?",
  ).get(student.id, Date.now() - 2 * 60 * 1000);
  if (student && !recent) {
    sendStudentIdReminder(student);
    audit(req, student.id, 'id_reminder');
  }
  // Same answer whether or not the email is registered, so this page can't be used to check who has an account.
  render(req, res, 'forgotId', { sent: true, values: { email } });
});

// ---------- forgot password (6-digit code by email) ----------

const RESET_CODE_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;

const findStudentByLogin = (login) =>
  login.includes('@')
    ? db.prepare('SELECT * FROM students WHERE email = ?').get(login.toLowerCase())
    : db.prepare('SELECT * FROM students WHERE id = ?').get(login.toUpperCase());

app.get('/forgot-password', (req, res) => render(req, res, 'forgotPassword'));

app.post('/forgot-password', authLimiter, checkCsrf, (req, res) => {
  const login = String(req.body.login ?? '').trim().slice(0, 200);
  if (!login) return render(req, res, 'forgotPassword', { errors: ['Enter your Student ID or email.'] }, 400);

  const student = findStudentByLogin(login);
  const now = Date.now();
  // At most one code per minute and 5 per day per account: stops inbox flooding, and stops an attacker
  // from requesting code after code to keep guessing.
  const recent = student && db.prepare('SELECT 1 FROM password_resets WHERE student_id = ? AND created_at > ?')
    .get(student.id, now - 60 * 1000);
  const today = student ? db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE student_id = ? AND created_at > ?')
    .get(student.id, now - 24 * 60 * 60 * 1000).n : 0;
  if (student && !recent && today < 5) {
    const code = randomResetCode();
    db.prepare('UPDATE password_resets SET used = 1 WHERE student_id = ? AND used = 0').run(student.id); // only the newest code works
    db.prepare('INSERT INTO password_resets (student_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(student.id, hashResetCode(student.id, code), now + RESET_CODE_MINUTES * 60 * 1000, now);
    sendPasswordResetCode({ ...student, code });
    audit(req, student.id, 'reset_requested');
  }
  // Same next step whether or not the account exists, so this can't be used to check who is registered.
  req.session.reset = { login, studentId: student?.id ?? null };
  res.redirect('/reset-password');
});

app.get('/reset-password', (req, res) => {
  if (!req.session.reset) return res.redirect('/forgot-password');
  render(req, res, 'resetPassword', { login: req.session.reset.login });
});

app.post('/reset-password', authLimiter, checkCsrf, async (req, res) => {
  const pending = req.session.reset;
  if (!pending) return res.redirect('/forgot-password');
  const code = String(req.body.code ?? '').replace(/\s/g, '');
  const password = String(req.body.password ?? '');
  const confirm = String(req.body.confirm ?? '');
  const fail = (msg, status = 400) => render(req, res, 'resetPassword', { login: pending.login, errors: [msg] }, status);

  const reset = pending.studentId && db.prepare(
    'SELECT * FROM password_resets WHERE student_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1',
  ).get(pending.studentId, Date.now());

  if (!reset || !/^\d{6}$/.test(code) || !safeEqual(hashResetCode(pending.studentId, code), reset.code_hash)) {
    if (reset) {
      const attempts = reset.attempts + 1;
      db.prepare('UPDATE password_resets SET attempts = ?, used = ? WHERE id = ?')
        .run(attempts, attempts >= RESET_MAX_ATTEMPTS ? 1 : 0, reset.id);
      audit(req, pending.studentId, 'reset_code_wrong');
    }
    return fail('That code is wrong or has expired. Check the latest email, or request a new code.', 401);
  }

  if (password.length < 8 || password.length > 128) return fail('New password must be 8 to 128 characters.');
  if (password !== confirm) return fail('The two new passwords do not match.');

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(pending.studentId);
  const version = student.session_version + 1;
  db.prepare('UPDATE password_resets SET used = 1 WHERE student_id = ?').run(student.id);
  db.prepare('UPDATE students SET password_hash = ?, session_version = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(await hashPassword(password), version, student.id);

  await regenerateSession(req); // also clears req.session.reset
  req.session.studentId = student.id;
  req.session.sessionVersion = version;
  audit(req, student.id, 'password_reset');
  sendPasswordChangedEmail(student);
  req.session.flash = { type: 'success', msg: 'Your password has been reset and you are now logged in.' };
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => (req.student ? res.redirect('/dashboard') : render(req, res, 'login')));

app.post('/login', authLimiter, checkCsrf, async (req, res) => {
  // One box accepts either the Student ID or the registered email.
  const login = String(req.body.login ?? '').trim().slice(0, 200);
  const password = String(req.body.password ?? '').slice(0, 128);
  const student = login.includes('@')
    ? db.prepare('SELECT * FROM students WHERE email = ?').get(login.toLowerCase())
    : db.prepare('SELECT * FROM students WHERE id = ?').get(login.toUpperCase());
  const now = Date.now();

  if (student?.locked_until > now) {
    const mins = Math.ceil((student.locked_until - now) / 60000);
    return render(req, res, 'login', {
      errors: [`Too many failed attempts. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`],
      values: { login },
    }, 429);
  }

  // Always run the hash, even for unknown IDs, so timing doesn't reveal which IDs exist.
  const ok = await verifyPassword(password, student?.password_hash ?? DUMMY_HASH);

  if (!student || !ok) {
    if (student) {
      const fails = student.failed_attempts + 1;
      if (fails >= LOCK_AFTER_FAILS) {
        db.prepare('UPDATE students SET failed_attempts = 0, locked_until = ? WHERE id = ?')
          .run(now + LOCK_MINUTES * 60 * 1000, student.id);
        audit(req, student.id, 'locked');
      } else {
        db.prepare('UPDATE students SET failed_attempts = ? WHERE id = ?').run(fails, student.id);
        audit(req, student.id, 'login_failed');
      }
    }
    return render(req, res, 'login', { errors: ['Incorrect Student ID / email or password.'], values: { login } }, 401);
  }

  db.prepare('UPDATE students SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(student.id);
  await regenerateSession(req);
  req.session.studentId = student.id;
  req.session.sessionVersion = student.session_version;
  audit(req, student.id, 'login');
  res.redirect('/dashboard');
});

app.post('/logout', checkCsrf, (req, res) => {
  if (req.student) audit(req, req.student.id, 'logout');
  req.session.destroy(() => {
    res.clearCookie('dv.sid');
    res.redirect('/login');
  });
});

app.get('/account/password', requireAuth, (req, res) => render(req, res, 'changePassword'));

// Right to erasure: the student can permanently delete their account and every document.
app.get('/account/delete', requireAuth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE student_id = ?').get(req.student.id).n;
  render(req, res, 'deleteAccount', { count });
});

app.post('/account/delete', requireAuth, authLimiter, checkCsrf, async (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.student.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE student_id = ?').get(student.id).n;
  if (!(await verifyPassword(String(req.body.password ?? '').slice(0, 128), student.password_hash))) {
    audit(req, student.id, 'delete_account_failed');
    return render(req, res, 'deleteAccount', { count, errors: ['Your password is incorrect.'] }, 401);
  }
  if (req.body.confirm !== 'yes') return render(req, res, 'deleteAccount', { count, errors: ['Tick the box to confirm.'] }, 400);

  const fileIds = db.prepare('SELECT id FROM documents WHERE student_id = ?').all(student.id).map((d) => d.id);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM audit_log WHERE student_id = ?').run(student.id);
    db.prepare('DELETE FROM students WHERE id = ?').run(student.id); // documents and reset codes cascade
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const id of fileIds) fs.rmSync(path.join(FILES_DIR, `${id}.enc`), { force: true });
  sendAccountDeletedEmail(student);
  console.log(`Account deleted at the student's request: ${student.id} (${fileIds.length} documents)`);
  req.session.destroy(() => {
    res.clearCookie('dv.sid');
    res.send(views.accountDeleted({ csrf: '', count: fileIds.length }));
  });
});

app.post('/account/password', requireAuth, authLimiter, checkCsrf, async (req, res) => {
  const current = String(req.body.current ?? '').slice(0, 128);
  const password = String(req.body.password ?? '');
  const confirm = String(req.body.confirm ?? '');
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.student.id);

  if (!(await verifyPassword(current, student.password_hash))) {
    audit(req, student.id, 'password_change_failed');
    return render(req, res, 'changePassword', { errors: ['Your current password is incorrect.'] }, 401);
  }
  const errors = [];
  if (password.length < 8 || password.length > 128) errors.push('New password must be 8 to 128 characters.');
  else if (password !== confirm) errors.push('The two new passwords do not match.');
  else if (password === current) errors.push('New password must be different from your current password.');
  if (errors.length) return render(req, res, 'changePassword', { errors }, 400);

  const version = student.session_version + 1;
  db.prepare('UPDATE students SET password_hash = ?, session_version = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(await hashPassword(password), version, student.id);

  // Keep this browser logged in with a fresh session; every other session is now invalid.
  await regenerateSession(req);
  req.session.studentId = student.id;
  req.session.sessionVersion = version;
  audit(req, student.id, 'password_changed');
  sendPasswordChangedEmail(student);
  req.session.flash = { type: 'success', msg: 'Password changed. Any other devices logged in to your account have been logged out.' };
  res.redirect('/dashboard');
});

app.get('/dashboard', requireAuth, (req, res) => {
  const docs = db.prepare(
    'SELECT id, doc_type, title, original_name, size, uploaded_at, status, review_note, ai_status, ai_verdict, ai_summary FROM documents WHERE student_id = ? ORDER BY uploaded_at DESC',
  ).all(req.student.id);
  const activity = db.prepare(
    'SELECT action, detail, ip, at FROM audit_log WHERE student_id = ? ORDER BY at DESC, id DESC LIMIT 15',
  ).all(req.student.id);
  const f = req.session.flash;
  delete req.session.flash;
  render(req, res, 'dashboard', { docs, activity, flash: f, aiEnabled: AI_ENABLED, aiAuto: AI_AUTO_DECISION });
});

// Accounts made before departments existed choose theirs once; after that only the college office can change it.
app.get('/account/department', requireAuth, (req, res) =>
  (req.student.department ? res.redirect('/dashboard') : render(req, res, 'chooseDepartment')));

app.post('/account/department', requireAuth, checkCsrf, (req, res) => {
  if (req.student.department) return flash(req, res, 'error', 'Your department is already set. Ask the college office to change it.');
  const department = String(req.body.department ?? '');
  if (!isDepartment(department)) return render(req, res, 'chooseDepartment', { errors: ['Please choose your department.'] }, 400);
  db.prepare('UPDATE students SET department = ? WHERE id = ? AND department IS NULL').run(department, req.student.id);
  audit(req, req.student.id, 'department_set', deptLabel(department));
  flash(req, res, 'success', `Department saved: ${deptLabel(department)}.`);
});

app.get('/done', requireAuth, (req, res) => {
  const docs = db.prepare('SELECT doc_type, title FROM documents WHERE student_id = ? ORDER BY uploaded_at').all(req.student.id);
  if (!docs.length) return res.redirect('/dashboard');
  render(req, res, 'done', { docs });
});

// ---------- documents ----------

app.post('/documents', requireAuth, uploadLimiter, upload.single('file'), checkCsrf, (req, res) => {
  const docType = String(req.body.doc_type ?? '');
  if (!isUploadable(docType)) return flash(req, res, 'error', 'Please choose a document type.');
  // "Other certificate" needs a name from the student; other types ignore the field.
  const title = docInfo(docType).named ? String(req.body.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) : null;
  if (docInfo(docType).named && title.length < 2) return flash(req, res, 'error', 'For "Other certificate", type a name for it (e.g. Hackathon winner 2025).');
  if (!docInfo(docType).multiple && db.prepare('SELECT 1 FROM documents WHERE student_id = ? AND doc_type = ?').get(req.student.id, docType)) {
    return flash(req, res, 'error', `You already uploaded your ${DOC_TYPES[docType]}. To change it, delete the old one first.`);
  }
  if (!req.file) return flash(req, res, 'error', 'Please choose a file to upload.');

  const kind = sniffFileType(req.file.buffer);
  if (!kind) return flash(req, res, 'error', 'Only PDF, JPG and PNG files are allowed.');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE student_id = ?').get(req.student.id);
  if (n >= MAX_DOCS_PER_STUDENT) {
    return flash(req, res, 'error', `You can store up to ${MAX_DOCS_PER_STUDENT} documents. Delete one to upload another.`);
  }

  const docId = crypto.randomUUID();
  const name = cleanFilename(req.file.originalname, kind.ext);
  const { iv, tag, data } = encryptFile(req.file.buffer, docId);
  const filePath = path.join(FILES_DIR, `${docId}.enc`);

  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try {
    db.prepare(
      `INSERT INTO documents (id, student_id, doc_type, title, original_name, mime_type, size, iv, auth_tag, uploaded_at, ai_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(docId, req.student.id, docType, title, name, kind.mime, req.file.size, iv, tag, Date.now(), initialAiStatus());
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }

  const label = documentLabel({ doc_type: docType, title });
  audit(req, req.student.id, 'upload', `${label} (${name})`);
  flash(req, res, 'success', `${label} uploaded and encrypted.`);
});

// Ownership is enforced in the query itself: a student can only ever load rows with their own id.
const findOwnDoc = (req) =>
  db.prepare('SELECT * FROM documents WHERE id = ? AND student_id = ?').get(req.params.id, req.student.id);

// A rejected document can be swapped for a new copy, which goes back into the review queue.
app.get('/documents/:id/replace', requireAuth, (req, res) => {
  const doc = findOwnDoc(req);
  if (!doc) return flash(req, res, 'error', 'Document not found.');
  if (!canReplace(doc)) return flash(req, res, 'error', 'This document can only be replaced if it was rejected or the AI check found a problem.');
  render(req, res, 'replaceDocument', { doc });
});

app.post('/documents/:id/replace', requireAuth, uploadLimiter, upload.single('file'), checkCsrf, (req, res) => {
  const old = findOwnDoc(req);
  if (!old) return flash(req, res, 'error', 'Document not found.');
  if (!canReplace(old)) return flash(req, res, 'error', 'This document can only be replaced if it was rejected or the AI check found a problem.');
  const retry = (msg) => render(req, res, 'replaceDocument', { doc: old, errors: [msg] }, 400);
  if (!req.file) return retry('Please choose a file to upload.');
  const kind = sniffFileType(req.file.buffer);
  if (!kind) return retry('Only PDF, JPG and PNG files are allowed.');

  // New id and file, then swap the rows in one transaction, so a failure never loses the old copy.
  const docId = crypto.randomUUID();
  const name = cleanFilename(req.file.originalname, kind.ext);
  const { iv, tag, data } = encryptFile(req.file.buffer, docId);
  const filePath = path.join(FILES_DIR, `${docId}.enc`);
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try {
    db.exec('BEGIN');
    db.prepare(
      `INSERT INTO documents (id, student_id, doc_type, title, original_name, mime_type, size, iv, auth_tag, uploaded_at, ai_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(docId, req.student.id, old.doc_type, old.title, name, kind.mime, req.file.size, iv, tag, Date.now(), initialAiStatus());
    db.prepare('DELETE FROM documents WHERE id = ?').run(old.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  fs.rmSync(path.join(FILES_DIR, `${old.id}.enc`), { force: true });

  const label = documentLabel(old);
  audit(req, req.student.id, 'reupload', `${label} (${name})`);
  flash(req, res, 'success', `New copy of your ${label} uploaded. The college will review it again.`);
});

app.get('/documents/:id/download', requireAuth, (req, res) => {
  const doc = findOwnDoc(req);
  if (!doc) return render(req, res, 'errorPage', { status: 404, message: 'Document not found.' }, 404);

  let plain;
  try {
    plain = decryptFile(fs.readFileSync(path.join(FILES_DIR, `${doc.id}.enc`)), { iv: doc.iv, tag: doc.auth_tag, docId: doc.id });
  } catch (err) {
    console.error(`Decrypt failed for ${doc.id}:`, err.message);
    return render(req, res, 'errorPage', {
      status: 500, message: 'This file could not be verified. It may be damaged. Please contact the college office.',
    }, 500);
  }

  audit(req, req.student.id, 'download', `${documentLabel(doc)} (${doc.original_name})`);
  res.attachment(doc.original_name).type(doc.mime_type).send(plain);
});

app.get('/documents/:id/delete', requireAuth, (req, res) => {
  const doc = findOwnDoc(req);
  if (!doc) return flash(req, res, 'error', 'Document not found.');
  render(req, res, 'confirmDelete', { doc });
});

app.post('/documents/:id/delete', requireAuth, checkCsrf, (req, res) => {
  const doc = findOwnDoc(req);
  if (!doc) return flash(req, res, 'error', 'Document not found.');
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  fs.rmSync(path.join(FILES_DIR, `${doc.id}.enc`), { force: true });
  audit(req, req.student.id, 'delete', `${documentLabel(doc)} (${doc.original_name})`);
  flash(req, res, 'success', 'Document deleted.');
});

mountAdmin(app, { audit, checkCsrf, authLimiter, regenerateSession });

// ---------- errors ----------

app.use((req, res) => render(req, res, 'errorPage', { status: 404, message: 'Page not found.' }, 404));

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return flash(req, res, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (max 5 MB).' : 'Upload failed. Please try again.');
  }
  console.error(err);
  render(req, res, 'errorPage', { status: 500, message: 'Something went wrong. Please try again.' }, 500);
});

startAiWorker();

// Online, only the HTTPS proxy on this machine talks to the app; it is never exposed directly.
const HOST = process.env.HOST || (IS_PROD ? '127.0.0.1' : undefined);
app.listen(PORT, HOST, () => {
  console.log(`DocVault running at http://localhost:${PORT}`);
  if (!IS_PROD) console.log('Development mode: cookies are not marked Secure. Use NODE_ENV=production behind HTTPS.');
  console.log(`Staff pages open only from: ${describeStaffNetworks()}`);
  if (!isUnlocked()) console.log(`LOCKED: open ${process.env.APP_URL ?? `http://localhost:${PORT}`}/unlock from the college network and enter the unlock passphrase.`);
  else if (keyFileExists() && keyFromEnv()) console.warn('Note: MASTER_KEY is in .env as well as data/master-key.json. Remove it from .env to require unlocking.');
});
