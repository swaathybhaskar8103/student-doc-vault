import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { getDataKey } from './keyVault.js';

const scrypt = promisify(crypto.scrypt);

if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is missing. Run `npm run setup`.');

// ---- Passwords: scrypt with a per-user random salt ----
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_OPTS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

// Checked against when the Student ID doesn't exist, so response time doesn't reveal valid IDs.
export const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Files: AES-256-GCM, fresh IV per file. The document id is bound in as
// associated data, so an encrypted file can't be swapped onto another record. ----
export function encryptFile(plain, docId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getDataKey(), iv);
  cipher.setAAD(Buffer.from(docId));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data };
}

export function decryptFile(data, { iv, tag, docId }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getDataKey(), Buffer.from(iv, 'hex'));
  decipher.setAAD(Buffer.from(docId));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ---- Uploads: trust the file's bytes, not its name or the browser's claimed type ----
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffFileType(buf) {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I lookalikes

export function randomStudentId() {
  const part = () => Array.from({ length: 4 }, () => ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)]).join('');
  return `STU-${part()}-${part()}`;
}

// Reset codes are stored only as a keyed hash, so a leaked database doesn't reveal live codes.
export function randomResetCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashResetCode(studentId, code) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${studentId}:${code}`).digest('hex');
}
