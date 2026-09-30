import nodemailer from 'nodemailer';
import { esc } from './views.js';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL = 'http://localhost:3000' } = process.env;

const transporter = SMTP_HOST && SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 465,
      secure: (Number(SMTP_PORT) || 465) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

if (!transporter) console.log('Email not configured (SMTP_* in .env): emails will be printed here instead of sent.');

async function send({ to, subject, text, html }) {
  if (!transporter) {
    console.log(`\n----- EMAIL (not sent) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n----------------------------\n`);
    return;
  }
  const info = await transporter.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
  console.log(`Email sent to ${to}: "${subject}" (${info.response})`);
}

function studentIdEmail({ name, id, intro }) {
  // Links to localhost look broken to spam filters, so only include the button once the site has a real address.
  const hasPublicUrl = !/localhost|127\.0\.0\.1/.test(APP_URL);
  const loginLine = hasPublicUrl ? `Log in at ${APP_URL}/login with this ID (or your email) and your password.` : 'Log in to DocVault with this ID (or your email) and your password.';
  const text = `Hi ${name},\n\n${intro}\n\nYour Student ID: ${id}\n\n${loginLine}\n\nNever share your password with anyone, including college staff.\nIf you didn't request this, you can ignore this email.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  <p>${esc(intro)}</p>
  <p style="font:700 24px monospace;letter-spacing:2px;text-align:center;padding:16px;border:2px dashed #1f5fbf;border-radius:10px">${esc(id)}</p>
  ${hasPublicUrl
    ? `<p><a href="${esc(APP_URL)}/login" style="display:inline-block;background:#1f5fbf;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Log in to DocVault</a></p>`
    : `<p>${esc(loginLine)}</p>`}
  <p style="color:#5d6673;font-size:13px">Never share your password with anyone, including college staff. If you didn't request this, you can ignore this email.</p>
</div>`;
  return { text, html };
}

// Email failures are logged, never shown to the user or allowed to break the request.
export function sendWelcomeEmail({ email, name, id }) {
  send({
    to: email,
    subject: `Your DocVault Student ID: ${id}`,
    ...studentIdEmail({ name, id, intro: 'Your DocVault account has been created. Keep this email: it has your Student ID.' }),
  }).catch((err) => console.error('Welcome email failed:', err.message));
}

export function sendStudentIdReminder({ email, name, id }) {
  send({
    to: email,
    subject: 'Your DocVault Student ID',
    ...studentIdEmail({ name, id, intro: 'You asked for a reminder of your DocVault Student ID. Here it is.' }),
  }).catch((err) => console.error('Reminder email failed:', err.message));
}

export function sendPasswordChangedEmail({ email, name }) {
  const text = `Hi ${name},\n\nThe password for your DocVault account was just changed, and any other devices were logged out.\n\nIf this was you, no action is needed.\nIf this was NOT you, contact the college office immediately.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  <p>The password for your DocVault account was just changed, and any other devices were logged out.</p>
  <p>If this was you, no action is needed.</p>
  <p><strong>If this was not you, contact the college office immediately.</strong></p>
</div>`;
  send({ to: email, subject: 'Your DocVault password was changed', text, html })
    .catch((err) => console.error('Password-changed email failed:', err.message));
}

export function sendPasswordResetCode({ email, name, code }) {
  const text = `Hi ${name},\n\nYour DocVault password reset code is: ${code}\n\nIt expires in 15 minutes. Enter it on the DocVault reset page.\n\nNever share this code with anyone, including college staff.\nIf you didn't ask to reset your password, ignore this email: your password has not been changed.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  <p>Your password reset code is:</p>
  <p style="font:700 32px monospace;letter-spacing:6px;text-align:center;padding:16px;border:2px dashed #1f5fbf;border-radius:10px">${esc(code)}</p>
  <p>It expires in 15 minutes. Enter it on the DocVault reset page.</p>
  <p style="color:#5d6673;font-size:13px">Never share this code with anyone, including college staff. If you didn't ask to reset your password, ignore this email: your password has not been changed.</p>
</div>`;
  send({ to: email, subject: 'Your DocVault password reset code', text, html })
    .catch((err) => console.error('Reset code email failed:', err.message));
}

export function sendReviewEmail({ email, name, docLabel, decision, note }) {
  const verified = decision === 'verified';
  const subject = verified ? `Your ${docLabel} has been verified` : `Action needed: your ${docLabel} was not accepted`;
  const lines = verified
    ? [`The college has checked and verified your ${docLabel} on DocVault.`, note ? `Note from the college: ${note}` : '']
    : [`Your ${docLabel} on DocVault could not be accepted.`, `Reason: ${note}`,
       'What to do: log in to DocVault. The document is marked Rejected on your dashboard. Click "Upload new copy" next to it and upload a correct, clear copy. The college will review it again.'];
  const body = lines.filter(Boolean);
  const text = `Hi ${name},\n\n${body.join('\n\n')}\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  ${body.map((l) => `<p>${esc(l)}</p>`).join('\n  ')}
</div>`;
  send({ to: email, subject, text, html }).catch((err) => console.error('Review email failed:', err.message));
}

export function sendMissingDocsReminder({ email, name, missing }) {
  const text = `Hi ${name},\n\nThe college office is still waiting for these documents on DocVault:\n\n${missing.map((m) => `- ${m}`).join('\n')}\n\nPlease log in to DocVault and upload them.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  <p>The college office is still waiting for these documents on DocVault:</p>
  <ul>${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
  <p>Please log in to DocVault and upload them.</p>
</div>`;
  send({ to: email, subject: 'Reminder: documents still needed on DocVault', text, html })
    .catch((err) => console.error('Reminder email failed:', err.message));
}

export function sendStaffLoginCode({ email, name, code }) {
  const text = `Hi ${name},\n\nYour DocVault staff login code is: ${code}\n\nIt expires in 10 minutes.\nIf you did not just try to log in, someone knows your password: change it immediately.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault staff login</h2>
  <p>Hi ${esc(name)},</p>
  <p>Your login code is:</p>
  <p style="font:700 32px monospace;letter-spacing:6px;text-align:center;padding:16px;border:2px dashed #1f5fbf;border-radius:10px">${esc(code)}</p>
  <p>It expires in 10 minutes.</p>
  <p style="color:#8a1c12"><strong>If you did not just try to log in, someone knows your password. Change it immediately.</strong></p>
</div>`;
  send({ to: email, subject: 'Your DocVault staff login code', text, html })
    .catch((err) => console.error('Staff login code email failed:', err.message));
}

export function sendAccountDeletedEmail({ email, name }) {
  const text = `Hi ${name},\n\nYour DocVault account and all your uploaded documents have been permanently deleted, as you asked.\n\nIf you did not do this, contact the college office immediately.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault</h2>
  <p>Hi ${esc(name)},</p>
  <p>Your DocVault account and all your uploaded documents have been permanently deleted, as you asked.</p>
  <p>If you did not do this, contact the college office immediately.</p>
</div>`;
  send({ to: email, subject: 'Your DocVault account has been deleted', text, html })
    .catch((err) => console.error('Account deleted email failed:', err.message));
}

export function sendUnlockAlert({ to, ip, at }) {
  if (!to.length) return;
  const when = new Date(at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const text = `DocVault was unlocked on ${when} from ${ip}.\n\nThis is expected after the server restarts. If nobody in the office unlocked it, change the unlock passphrase (npm run protect-key -- --change) and check the server immediately.\n\nDocVault`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
  <h2 style="margin:0 0 12px">DocVault unlocked</h2>
  <p>DocVault was unlocked on <strong>${esc(when)}</strong> from <strong>${esc(ip)}</strong>.</p>
  <p>This is expected after the server restarts. <strong>If nobody in the office unlocked it</strong>, change the unlock passphrase and check the server immediately.</p>
</div>`;
  send({ to: to.join(', '), subject: 'DocVault was unlocked', text, html })
    .catch((err) => console.error('Unlock alert email failed:', err.message));
}
