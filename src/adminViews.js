import { DOC_TYPES, documentLabel, DEPARTMENTS, deptLabel } from './config.js';
import { layout, esc, fmtSize, fmtTime, csrfField, errorBox, flashBox, statusBadge, aiBadge, checklistPanel, departmentOptions } from './views.js';
import { buildChecklist } from './checklist.js';

const docLabel = (d) => esc(documentLabel(d));

export const adminLogin = ({ errors, values = {}, ...ctx }) =>
  layout(
    { ...ctx, title: 'Staff login' },
    `<div class="card narrow">
      <h1>College staff login</h1>
      <p class="muted">For college office staff who verify student documents.</p>
      ${errorBox(errors)}
      <form method="post" action="/admin/login">
        ${csrfField(ctx.csrf)}
        <label>Staff email <input type="email" name="email" required maxlength="200" autocomplete="username" value="${esc(values.email)}"></label>
        <label>Password <input type="password" name="password" required maxlength="128" autocomplete="current-password"></label>
        <button class="btn">Log in</button>
      </form>
      <p class="muted small-print">Student? <a href="/login">Student login</a></p>
    </div>`,
  );

export const adminQueue = ({ docs, status, q, counts, studentCount, aiPassedCount, flash, ...ctx }) => {
  const tab = (key, label) => {
    const href = `/admin?status=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    return `<a class="tab ${status === key ? 'active' : ''}" href="${esc(href)}">${label} <span>${counts[key]}</span></a>`;
  };
  const rows = docs.length
    ? docs.map((d) => `<tr>
        <td data-label="Student"><a href="/admin/students/${esc(d.student_id)}">${esc(d.student_name)}</a><div class="sub"><code>${esc(d.student_id)}</code></div></td>
        <td data-label="Document">${docLabel(d)}<div class="sub filename">${esc(d.original_name)}</div></td>
        <td data-label="Uploaded">${fmtTime(d.uploaded_at)}</td>
        <td data-label="Status">${statusBadge(d.status)}${d.reviewed_by ? `<div class="sub">by ${esc(d.reviewed_by)}</div>` : ''}</td>
        <td data-label="AI check">${aiBadge(d) || '<span class="sub">Not checked</span>'}${
          d.ai_verdict && d.ai_verdict !== 'ok' && d.ai_summary ? `<div class="review-note">${esc(d.ai_summary)}</div>` : ''}</td>
        <td class="row-actions"><a class="btn small" href="/admin/documents/${esc(d.id)}">${d.status === 'pending' ? 'Review' : 'Open'}</a></td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty">${status === 'pending' ? 'Nothing waiting for review.' : 'No documents match.'}</td></tr>`;

  return layout(
    { ...ctx, title: 'Review queue' },
    `${flashBox(flash)}
    <section class="stats">
      <div><strong>${studentCount}</strong><span>Students</span></div>
      <div><strong>${counts.all}</strong><span>Documents</span></div>
      <div class="pending"><strong>${counts.pending}</strong><span>Waiting for review</span></div>
      <div class="verified"><strong>${counts.verified}</strong><span>Verified</span></div>
    </section>
    <section class="card">
      <h1>Review queue</h1>
      ${aiPassedCount ? `<div class="bulk-bar"><span><strong>${aiPassedCount}</strong> pending document${aiPassedCount === 1 ? '' : 's'} passed the AI check.</span>
        <a class="btn small verify-btn" href="/admin/bulk-verify">Review &amp; verify all AI-passed</a></div>` : ''}
      <div class="toolbar">
        <nav class="tabs">${tab('pending', 'Pending')}${tab('verified', 'Verified')}${tab('rejected', 'Rejected')}${tab('all', 'All')}</nav>
        <form method="get" action="/admin" class="search">
          <input type="hidden" name="status" value="${esc(status)}">
          <input type="search" name="q" placeholder="Search name, ID or email" value="${esc(q)}">
          <button class="btn small">Search</button>
        </form>
      </div>
      <table class="docs">
        <thead><tr><th>Student</th><th>Document</th><th>Uploaded</th><th>Status</th><th>AI check</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`,
  );
};

export const adminStudents = ({ students, q, missingOnly, deptFilter, office, requiredTotal, flash, ...ctx }) => {
  const rows = students.length
    ? students.map((s, i) => `<tr>
        <td data-label="S.No" class="sno">${i + 1}</td>
        <td data-label="Student ID"><a href="/admin/students/${esc(s.id)}"><code>${esc(s.id)}</code></a></td>
        <td data-label="Name"><a href="/admin/students/${esc(s.id)}">${esc(s.name)}</a></td>
        <td data-label="Email" class="filename">${esc(s.email)}</td>
        <td data-label="Dept">${s.department ? esc(s.department) : '<span class="sub">Not set</span>'}</td>
        <td data-label="Uploaded">${s.total}</td>
        <td data-label="Required"><span class="badge ${s.required_done >= requiredTotal ? 'verified' : 'pending'}">${s.required_done}/${requiredTotal}</span></td>
        <td data-label="Status">
          ${s.verified ? `<span class="badge verified">${s.verified} verified</span>` : ''}
          ${s.pending ? `<span class="badge pending">${s.pending} pending</span>` : ''}
          ${s.rejected ? `<span class="badge rejected">${s.rejected} rejected</span>` : ''}
          ${s.total ? '' : '<span class="sub">No uploads yet</span>'}
        </td>
        <td data-label="Last uploaded">${s.last_upload ? fmtTime(s.last_upload) : '<span class="sub">Never</span>'}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" class="empty">${missingOnly ? 'Every student has uploaded all required documents.' : 'No students found.'}</td></tr>`;
  const keep = (extra) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (deptFilter) p.set('dept', deptFilter); for (const [k, v] of Object.entries(extra)) p.set(k, v); const str = p.toString(); return str ? `?${str}` : ''; };

  return layout(
    { ...ctx, title: 'Students' },
    `${flashBox(flash)}
    <section class="card wide">
      <h1>Students <span class="count">${students.length}</span></h1>
      <p class="muted">${office ? 'Admin: you can see students of every department.' : `Showing only ${esc(deptLabel(ctx.admin.department))} students.`}</p>
      <div class="toolbar">
        <nav class="tabs">
          <a class="tab ${missingOnly ? '' : 'active'}" href="/admin/students${esc(keep({}))}">All</a>
          <a class="tab ${missingOnly ? 'active' : ''}" href="/admin/students${esc(keep({ missing: '1' }))}">Missing required documents</a>
        </nav>
        <form method="get" action="/admin/students" class="search">
          ${missingOnly ? '<input type="hidden" name="missing" value="1">' : ''}
          ${office ? `<select name="dept" aria-label="Department"><option value="">All departments</option>${DEPARTMENTS.map((d) => `<option value="${esc(d.key)}"${d.key === deptFilter ? ' selected' : ''}>${esc(d.key)}</option>`).join('')}<option value="none"${deptFilter === 'none' ? ' selected' : ''}>Not set</option></select>` : ''}
          <input type="search" name="q" placeholder="Search name, ID or email" value="${esc(q)}">
          <button class="btn small">Search</button>
        </form>
      </div>
      <p class="hint">Most recently active students first. Click a Student ID or name to see their documents.</p>
      <div class="table-scroll">
        <table class="docs students-table">
          <thead><tr><th>S.No</th><th>Student ID</th><th>Name</th><th>Email</th><th>Dept</th><th>Uploaded</th><th>Required</th><th>Status</th><th>Last uploaded</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`,
  );
};

export const adminStudent = ({ student, docs, office, flash, ...ctx }) => {
  const missing = buildChecklist(docs).missingRequired;
  const rows = docs.length
    ? docs.map((d) => `<tr>
        <td data-label="Type">${docLabel(d)}</td>
        <td data-label="File" class="filename">${esc(d.original_name)}</td>
        <td data-label="Uploaded">${fmtTime(d.uploaded_at)}</td>
        <td data-label="Status">${statusBadge(d.status)}${d.review_note ? `<div class="review-note">${esc(d.review_note)}</div>` : ''}</td>
        <td class="row-actions"><a class="btn small" href="/admin/documents/${esc(d.id)}">${d.status === 'pending' ? 'Review' : 'Open'}</a></td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">This student hasn't uploaded anything yet.</td></tr>`;

  return layout(
    { ...ctx, title: student.name },
    `${flashBox(flash)}
    <p><a href="/admin/students">← All students</a></p>
    <section class="card">
      <h1>${esc(student.name)}</h1>
      <dl class="doc-summary">
        <dt>Student ID</dt><dd><code>${esc(student.id)}</code></dd>
        <dt>Email</dt><dd>${esc(student.email)}</dd>
        <dt>Department</dt><dd>${esc(deptLabel(student.department))}</dd>
        <dt>Registered</dt><dd>${fmtTime(student.created_at)}</dd>
      </dl>
      ${office ? `<form method="post" action="/admin/students/${esc(student.id)}/department" class="inline-form">
        ${csrfField(ctx.csrf)}
        <label>Change department <select name="department" required>${departmentOptions(student.department)}</select></label>
        <button class="btn small secondary">Save</button>
      </form>` : ''}
      <table class="docs">
        <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    ${checklistPanel(docs, { forStaff: true })}
    ${missing.length ? `<form method="post" action="/admin/students/${esc(student.id)}/remind" class="card remind">
      ${csrfField(ctx.csrf)}
      <p>Missing: <strong>${missing.map((i) => esc(i.label)).join(', ')}</strong></p>
      <button class="btn">Email ${esc(student.name)} a reminder</button>
    </form>` : ''}`,
  );
};

const TYPE_NAME = (key) => (key === 'unknown' ? 'Could not tell' : key === 'other' ? 'Other document' : DOC_TYPES[key] ?? key);
function aiFindings(doc) {
  if (!doc.ai_status) return '';
  let details = null;
  try { details = doc.ai_details ? JSON.parse(doc.ai_details) : null; } catch { /* shown without details */ }
  return `<div class="ai-findings">
    <h2>AI check (college server) ${aiBadge(doc)}</h2>
    ${doc.ai_summary ? `<p>${esc(doc.ai_summary)}</p>` : ''}
    ${details ? `<dl class="doc-summary">
      <dt>Looks like</dt><dd>${esc(TYPE_NAME(details.document_type))}</dd>
      <dt>Name read</dt><dd>${esc(details.name_on_document || 'None found')} <span class="sub">(account: ${esc(doc.student_name)})</span></dd>
      <dt>Readable</dt><dd>${details.readable ? 'Yes' : `No${details.quality_problem ? `: ${esc(details.quality_problem)}` : ''}`}</dd>
      ${details.aadhaar_masked !== null && details.aadhaar_masked !== undefined
        ? `<dt>Aadhaar no.</dt><dd>${details.aadhaar_masked ? 'Masked' : 'Full number on card'} · ${esc(details.id_number)}</dd>` : ''}
      <dt>Model</dt><dd class="sub">${esc(details.model)} · ${esc(details.seconds)}s</dd>
    </dl>` : ''}
    <p class="hint">The AI can misread. Always open the document before deciding.</p>
  </div>`;
}

export const adminBulkVerify = ({ docs, ...ctx }) =>
  layout(
    { ...ctx, title: 'Verify AI-passed' },
    `<p><a href="/admin">← Review queue</a></p>
    <section class="card">
      <h1>Verify ${docs.length} AI-passed document${docs.length === 1 ? '' : 's'}?</h1>
      <p class="muted">The AI found each of these readable, of the right type, and showing the student's own name.
        Each student will be emailed. Open any you're unsure about first.</p>
      <table class="docs">
        <thead><tr><th>Student</th><th>Document</th><th>AI summary</th><th></th></tr></thead>
        <tbody>${docs.map((d) => `<tr>
          <td data-label="Student">${esc(d.student_name)}<div class="sub"><code>${esc(d.student_id)}</code></div></td>
          <td data-label="Document">${docLabel(d)}<div class="sub filename">${esc(d.original_name)}</div></td>
          <td data-label="AI summary" class="review-note">${esc(d.ai_summary)}</td>
          <td class="row-actions"><a class="btn small secondary" href="/admin/documents/${esc(d.id)}/file" target="_blank" rel="noopener">Open ↗</a></td>
        </tr>`).join('')}</tbody>
      </table>
      <form method="post" action="/admin/bulk-verify" class="actions left bulk-form">
        ${csrfField(ctx.csrf)}<input type="hidden" name="ids" value="${esc(docs.map((d) => d.id).join(','))}">
        <button class="btn verify-btn">Yes, verify all ${docs.length}</button>
        <a class="btn secondary" href="/admin">Cancel</a>
      </form>
    </section>`,
  );

export const adminReview = ({ doc, pendingLeft, errors, flash, ...ctx }) =>
  layout(
    { ...ctx, title: 'Review document' },
    `${flashBox(flash)}
    <p><a href="/admin">← Review queue</a> <span class="muted">· ${pendingLeft} waiting for review</span></p>
    <section class="card review">
      <h1>${docLabel(doc)} ${statusBadge(doc.status)}</h1>
      <dl class="doc-summary">
        <dt>Student</dt><dd><a href="/admin/students/${esc(doc.student_id)}">${esc(doc.student_name)}</a> · <code>${esc(doc.student_id)}</code></dd>
        <dt>Email</dt><dd>${esc(doc.student_email)}</dd>
        <dt>Department</dt><dd>${esc(deptLabel(doc.student_department))}</dd>
        <dt>File</dt><dd class="filename">${esc(doc.original_name)} (${fmtSize(doc.size)})</dd>
        <dt>Uploaded</dt><dd>${fmtTime(doc.uploaded_at)}</dd>
        ${doc.reviewed_by ? `<dt>Last review</dt><dd>${statusBadge(doc.status)} by ${esc(doc.reviewed_by)}, ${fmtTime(doc.reviewed_at)}${doc.review_note ? `<div class="review-note">${esc(doc.review_note)}</div>` : ''}</dd>` : ''}
      </dl>
      ${aiFindings(doc)}
      <p><a class="btn secondary" href="/admin/documents/${esc(doc.id)}/file" target="_blank" rel="noopener">Open document in new tab ↗</a></p>
      <p class="hint">Check it's the right document type, belongs to this student, and is clear and complete.
        Opening it is recorded in the student's activity log.</p>
      ${errorBox(errors)}
      <div class="decisions">
        <form method="post" action="/admin/documents/${esc(doc.id)}/review" class="decision verify">
          ${csrfField(ctx.csrf)}<input type="hidden" name="decision" value="verified">
          <h2>Verify</h2>
          <label>Note for the student (optional) <input name="note" maxlength="300" placeholder="e.g. Checked against college records"></label>
          <button class="btn verify-btn">Mark as verified</button>
        </form>
        <form method="post" action="/admin/documents/${esc(doc.id)}/review" class="decision reject">
          ${csrfField(ctx.csrf)}<input type="hidden" name="decision" value="rejected">
          <h2>Reject</h2>
          <label>Reason (required, sent to the student) <input name="note" maxlength="300" required placeholder="e.g. Photo is blurry, marks not readable"></label>
          <button class="btn danger-solid">Reject document</button>
        </form>
      </div>
    </section>`,
  );

export const adminSetup = ({ errors, values = {}, ...ctx }) =>
  layout(
    { ...ctx, title: 'Staff setup' },
    `<div class="card narrow">
      <h1>Set up the first staff account</h1>
      <p class="muted">No college staff accounts exist yet. Create the first one here. This page only works on
        this computer and disappears once an account exists. Add other staff later from the <em>Staff</em> page.</p>
      ${errorBox(errors)}
      <form method="post" action="/admin/setup">
        ${csrfField(ctx.csrf)}
        <label>Your name (shown to students on reviews) <input name="name" required maxlength="100" placeholder="e.g. College Office" value="${esc(values.name)}"></label>
        <label>Staff email <input type="email" name="email" required maxlength="200" autocomplete="username" value="${esc(values.email)}"></label>
        <label>Password <input type="password" name="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm password <input type="password" name="confirm" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <p class="hint">At least 12 characters. Write it down somewhere safe.</p>
        <button class="btn">Create staff account</button>
      </form>
    </div>`,
  );

export const adminStaff = ({ staff, addErrors, values = {}, flash, ...ctx }) => {
  const rows = staff.map((s) => `<tr>
      <td data-label="Name">${esc(s.name)}${s.id === ctx.admin.id ? ' <span class="badge verified">You</span>' : ''}</td>
      <td data-label="Email" class="filename">${esc(s.email)}</td>
      <td data-label="Department">${esc(deptLabel(s.department))}</td>
      <td data-label="Added">${fmtTime(s.created_at)}</td>
      <td class="row-actions">${s.id === ctx.admin.id ? '' : `
        <form method="post" action="/admin/staff/${esc(s.id)}/delete">
          ${csrfField(ctx.csrf)}<button class="btn small danger">Remove</button>
        </form>`}</td>
    </tr>`).join('');

  return layout(
    { ...ctx, title: 'Staff' },
    `${flashBox(flash)}
    <section class="card">
      <h1>Staff accounts <span class="count">${staff.length}</span></h1>
      <table class="docs">
        <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    <section class="card">
      <h2>Add a staff member</h2>
      ${errorBox(addErrors)}
      <form method="post" action="/admin/staff" class="grid-form">
        ${csrfField(ctx.csrf)}
        <label>Name <input name="name" required maxlength="100" value="${esc(values.name)}"></label>
        <label>Email <input type="email" name="email" required maxlength="200" autocomplete="off" value="${esc(values.email)}"></label>
        <label>Department <select name="department" required><option value="" ${values.department ? '' : 'selected'} disabled>Choose…</option>${departmentOptions(values.department, { includeAll: true })}</select></label>
        <span></span>
        <label>Password <input type="password" name="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm password <input type="password" name="confirm" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <button class="btn">Add staff member</button>
      </form>
      <p class="hint">Department staff only see students of their own department. Choose "Admin" for the Office or
        Principal: they see every department and can add or remove staff. Tell them the password in person.</p>
    </section>`,
  );
};

export const adminVerify = ({ email, errors, ...ctx }) =>
  layout(
    { ...ctx, title: 'Staff login code' },
    `<div class="card narrow">
      <h1>Check your email</h1>
      <p class="muted">We sent a 6-digit login code to <strong>${esc(email)}</strong>. It expires in 10 minutes.
        Not in your inbox? Check Spam.</p>
      ${errorBox(errors)}
      <form method="post" action="/admin/verify">
        ${csrfField(ctx.csrf)}
        <label>Login code <input name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" class="code-input" autofocus></label>
        <button class="btn">Log in</button>
      </form>
      <p class="muted small-print">Didn't get it? <a href="/admin/login">Log in again</a> for a new code.</p>
    </div>`,
  );

export const adminAccount = ({ mustChange, errors, detailErrors, values = {}, flash, ...ctx }) =>
  layout(
    { ...ctx, title: 'Account' },
    `${flashBox(flash)}
    <div class="card narrow" id="details">
      <h1>Account details</h1>
      ${errorBox(detailErrors)}
      <form method="post" action="/admin/account/details">
        ${csrfField(ctx.csrf)}
        <label>Name (shown to students on reviews) <input name="name" required maxlength="100" value="${esc(values.name ?? ctx.admin.name)}"></label>
        <label>Email (used to log in) <input type="email" name="email" required maxlength="200" autocomplete="username" value="${esc(values.email ?? ctx.admin.email)}"></label>
        <p class="muted">Department: <strong>${esc(deptLabel(ctx.admin.department))}</strong> (set by an admin)</p>
        <label>Current password <span class="sub">(only needed to change your email)</span>
          <input type="password" name="current" maxlength="128" autocomplete="current-password"></label>
        <button class="btn">Save details</button>
      </form>
    </div>
    <div class="card narrow" id="password">
      <h2>Change password</h2>
      ${mustChange ? '<div class="alert error"><p>Your password is too short. Choose a new one with at least 12 characters to continue.</p></div>' : ''}
      ${errorBox(errors)}
      <form method="post" action="/admin/password">
        ${csrfField(ctx.csrf)}
        <label>Current password <input type="password" name="current" required maxlength="128" autocomplete="current-password"></label>
        <label>New password <input type="password" name="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <label>Confirm new password <input type="password" name="confirm" required minlength="12" maxlength="128" autocomplete="new-password"></label>
        <p class="hint">At least 12 characters. Changing it logs you out on every other device.</p>
        <button class="btn">Change password</button>
      </form>
    </div>`,
  );
