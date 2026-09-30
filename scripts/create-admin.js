// Creates a college staff account, or resets an existing one's password.
// Run from the project folder:  npm run create-admin
import crypto from 'node:crypto';

import { db } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { ask, askHidden, quit } from './prompt.js';

console.log('\nDocVault: create a college staff account\n');
const email = (await ask('Staff email: ')).trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) quit('That is not a valid email address.');

const existing = db.prepare('SELECT id, name FROM admins WHERE email = ?').get(email);
let name = existing?.name;
if (existing) {
  const yes = (await ask(`A staff account for ${email} (${existing.name}) already exists. Reset its password? (y/N) `)).trim().toLowerCase();
  if (yes !== 'y') quit('Nothing changed.', 0);
} else {
  name = (await ask('Staff name (shown to students on reviews): ')).trim();
  if (name.length < 2 || name.length > 100) quit('Please enter a name between 2 and 100 characters.');
}

console.log('\nNow choose a password. Nothing will appear on screen while you type it: that is normal.');
let password = null;
for (let attempt = 1; attempt <= 3 && password === null; attempt++) {
  const first = await askHidden('Password (at least 12 characters): ');
  if (first.length < 12 || first.length > 128) {
    console.log(`That was ${first.length} characters. It must be 12 to 128. Please try again.`);
    continue;
  }
  if ((await askHidden('Type the same password again: ')) !== first) {
    console.log('The two passwords did not match. Please try again.');
    continue;
  }
  password = first;
}
if (password === null) quit('No password set, so nothing was changed. Run npm run create-admin again.');

const hash = await hashPassword(password);
if (existing) {
  // Bumping session_version logs this staff member out everywhere else.
  db.prepare('UPDATE admins SET password_hash = ?, session_version = session_version + 1, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hash, existing.id);
  quit(`\nPassword reset for ${existing.name} (${email}).`, 0);
}
db.prepare('INSERT INTO admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(crypto.randomUUID(), name, email, hash, Date.now());
quit(`\nStaff account created for ${name} (${email}).\nLog in at ${process.env.APP_URL ?? 'http://localhost:3000'}/admin/login`, 0);
