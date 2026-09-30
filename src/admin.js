// College staff area: review queue, student list, and verify/reject decisions.
// Staff accounts are created only from the terminal (npm run create-admin); there is no public sign-up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { db, FILES_DIR } from './db.js';
import { hashPassword, verifyPassword, DUMMY_HASH, decryptFile, safeEqual, randomResetCode, hashResetCode } from './security.js';
import { DOC_TYPES, UPLOADABLE_TYPES, LOCK_AFTER_FAILS, LOCK_MINUTES } from './config.js';
import { buildChecklist } from './checklist.js';
import { sendReviewEmail, sendMissingDocsReminder, sendStaffLoginCode } from './mailer.js';
import * as adminViews from './adminViews.js';
import { errorPage } from './views.js';
import { isStaffNetwork } from './network.js';

const STATUS_FILTERS = ['pending', 'verified', 'rejected', 'all'];
const docLabel = (doc) => DOC_TYPES[doc.doc_type] ?? doc.doc_type;
// Admin events go in the same audit table, keyed so they never show up in a student's activity list.
const adminKey = (admin) => `admin:${admin.id}`;

const STAFF_TWO_STEP = process.env.STAFF_TWO_STEP !== 'false'; // email code after the password
const STRONG_STAFF_PASSWORD = 12;
const LOGIN_CODE_MINUTES = 10;

export function mountAdmin(app, { audit, checkCsrf, authLimiter, regenerateSession }) {
  // Every staff page, including the login page, only opens from the college network.
  // A leaked staff password is then useless from outside the college.
  app.use('/admin', (req, res, next) => {
    if (isStaffNetwork(req.ip)) return next();
    console.warn(`Blocked staff page ${req.method} ${req.originalUrl} from outside the college network: ${req.ip}`);
    res.status(403).send(errorPage({ csrf: req.session.csrf, status: 403, message: 'Staff pages can only be opened from the college network.' }));
  });

  const render = (req, res, view, data = {}, status = 200) =>
    res.status(status).send(adminViews[view]({ csrf: req.session.csrf, admin: req.admin, ...data }));

  // Staff who logged in with a short password can only reach the page where they change it.
  const requireAdmin = (req, res, next) => {
    if (!req.admin) return res.redirect('/admin/login');
    const allowed = req.path === '/admin/account' || req.path === '/admin/password';
    if (req.session.adminMustChange && !allowed) {
      return res.redirect('/admin/account#password'); // the Account page explains why
    }
    next();
  };

  const flash = (req, res, type, msg, to = '/admin') => {
    req.session.adminFlash = { type, msg };
    res.redirect(to);
  };
  const takeFlash = (req) => {
    const f = req.session.adminFlash;
    delete req.session.adminFlash;
    return f;
  };

  const findDoc = (id) =>
    db.prepare(
      `SELECT d.*, s.name AS student_name, s.email AS student_email
       FROM documents d JOIN students s ON s.id = d.student_id WHERE d.id = ?`,
    ).get(id);

  const staffCount = () => db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  // First-time setup is only offered to someone sitting at the server itself, never over the internet.
  const isLocalRequest = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for');
  const canRunSetup = (req) => staffCount() === 0 && isLocalRequest(req);

  function validateStaff({ name, email, password, confirm }) {
    const errors = [];
    if (name !== undefined && (name.length < 2 || name.length > 100)) errors.push('Enter a name between 2 and 100 characters.');
    if (email !== undefined && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.push('Enter a valid email address.');
    if (password.length < 12 || password.length > 128) errors.push(`Password must be 12 to 128 characters (you typed ${password.length}).`);
    else if (password !== confirm) errors.push('The two passwords do not match.');
    return errors;
  }
  const readStaffForm = (body) => ({
    name: String(body.name ?? '').trim(),
    email: String(body.email ?? '').trim().toLowerCase(),
    password: String(body.password ?? ''),
    confirm: String(body.confirm ?? ''),
  });

  // ---------- first staff account (setup) ----------

  app.get('/admin/setup', (req, res) => (canRunSetup(req) ? render(req, res, 'adminSetup') : res.redirect('/admin/login')));

  app.post('/admin/setup', authLimiter, checkCsrf, async (req, res) => {
    if (!canRunSetup(req)) return res.redirect('/admin/login');
    const form = readStaffForm(req.body);
    const errors = validateStaff(form);
    if (errors.length) return render(req, res, 'adminSetup', { errors, values: form }, 400);

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, form.name, form.email, await hashPassword(form.password), Date.now());
    await regenerateSession(req);
    req.session.adminId = id;
    req.session.adminSessionVersion = 0;
    audit(req, `admin:${id}`, 'staff_setup');
    req.session.adminFlash = { type: 'success', msg: `Welcome, ${form.name}. Your staff account is ready. Add colleagues from the Staff page.` };
    res.redirect('/admin/students');
  });

  // ---------- login / logout ----------

  app.get('/admin/login', (req, res) => {
    if (req.admin) return res.redirect('/admin/students');
    if (canRunSetup(req)) return res.redirect('/admin/setup');
    render(req, res, 'adminLogin');
  });

  app.post('/admin/login', authLimiter, checkCsrf, async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase().slice(0, 200);
    const password = String(req.body.password ?? '').slice(0, 128);
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
    const now = Date.now();
    const fail = (msg, status = 401) => render(req, res, 'adminLogin', { errors: [msg], values: { email } }, status);

    if (admin?.locked_until > now) {
      const mins = Math.ceil((admin.locked_until - now) / 60000);
      return fail(`Too many failed attempts. This staff account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`, 429);
    }

    const ok = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !ok) {
      if (admin) {
        const fails = admin.failed_attempts + 1;
        if (fails >= LOCK_AFTER_FAILS) {
          db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = ? WHERE id = ?')
            .run(now + LOCK_MINUTES * 60 * 1000, admin.id);
          audit(req, adminKey(admin), 'locked');
        } else {
          db.prepare('UPDATE admins SET failed_attempts = ? WHERE id = ?').run(fails, admin.id);
          audit(req, adminKey(admin), 'login_failed');
        }
      }
      return fail('Incorrect email or password.');
    }

    db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id);
    const weak = password.length < STRONG_STAFF_PASSWORD;
    if (!STAFF_TWO_STEP) return finishAdminLogin(req, res, admin, weak);

    // Step 2: a one-time code to the staff member's email. The password alone is not enough.
    const code = randomResetCode();
    db.prepare('UPDATE admin_login_codes SET used = 1 WHERE admin_id = ? AND used = 0').run(admin.id);
    db.prepare('INSERT INTO admin_login_codes (admin_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(admin.id, hashResetCode(adminKey(admin), code), now + LOGIN_CODE_MINUTES * 60 * 1000, now);
    sendStaffLoginCode({ ...admin, code });
    await regenerateSession(req);
    req.session.pendingAdmin = { id: admin.id, weak, at: now };
    audit(req, adminKey(admin), 'login_code_sent');
    res.redirect('/admin/verify');
  });

  async function finishAdminLogin(req, res, admin, weak) {
    await regenerateSession(req);
    req.session.adminId = admin.id;
    req.session.adminSessionVersion = admin.session_version;
    if (weak) req.session.adminMustChange = true;
    audit(req, adminKey(admin), 'login');
    res.redirect(weak ? '/admin/account#password' : '/admin/students');
  }

  const pendingAdmin = (req) => {
    const p = req.session.pendingAdmin;
    return p && Date.now() - p.at < LOGIN_CODE_MINUTES * 60 * 1000 ? p : null;
  };
  const maskEmail = (email) => email.replace(/^(.{2})[^@]*(@.*)$/, '$1•••$2');

  app.get('/admin/verify', (req, res) => {
    const pending = pendingAdmin(req);
    if (!pending) return res.redirect('/admin/login');
    const admin = db.prepare('SELECT email FROM admins WHERE id = ?').get(pending.id);
    render(req, res, 'adminVerify', { email: maskEmail(admin?.email ?? '') });
  });

  app.post('/admin/verify', authLimiter, checkCsrf, async (req, res) => {
    const pending = pendingAdmin(req);
    if (!pending) return res.redirect('/admin/login');
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(pending.id);
    const code = String(req.body.code ?? '').replace(/\s/g, '');
    const row = admin && db.prepare(
      'SELECT * FROM admin_login_codes WHERE admin_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1',
    ).get(admin.id, Date.now());

    if (!row || !/^\d{6}$/.test(code) || !safeEqual(hashResetCode(adminKey(admin), code), row.code_hash)) {
      if (row) {
        const attempts = row.attempts + 1;
        db.prepare('UPDATE admin_login_codes SET attempts = ?, used = ? WHERE id = ?').run(attempts, attempts >= 5 ? 1 : 0, row.id);
        audit(req, adminKey(admin), 'login_code_wrong');
      }
      return render(req, res, 'adminVerify', {
        email: maskEmail(admin?.email ?? ''), errors: ['That code is wrong or has expired. After 5 wrong tries, log in again for a new code.'],
      }, 401);
    }
    db.prepare('UPDATE admin_login_codes SET used = 1 WHERE admin_id = ?').run(admin.id);
    await finishAdminLogin(req, res, admin, pending.weak);
  });

  app.post('/admin/logout', checkCsrf, (req, res) => {
    if (req.admin) audit(req, adminKey(req.admin), 'logout');
    req.session.destroy(() => {
      res.clearCookie('dv.sid');
      res.redirect('/admin/login');
    });
  });

  // ---------- staff management ----------

  const listStaff = () => db.prepare('SELECT id, name, email, created_at FROM admins ORDER BY created_at').all();
  const renderStaff = (req, res, data = {}, status = 200) =>
    render(req, res, 'adminStaff', { staff: listStaff(), flash: takeFlash(req), ...data }, status);

  app.get('/admin/staff', requireAdmin, (req, res) => renderStaff(req, res));

  app.post('/admin/staff', requireAdmin, checkCsrf, async (req, res) => {
    const form = readStaffForm(req.body);
    const errors = validateStaff(form);
    if (!errors.length && db.prepare('SELECT 1 FROM admins WHERE email = ?').get(form.email)) {
      errors.push('A staff account with this email already exists.');
    }
    if (errors.length) return renderStaff(req, res, { addErrors: errors, values: form }, 400);

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, form.name, form.email, await hashPassword(form.password), Date.now());
    audit(req, adminKey(req.admin), 'staff_added', form.email);
    flash(req, res, 'success', `Staff account created for ${form.name}. Give them the password in person, not by email.`, '/admin/staff');
  });

  app.post('/admin/staff/:id/delete', requireAdmin, checkCsrf, (req, res) => {
    if (req.params.id === req.admin.id) return flash(req, res, 'error', "You can't remove your own account.", '/admin/staff');
    const target = db.prepare('SELECT id, name, email FROM admins WHERE id = ?').get(req.params.id);
    if (!target) return flash(req, res, 'error', 'Staff account not found.', '/admin/staff');
    db.prepare('DELETE FROM admins WHERE id = ?').run(target.id); // their sessions stop working on the next request
    audit(req, adminKey(req.admin), 'staff_removed', target.email);
    flash(req, res, 'success', `${target.name} can no longer log in.`, '/admin/staff');
  });

  const renderAccount = (req, res, data = {}, status = 200) =>
    render(req, res, 'adminAccount', { mustChange: Boolean(req.session.adminMustChange), flash: takeFlash(req), ...data }, status);

  app.get('/admin/account', requireAdmin, (req, res) => renderAccount(req, res));

  app.post('/admin/account/details', requireAdmin, authLimiter, checkCsrf, async (req, res) => {
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    const name = String(req.body.name ?? '').trim();
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const errors = validateStaff({ name, email, password: 'x'.repeat(STRONG_STAFF_PASSWORD), confirm: 'x'.repeat(STRONG_STAFF_PASSWORD) });
    const emailChanged = email !== me.email;
    if (!errors.length && emailChanged) {
      // Changing the login email needs the password, so an unattended logged-in screen can't take over the account.
      if (!(await verifyPassword(String(req.body.current ?? '').slice(0, 128), me.password_hash))) errors.push('Enter your current password to change your email.');
      else if (db.prepare('SELECT 1 FROM admins WHERE email = ? AND id != ?').get(email, me.id)) errors.push('Another staff account already uses that email.');
    }
    if (errors.length) return renderAccount(req, res, { detailErrors: errors, values: { name, email } }, 400);
    db.prepare('UPDATE admins SET name = ?, email = ? WHERE id = ?').run(name, email, me.id);
    audit(req, adminKey(me), 'account_updated', emailChanged ? `email ${me.email} -> ${email}` : 'name');
    flash(req, res, 'success', 'Your account details have been saved.', '/admin/account');
  });

  app.post('/admin/password', requireAdmin, authLimiter, checkCsrf, async (req, res) => {
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    const current = String(req.body.current ?? '').slice(0, 128);
    const form = readStaffForm(req.body);
    if (!(await verifyPassword(current, me.password_hash))) {
      audit(req, adminKey(me), 'password_change_failed');
      return renderAccount(req, res, { errors: ['Your current password is incorrect.'] }, 401);
    }
    const errors = validateStaff({ password: form.password, confirm: form.confirm });
    if (errors.length) return renderAccount(req, res, { errors }, 400);

    const version = me.session_version + 1;
    db.prepare('UPDATE admins SET password_hash = ?, session_version = ? WHERE id = ?').run(await hashPassword(form.password), version, me.id);
    await regenerateSession(req);
    req.session.adminId = me.id;
    req.session.adminSessionVersion = version;
    audit(req, adminKey(me), 'password_changed');
    flash(req, res, 'success', 'Your password has been changed. Other devices were logged out.', '/admin/account');
  });

  // ---------- review queue ----------

  app.get('/admin', requireAdmin, (req, res) => {
    const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : 'pending';
    const q = String(req.query.q ?? '').trim().slice(0, 100);

    const where = [];
    const params = [];
    if (status !== 'all') {
      where.push('d.status = ?');
      params.push(status);
    }
    if (q) {
      where.push('(s.id LIKE ? OR s.name LIKE ? OR s.email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    // Pending: AI-flagged documents first (problems, then "needs a look"), then oldest first.
    const order = status === 'pending'
      ? "CASE d.ai_verdict WHEN 'fail' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, d.uploaded_at ASC"
      : 'd.uploaded_at DESC';
    const docs = db.prepare(
      `SELECT d.id, d.doc_type, d.original_name, d.size, d.uploaded_at, d.status, d.reviewed_by, d.reviewed_at,
              d.ai_status, d.ai_verdict, d.ai_summary, s.id AS student_id, s.name AS student_name
       FROM documents d JOIN students s ON s.id = d.student_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${order}
       LIMIT 200`,
    ).all(...params);
    const aiPassedCount = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending' AND ai_verdict = 'ok'").get().n;

    // Tab counts follow the search box, so "Pending 3" means 3 matching documents.
    const counts = { pending: 0, verified: 0, rejected: 0 };
    const countRows = db.prepare(
      `SELECT d.status, COUNT(*) AS n FROM documents d JOIN students s ON s.id = d.student_id
       ${q ? 'WHERE s.id LIKE ? OR s.name LIKE ? OR s.email LIKE ?' : ''} GROUP BY d.status`,
    ).all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
    for (const r of countRows) counts[r.status] = r.n;
    counts.all = counts.pending + counts.verified + counts.rejected;
    const studentCount = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;

    render(req, res, 'adminQueue', { docs, status, q, counts, studentCount, aiPassedCount, flash: takeFlash(req) });
  });

  // ---------- bulk verify what the AI already passed ----------

  const aiPassedPending = () => db.prepare(
    `SELECT d.*, s.name AS student_name, s.email AS student_email FROM documents d JOIN students s ON s.id = d.student_id
     WHERE d.status = 'pending' AND d.ai_verdict = 'ok' ORDER BY d.uploaded_at`,
  ).all();

  app.get('/admin/bulk-verify', requireAdmin, (req, res) => {
    const docs = aiPassedPending();
    if (!docs.length) return flash(req, res, 'error', 'No AI-passed documents are waiting.');
    render(req, res, 'adminBulkVerify', { docs });
  });

  app.post('/admin/bulk-verify', requireAdmin, checkCsrf, (req, res) => {
    // Only the documents the staff member saw on the confirmation page, and only if still AI-passed and pending.
    const shown = new Set(String(req.body.ids ?? '').split(',').filter(Boolean));
    const docs = aiPassedPending().filter((d) => shown.has(d.id));
    const mark = db.prepare("UPDATE documents SET status = 'verified', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'");
    const note = 'Checked by AI and confirmed by college staff';
    for (const doc of docs) {
      mark.run(note, req.admin.name, Date.now(), doc.id);
      audit(req, doc.student_id, 'verified', `${docLabel(doc)} (by ${req.admin.name}, bulk)`);
      sendReviewEmail({ email: doc.student_email, name: doc.student_name, docLabel: docLabel(doc), decision: 'verified', note: '' });
    }
    audit(req, adminKey(req.admin), 'bulk_verified', `${docs.length} documents`);
    flash(req, res, 'success', `${docs.length} document${docs.length === 1 ? '' : 's'} marked Verified.`);
  });

  // ---------- students ----------

  const REQUIRED_KEYS = UPLOADABLE_TYPES.filter((t) => t.required).map((t) => t.key);

  app.get('/admin/students', requireAdmin, (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const missingOnly = req.query.missing === '1';
    const like = `%${q}%`;
    const inRequired = REQUIRED_KEYS.map(() => '?').join(', ');
    const students = db.prepare(
      `SELECT s.id, s.name, s.email, s.created_at,
              COUNT(d.id) AS total,
              COALESCE(SUM(d.status = 'verified'), 0) AS verified,
              COALESCE(SUM(d.status = 'pending'), 0) AS pending,
              COALESCE(SUM(d.status = 'rejected'), 0) AS rejected,
              COUNT(DISTINCT CASE WHEN d.doc_type IN (${inRequired}) THEN d.doc_type END) AS required_done,
              MAX(d.uploaded_at) AS last_upload
       FROM students s LEFT JOIN documents d ON d.student_id = s.id
       ${q ? 'WHERE s.id LIKE ? OR s.name LIKE ? OR s.email LIKE ?' : ''}
       GROUP BY s.id
       ${missingOnly ? 'HAVING required_done < ?' : ''}
       ORDER BY COALESCE(MAX(d.uploaded_at), s.created_at) DESC LIMIT 500`,
    ).all(...REQUIRED_KEYS, ...(q ? [like, like, like] : []), ...(missingOnly ? [REQUIRED_KEYS.length] : []));
    render(req, res, 'adminStudents', { students, q, missingOnly, requiredTotal: REQUIRED_KEYS.length, flash: takeFlash(req) });
  });

  app.post('/admin/students/:id/remind', requireAdmin, checkCsrf, (req, res) => {
    const student = db.prepare('SELECT id, name, email FROM students WHERE id = ?').get(req.params.id);
    if (!student) return flash(req, res, 'error', 'Student not found.', '/admin/students');
    const back = `/admin/students/${student.id}`;
    const docs = db.prepare('SELECT doc_type, status, ai_verdict FROM documents WHERE student_id = ?').all(student.id);
    const missing = buildChecklist(docs).missingRequired.map((i) => i.label);
    if (!missing.length) return flash(req, res, 'error', 'This student has uploaded every required document.', back);
    // At most one reminder per student per hour, so a double click doesn't spam them.
    const recent = db.prepare("SELECT 1 FROM audit_log WHERE student_id = ? AND action = 'reminder_sent' AND at > ?")
      .get(student.id, Date.now() - 60 * 60 * 1000);
    if (recent) return flash(req, res, 'error', 'A reminder was already sent to this student in the last hour.', back);
    sendMissingDocsReminder({ ...student, missing });
    audit(req, student.id, 'reminder_sent', `${missing.join(', ')} (by ${req.admin.name})`);
    flash(req, res, 'success', `Reminder emailed to ${student.name} about: ${missing.join(', ')}.`, back);
  });

  app.get('/admin/students/:id', requireAdmin, (req, res) => {
    const student = db.prepare('SELECT id, name, email, created_at FROM students WHERE id = ?').get(req.params.id);
    if (!student) return flash(req, res, 'error', 'Student not found.', '/admin/students');
    const docs = db.prepare(
      'SELECT id, doc_type, original_name, size, uploaded_at, status, review_note, reviewed_by, reviewed_at, ai_status, ai_verdict, ai_summary FROM documents WHERE student_id = ? ORDER BY uploaded_at DESC',
    ).all(student.id);
    render(req, res, 'adminStudent', { student, docs, flash: takeFlash(req) });
  });

  // ---------- review one document ----------

  app.get('/admin/documents/:id', requireAdmin, (req, res) => {
    const doc = findDoc(req.params.id);
    if (!doc) return flash(req, res, 'error', 'Document not found. The student may have deleted it.');
    const pendingLeft = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'").get().n;
    render(req, res, 'adminReview', { doc, pendingLeft, flash: takeFlash(req) });
  });

  // Opens the decrypted file in the browser so staff can check it. The student sees this in their activity log.
  app.get('/admin/documents/:id/file', requireAdmin, (req, res) => {
    const doc = findDoc(req.params.id);
    if (!doc) return flash(req, res, 'error', 'Document not found.');
    let plain;
    try {
      plain = decryptFile(fs.readFileSync(path.join(FILES_DIR, `${doc.id}.enc`)), { iv: doc.iv, tag: doc.auth_tag, docId: doc.id });
    } catch (err) {
      console.error(`Admin decrypt failed for ${doc.id}:`, err.message);
      return flash(req, res, 'error', 'This file failed its integrity check and could not be opened.', `/admin/documents/${doc.id}`);
    }
    audit(req, doc.student_id, 'viewed_by_college', `${docLabel(doc)} (by ${req.admin.name})`);
    // original_name was sanitised on upload to letters, digits, space, _ and -, so it is safe inside quotes.
    res.set('Content-Disposition', `inline; filename="${doc.original_name}"`).type(doc.mime_type).send(plain);
  });

  app.post('/admin/documents/:id/review', requireAdmin, checkCsrf, (req, res) => {
    const doc = findDoc(req.params.id);
    if (!doc) return flash(req, res, 'error', 'Document not found. The student may have deleted it.');

    const decision = String(req.body.decision ?? '');
    const note = String(req.body.note ?? '').trim().slice(0, 300);
    if (!['verified', 'rejected'].includes(decision)) return flash(req, res, 'error', 'Choose Verify or Reject.', `/admin/documents/${doc.id}`);
    if (decision === 'rejected' && !note) {
      const pendingLeft = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'").get().n;
      return render(req, res, 'adminReview', {
        doc, pendingLeft, errors: ['Please give a reason for rejecting, so the student knows what to fix.'],
      }, 400);
    }

    db.prepare('UPDATE documents SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .run(decision, note || null, req.admin.name, Date.now(), doc.id);
    audit(req, doc.student_id, decision, `${docLabel(doc)}${note ? `: "${note}"` : ''} (by ${req.admin.name})`);
    audit(req, adminKey(req.admin), `review_${decision}`, `${doc.student_id} ${docLabel(doc)}`);
    sendReviewEmail({ email: doc.student_email, name: doc.student_name, docLabel: docLabel(doc), decision, note });

    // Straight on to the next document waiting for review, oldest first.
    const next = db.prepare("SELECT id FROM documents WHERE status = 'pending' ORDER BY uploaded_at LIMIT 1").get();
    const msg = `${docLabel(doc)} for ${doc.student_name} marked ${decision === 'verified' ? 'Verified' : 'Rejected'}.`;
    flash(req, res, 'success', next ? msg : `${msg} No more documents waiting for review.`, next ? `/admin/documents/${next.id}` : '/admin');
  });
}
