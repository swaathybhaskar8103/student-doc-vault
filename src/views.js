import { DOC_TYPES, documentLabel, UPLOADABLE_TYPES, MAX_DOCS_PER_STUDENT, canReplace, DEPARTMENTS, deptLabel } from './config.js';
import { buildChecklist } from './checklist.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const fmtTime = (ms) =>
  new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
export const errorBox = (errors) =>
  errors?.length ? `<div class="alert error">${errors.map((e) => `<p>${esc(e)}</p>`).join('')}</div>` : '';
export const flashBox = (flash) => (flash ? `<div class="alert ${esc(flash.type)}"><p>${esc(flash.msg)}</p></div>` : '');

const ACTIVITY_LABELS = {
  register: 'Account created',
  login: 'Logged in',
  login_failed: 'Failed login attempt',
  locked: 'Account locked after failed attempts',
  upload: 'Uploaded',
  download: 'Downloaded',
  delete: 'Deleted',
  logout: 'Logged out',
  id_reminder: 'Student ID reminder emailed',
  password_changed: 'Password changed',
  password_reset: 'Password reset with email code',
  reset_requested: 'Password reset code emailed',
  reset_code_wrong: 'Wrong password reset code entered',
  password_change_failed: 'Failed password change (wrong current password)',
  delete_account_failed: 'Failed attempt to delete account (wrong password)',
  viewed_by_college: 'Opened by college staff',
  verified: 'Verified by college',
  rejected: 'Rejected by college',
  reupload: 'Uploaded a new copy for review',
  ai_verified: 'Verified automatically',
  ai_rejected: 'Not accepted by the automatic check',
  reminder_sent: 'College sent a reminder about missing documents',
  department_set: 'Department set',
  department_changed: 'Department changed by the college office',
};

const STATUS_LABELS = { pending: 'Pending review', verified: 'Verified', rejected: 'Rejected' };
// Staff see "AI: …"; students just see the check's result, without mentioning AI.
const CHECK_LABELS = {
  staff: { checking: 'AI checking…', error: 'AI could not check', ok: 'AI: looks good', warn: 'AI: needs a look', fail: 'AI: problem found' },
  student: { checking: 'Checking…', error: 'Could not check', ok: 'Looks good', warn: 'Needs a look', fail: 'Problem found' },
};
export function aiBadge(doc, { forStudent = false } = {}) {
  if (!doc.ai_status) return '';
  const labels = CHECK_LABELS[forStudent ? 'student' : 'staff'];
  if (doc.ai_status === 'queued' || doc.ai_status === 'checking') return `<span class="ai-badge checking">${labels.checking}</span>`;
  if (doc.ai_status === 'error') return `<span class="ai-badge error">${labels.error}</span>`;
  return `<span class="ai-badge ${esc(doc.ai_verdict)}">${esc(labels[doc.ai_verdict] ?? doc.ai_verdict)}</span>`;
}

// Small inline SVG status icons (no emoji, no external files). Colours come from CSS.
const ICON_SVG = {
  verified: '<circle cx="8" cy="8" r="8"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  pending: '<circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6V8l2.3 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  attention: '<circle cx="8" cy="8" r="8"/><path d="M8 4.2v4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.6" r="1.1" fill="#fff"/>',
  missing: '<circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2.2"/>',
};
const statusIcon = (state) => `<svg class="st-icon ${state}" viewBox="0 0 16 16" aria-hidden="true">${ICON_SVG[state]}</svg>`;

const CHECK_STATES = {
  verified: [statusIcon('verified'), 'Verified'],
  pending: [statusIcon('pending'), 'Waiting for review'],
  attention: [statusIcon('attention'), 'Needs fixing'],
  missing: [statusIcon('missing'), 'Not uploaded'],
};

export function checklistPanel(docs, { forStaff = false } = {}) {
  const cl = buildChecklist(docs);
  const row = (i) => `<li class="cl-item ${i.state}"><span class="cl-icon" aria-hidden="true">${CHECK_STATES[i.state][0]}</span>
      <span class="cl-label">${esc(i.label)}</span><span class="cl-state">${CHECK_STATES[i.state][1]}</span></li>`;
  const chip = (i, n) => `<span class="chip ${i.state}" title="${esc(i.label)}: ${CHECK_STATES[i.state][1]}">${CHECK_STATES[i.state][0]} Sem ${n}</span>`;
  const achievements = cl.achievements.reduce((n, i) => n + i.docs.length, 0);
  const complete = !cl.missingRequired.length;
  return `<section class="card checklist">
    <h2>${forStaff ? 'Document checklist' : 'Your document checklist'}</h2>
    <progress max="${cl.requiredTotal}" value="${cl.requiredDone}" aria-label="Required documents uploaded"></progress>
    <p><strong>${cl.requiredDone} of ${cl.requiredTotal}</strong> required documents uploaded${complete ? '. All done.' : `. Missing: ${cl.missingRequired.map((i) => esc(i.label)).join(', ')}`}</p>
    <div class="cl-columns">
      <div><h3>Required</h3><ul class="cl-list">${cl.required.map(row).join('')}</ul></div>
      <div><h3>If applicable</h3><ul class="cl-list">${cl.ifApplicable.map(row).join('')}</ul>
        <h3>Other certificates</h3>
        <p class="cl-count">${achievements ? `${achievements} uploaded: ${cl.achievements.flatMap((i) => i.docs).map((d) => esc(d.title || 'untitled')).join(', ')}` : `None yet${forStaff ? '' : '. Add as many as you like (hackathons, courses, sports…).'}`}</p></div>
    </div>
    <h3>Semester results</h3>
    <div class="chips">${cl.semesters.map((i, n) => chip(i, n + 1)).join('')}</div>
    <p class="hint">${forStaff ? '' : 'Upload each semester result once it is published.'}</p>
    <ul class="cl-legend">${Object.entries(CHECK_STATES).map(([, [icon, text]]) => `<li>${icon}${text}</li>`).join('')}</ul>
  </section>`;
}

export const statusBadge = (status) =>
  `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] ?? status)}</span>`;

export function layout({ title, csrf, student, admin, refreshSeconds }, body) {
  // Account menu in the top-right corner: a <details> dropdown, so it needs no JavaScript.
  const menu = (title, subtitle, items, logoutAction) => `<details class="menu">
      <summary><span class="menu-avatar" aria-hidden="true">${esc(title.trim().charAt(0).toUpperCase())}</span><span class="menu-name">${esc(title)}</span></summary>
      <div class="menu-panel">
        <div class="menu-head"><strong>${esc(title)}</strong><span>${subtitle}</span></div>
        ${items.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
        <form method="post" action="${logoutAction}">${csrfField(csrf)}<button class="menu-logout">Log out</button></form>
      </div>
    </details>`;
  const nav = admin
    ? `<nav>
         <a href="/admin/students">Students</a>
         <a href="/admin">Review queue</a>
         ${admin.department === 'ALL' ? '<a href="/admin/staff">Staff</a>' : ''}
         ${menu(admin.name, `${esc(deptLabel(admin.department))} · ${esc(admin.email)}`, [
           ['/admin/account#details', 'Account details'],
           ['/admin/account#password', 'Change password'],
         ], '/admin/logout')}
       </nav>`
    : student
    ? `<nav>
         <a href="/dashboard">My documents</a>
         ${menu(student.name, `Student ID <code>${esc(student.id)}</code>${student.department ? ` · ${esc(student.department)}` : ''}`, [
           ['/account/password', 'Change password'],
           ['/account/delete', 'Delete my account'],
         ], '/logout')}
       </nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">${refreshSeconds ? `\n  <meta http-equiv="refresh" content="${Number(refreshSeconds)}">` : ''}
  <title>${esc(title)} · DocVault</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="top"><a class="brand" href="${admin ? '/admin/students' : '/'}"><span class="lock">●</span> DocVault</a>${nav}</header>
  <main>${body}</main>
  <footer>Documents are encrypted before they're saved. Always log out on shared computers.</footer>
</body>
</html>`;
}

export const home = (ctx) =>
  layout(
    { ...ctx, title: 'Welcome' },
    `<section class="hero">
      <h1>Your certificates, one login away.</h1>
      <p>Upload your mark sheets, TC and ID documents once. Download a soft copy whenever you need one,
         with no trip to the office to borrow the originals for a photocopy.</p>
      <div class="actions">
        <a class="btn" href="/register">Create account</a>
        <a class="btn secondary" href="/login">Log in</a>
      </div>
    </section>
    <section class="features">
      <div><h3>Encrypted storage</h3><p>Every file is encrypted with AES-256 before it touches the disk.</p></div>
      <div><h3>Only you can open them</h3><p>Downloads need your Student ID <em>and</em> password. Nobody else can see your files.</p></div>
      <div><h3>See every access</h3><p>Your activity log shows each login, upload and download, so you'd notice misuse.</p></div>
    </section>`,
  );

export const departmentOptions = (selected, { includeAll = false } = {}) =>
  `${includeAll ? `<option value="ALL"${selected === 'ALL' ? ' selected' : ''}>Admin: all departments (Office / Principal)</option>` : ''}${
    DEPARTMENTS.map((d) => `<option value="${esc(d.key)}"${d.key === selected ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}`;

export const register = ({ errors, values = {}, ...ctx }) =>
  layout(
    { ...ctx, title: 'Create account' },
    `<div class="card narrow">
      <h1>Create account</h1>
      ${errorBox(errors)}
      <form method="post" action="/register">
        ${csrfField(ctx.csrf)}
        <label>Full name <input name="name" required maxlength="100" autocomplete="name" value="${esc(values.name)}"></label>
        <label>Email <input type="email" name="email" required maxlength="200" autocomplete="email" value="${esc(values.email)}"></label>
        <label>Department <select name="department" required><option value="" ${values.department ? '' : 'selected'} disabled>Choose your department…</option>${departmentOptions(values.department)}</select></label>
        <label>Password <input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm password <input type="password" name="confirm" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <p class="hint">At least 8 characters. Don't reuse your email or social media password.</p>
        <button class="btn">Create account</button>
      </form>
      <p class="muted">Already registered? <a href="/login">Log in</a></p>
    </div>`,
  );

export const login = ({ errors, values = {}, ...ctx }) =>
  layout(
    { ...ctx, title: 'Log in' },
    `<div class="card narrow">
      <h1>Log in</h1>
      ${errorBox(errors)}
      <form method="post" action="/login">
        ${csrfField(ctx.csrf)}
        <label>Student ID or email <input name="login" required maxlength="200" placeholder="STU-XXXX-XXXX or you@gmail.com" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(values.login)}"></label>
        <label>Password <input type="password" name="password" required maxlength="128" autocomplete="current-password"></label>
        <button class="btn">Log in</button>
      </form>
      <p class="muted"><a href="/forgot-password">Forgot password?</a> · <a href="/forgot-id">Forgot Student ID?</a></p>
      <p class="muted small-print">College staff? <a href="/admin/login">Staff login</a></p>
      <p class="muted">New here? <a href="/register">Create an account</a></p>
    </div>`,
  );

export const welcome = ({ newId, email, ...ctx }) =>
  layout(
    { ...ctx, title: 'Your Student ID' },
    `<div class="card narrow center">
      <h1>Account created</h1>
      <p>This is your Student ID. Log in with it (or your email) and your password.</p>
      <div class="student-id">${esc(newId)}</div>
      <p class="hint">We've also emailed it to <strong>${esc(email)}</strong>. Not in your inbox? Check your
        <strong>Spam</strong> folder and mark it "Not spam". If you forget your ID,
        use "Forgot your Student ID?" on the login page.</p>
      <a class="btn" href="/dashboard">Go to my documents</a>
    </div>`,
  );

// Where an action came from, in words instead of a raw IP address.
const WHERE = { '::1': 'this computer', '127.0.0.1': 'this computer', '::ffff:127.0.0.1': 'this computer', server: 'automatic' };
const whereFrom = (ip) => WHERE[ip] ?? ip;

export const dashboard = ({ docs, activity, flash, aiEnabled, aiAuto, ...ctx }) => {
  const rejected = docs.filter(canReplace);
  const checking = docs.some((d) => d.ai_status === 'queued' || d.ai_status === 'checking');
  const problemNote = (d) => (d.status === 'rejected' ? d.review_note : d.ai_summary);
  const rows = docs.length
    ? docs
        .map(
          (d) => `<tr>
            <td data-label="Type">${esc(documentLabel(d))}</td>
            <td data-label="File" class="filename">${esc(d.original_name)}</td>
            <td data-label="Size">${fmtSize(d.size)}</td>
            <td data-label="Uploaded">${fmtTime(d.uploaded_at)}</td>
            <td data-label="Status">${statusBadge(d.status)}${d.status === 'pending' ? aiBadge(d, { forStudent: true }) : ''}${
              canReplace(d) && problemNote(d) ? `<div class="review-note">${d.status === 'rejected' ? 'Reason' : 'Check'}: ${esc(problemNote(d))}</div>` : ''
            }</td>
            <td class="row-actions">
              ${canReplace(d) ? `<a class="btn small warn-btn" href="/documents/${esc(d.id)}/replace">Upload new copy</a>` : ''}
              <a class="btn small" href="/documents/${esc(d.id)}/download">Download</a>
              <a class="btn small danger" href="/documents/${esc(d.id)}/delete">Delete</a>
            </td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="empty">No documents yet. Upload your first one below.</td></tr>`;

  const uploaded = new Set(docs.map((d) => d.doc_type));
  const typeOptions = UPLOADABLE_TYPES
    .map((t) => (!t.multiple && uploaded.has(t.key)
      ? `<option value="${t.key}" disabled>${esc(t.label)} (uploaded)</option>`
      : `<option value="${t.key}">${esc(t.label)}</option>`))
    .join('');

  const log = activity
    .map(
      (a) => `<li class="${['login_failed', 'locked', 'password_change_failed', 'reset_code_wrong', 'rejected', 'ai_rejected', 'delete_account_failed'].includes(a.action) ? 'warn' : ''}">
        <span>${esc(ACTIVITY_LABELS[a.action] ?? a.action)}${a.detail ? `: ${esc(a.detail)}` : ''}</span>
        <time>${fmtTime(a.at)} · ${esc(whereFrom(a.ip))}</time>
      </li>`,
    )
    .join('');

  return layout(
    { ...ctx, title: 'My documents', refreshSeconds: checking ? 8 : 0 },
    `${flashBox(flash)}
    ${rejected.length ? `<div class="alert error attention">
      <p><strong>${rejected.length} document${rejected.length === 1 ? ' needs' : 's need'} your attention.</strong>
        Please fix:</p>
      <ul>${rejected.map((d) => `<li><strong>${esc(documentLabel(d))}</strong>${problemNote(d) ? `: ${esc(problemNote(d))}` : ''}
        · <a href="/documents/${esc(d.id)}/replace">Upload new copy</a></li>`).join('')}</ul>
    </div>` : ''}
    ${checklistPanel(docs)}
    <section class="card">
      <h1>My documents <span class="count">${docs.length}/${MAX_DOCS_PER_STUDENT}</span></h1>
      <table class="docs">
        <thead><tr><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${docs.length ? `<div class="done-row"><a class="btn" href="/done">Done uploading ✓</a></div>` : ''}
    </section>

    <section class="card">
      <h2>Upload a document</h2>
      <form method="post" action="/documents" enctype="multipart/form-data" class="upload">
        ${csrfField(ctx.csrf)}
        <label>Document type <select name="doc_type" required><option value="" selected disabled>Choose type…</option>${typeOptions}</select></label>
        <label class="title-field">Certificate name
          <input name="title" maxlength="80" placeholder="e.g. Hackathon winner 2025"></label>
        <label>File <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></label>
        <button class="btn">Upload securely</button>
      </form>
      <p class="hint">Have more certificates (hackathons, courses, sports, NSS…)? Choose <strong>Other certificate</strong>,
        type its name, and upload. Repeat for each one.</p>
      <p class="hint">PDF, JPG or PNG, up to 5 MB. Scan or photograph the whole document so every detail is clear.</p>
      ${aiEnabled ? `<p class="hint">After upload, DocVault checks that the file is readable, is the type you chose,
        and shows your name. Your documents never leave the college. ${aiAuto
          ? 'Documents that pass are verified straight away; if there is a problem you will see why and can upload a new copy.'
          : 'College staff make the final decision.'}</p>` : ''}
      ${checking ? '<p class="hint"><strong>Checking your document.</strong> This page refreshes by itself.</p>' : ''}
    </section>

    <details class="card activity-card">
      <summary><h2>Recent activity</h2><span class="count">${activity.length}</span></summary>
      <p class="hint">If you see a login or download you don't recognise, <a href="/account/password">change your password</a> and tell the college office.</p>
      <ul class="activity">${log}</ul>
    </details>`,
  );
};

export const done = ({ docs, ...ctx }) =>
  layout(
    { ...ctx, title: 'Thank you' },
    `<div class="card narrow center">
      <div class="tick">✓</div>
      <h1>Thank you for uploading!</h1>
      <p>Your ${docs.length} document${docs.length === 1 ? ' is' : 's are'} encrypted and stored safely.</p>
      <ul class="done-list">
        ${docs.map((d) => `<li>${esc(documentLabel(d))}</li>`).join('')}
      </ul>
      <p>Whenever you need a soft copy, log in with your Student ID (or email) and password.</p>
      <div class="student-id">${esc(ctx.student.id)}</div>
      <div class="actions">
        <form method="post" action="/logout">${csrfField(ctx.csrf)}<button class="btn">Log out</button></form>
        <a class="btn secondary" href="/dashboard">Back to my documents</a>
      </div>
      <p class="hint">Using a shared or college computer? Please log out now.</p>
    </div>`,
  );

export const forgotId = ({ errors, sent, values = {}, ...ctx }) =>
  layout(
    { ...ctx, title: 'Forgot Student ID' },
    sent
      ? `<div class="card narrow center">
          <h1>Check your email</h1>
          <p>If an account exists for <strong>${esc(values.email)}</strong>, we've sent its Student ID there.
             It can take a minute. Not in your inbox? Check your <strong>Spam</strong> folder.</p>
          <a class="btn" href="/login">Back to log in</a>
        </div>`
      : `<div class="card narrow">
          <h1>Forgot Student ID</h1>
          <p class="muted">Enter the email you registered with and we'll send your Student ID to it.</p>
          ${errorBox(errors)}
          <form method="post" action="/forgot-id">
            ${csrfField(ctx.csrf)}
            <label>Email <input type="email" name="email" required maxlength="200" autocomplete="email" value="${esc(values.email)}"></label>
            <button class="btn">Email my Student ID</button>
          </form>
          <p class="muted"><a href="/login">Back to log in</a></p>
        </div>`,
  );

export const changePassword = ({ errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Account' },
    `<div class="card narrow">
      <h1>Change password</h1>
      ${errorBox(errors)}
      <form method="post" action="/account/password">
        ${csrfField(ctx.csrf)}
        <label>Current password <input type="password" name="current" required maxlength="128" autocomplete="current-password"></label>
        <label>New password <input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm new password <input type="password" name="confirm" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <p class="hint">At least 8 characters. Changing it logs out every other device using your account.</p>
        <button class="btn">Change password</button>
      </form>
      <p class="muted"><a href="/dashboard">Back to my documents</a></p>
    </div>
    <div class="card narrow danger-zone">
      <h2>Delete my account</h2>
      <p class="muted">Permanently delete your account and every document you uploaded. This can't be undone.</p>
      <a class="btn small danger" href="/account/delete">Delete my account…</a>
    </div>`,
  );

export const deleteAccount = ({ count, errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Delete account' },
    `<div class="card narrow">
      <h1>Delete your account?</h1>
      <div class="alert error"><p>This permanently deletes your account, your Student ID and
        <strong>all ${count} document${count === 1 ? '' : 's'}</strong> you uploaded, including any the college has verified.
        It can't be undone. Download anything you need first.</p></div>
      ${errorBox(errors)}
      <form method="post" action="/account/delete">
        ${csrfField(ctx.csrf)}
        <label>Your password <input type="password" name="password" required maxlength="128" autocomplete="current-password"></label>
        <label class="check"><input type="checkbox" name="confirm" value="yes" required> I understand that everything will be deleted permanently.</label>
        <div class="actions left">
          <button class="btn danger-solid">Delete everything</button>
          <a class="btn secondary" href="/dashboard">Cancel</a>
        </div>
      </form>
    </div>`,
  );

export const accountDeleted = ({ count, ...ctx }) =>
  layout(
    { ...ctx, title: 'Account deleted' },
    `<div class="card narrow center">
      <h1>Your account has been deleted</h1>
      <p>Your account and ${count} document${count === 1 ? '' : 's'} were permanently removed. A confirmation has been emailed to you.</p>
      <a class="btn secondary" href="/">Back to home</a>
    </div>`,
  );

export const forgotPassword = ({ errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Forgot password' },
    `<div class="card narrow">
      <h1>Forgot password</h1>
      <p class="muted">Enter your Student ID or email. We'll email you a 6-digit code to set a new password.</p>
      ${errorBox(errors)}
      <form method="post" action="/forgot-password">
        ${csrfField(ctx.csrf)}
        <label>Student ID or email <input name="login" required maxlength="200" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <button class="btn">Email me a code</button>
      </form>
      <p class="muted"><a href="/login">Back to log in</a></p>
    </div>`,
  );

export const resetPassword = ({ login, errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Reset password' },
    `<div class="card narrow">
      <h1>Reset password</h1>
      <p class="muted">If an account exists for <strong>${esc(login)}</strong>, we've emailed a 6-digit code to it.
        It expires in 15 minutes. Not in your inbox? Check your <strong>Spam</strong> folder.</p>
      ${errorBox(errors)}
      <form method="post" action="/reset-password">
        ${csrfField(ctx.csrf)}
        <label>6-digit code <input name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" class="code-input"></label>
        <label>New password <input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm new password <input type="password" name="confirm" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <button class="btn">Set new password</button>
      </form>
      <p class="muted">Didn't get it? <a href="/forgot-password">Send a new code</a> (wait a minute first).</p>
    </div>`,
  );

export const confirmDelete = ({ doc, ...ctx }) =>
  layout(
    { ...ctx, title: 'Delete document' },
    `<div class="card narrow">
      <h1>Delete this document?</h1>
      <dl class="doc-summary">
        <dt>Type</dt><dd>${esc(documentLabel(doc))}</dd>
        <dt>File</dt><dd class="filename">${esc(doc.original_name)}</dd>
        <dt>Size</dt><dd>${fmtSize(doc.size)}</dd>
        <dt>Uploaded</dt><dd>${fmtTime(doc.uploaded_at)}</dd>
      </dl>
      <div class="alert error"><p>This permanently deletes the file. It can't be recovered, so make sure you have
        another copy or can upload it again.</p></div>
      <div class="actions left">
        <form method="post" action="/documents/${esc(doc.id)}/delete">
          ${csrfField(ctx.csrf)}<button class="btn danger-solid">Yes, delete it</button>
        </form>
        <a class="btn secondary" href="/dashboard">Cancel</a>
      </div>
    </div>`,
  );

export const replaceDocument = ({ doc, errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Upload new copy' },
    `<div class="card narrow">
      <h1>Upload a new copy</h1>
      <dl class="doc-summary">
        <dt>Document</dt><dd>${esc(documentLabel(doc))}</dd>
        <dt>Current file</dt><dd class="filename">${esc(doc.original_name)}</dd>
        <dt>Status</dt><dd>${statusBadge(doc.status)}</dd>
      </dl>
      ${doc.status === 'rejected' && doc.review_note ? `<div class="alert error"><p><strong>Why it was rejected:</strong> ${esc(doc.review_note)}</p></div>` : ''}
      ${doc.status !== 'rejected' && doc.ai_summary ? `<div class="alert error"><p><strong>What the check found:</strong> ${esc(doc.ai_summary)}</p></div>` : ''}
      ${errorBox(errors)}
      <form method="post" action="/documents/${esc(doc.id)}/replace" enctype="multipart/form-data">
        ${csrfField(ctx.csrf)}
        <label>New file <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></label>
        <p class="hint">PDF, JPG or PNG, up to 5 MB. Make sure it fixes the problem above. The rejected copy is
          replaced and the new one goes back to the college for review.</p>
        <div class="actions left">
          <button class="btn">Upload new copy</button>
          <a class="btn secondary" href="/dashboard">Cancel</a>
        </div>
      </form>
    </div>`,
  );

export const lockedPage = ({ staffHere, ...ctx }) =>
  layout(
    { ...ctx, title: 'Starting up' },
    `<div class="card narrow center">
      <h1>DocVault is starting up</h1>
      <p>The document store is locked until the college office unlocks it. Please try again in a little while.</p>
      ${staffHere ? '<p class="hint">College staff: <a href="/unlock">unlock DocVault</a>.</p>' : ''}
    </div>`,
  );

export const unlockPage = ({ errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Unlock' },
    `<div class="card narrow">
      <h1>Unlock DocVault</h1>
      <p class="muted">The server was restarted, so the document encryption key is locked. Enter the unlock passphrase
        to open it. The key is kept only in memory until the next restart. Every unlock is emailed to all staff.</p>
      ${errorBox(errors)}
      <form method="post" action="/unlock">
        ${csrfField(ctx.csrf)}
        <label>Unlock passphrase <input type="password" name="passphrase" required maxlength="200" autocomplete="off" autofocus></label>
        <button class="btn">Unlock</button>
      </form>
    </div>`,
  );

export const chooseDepartment = ({ errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Choose your department' },
    `<div class="card narrow">
      <h1>Choose your department</h1>
      <p class="muted">Before you can use DocVault, tell us your department. Only your department's staff
        (and the college office) will see your documents.</p>
      ${errorBox(errors)}
      <form method="post" action="/account/department">
        ${csrfField(ctx.csrf)}
        <label>Department <select name="department" required><option value="" selected disabled>Choose your department…</option>${departmentOptions()}</select></label>
        <p class="hint">You can set this once. To change it later, ask the college office.</p>
        <button class="btn">Continue</button>
      </form>
    </div>`,
  );

export const errorPage = ({ status, message, ...ctx }) =>
  layout(
    { ...ctx, title: 'Error' },
    `<div class="card narrow center"><h1>${esc(status)}</h1><p>${esc(message)}</p><a class="btn" href="/">Back to home</a></div>`,
  );
