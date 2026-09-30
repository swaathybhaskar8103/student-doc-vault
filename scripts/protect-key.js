// Locks the document encryption key with an unlock passphrase, so the key is no longer stored on disk.
//
//   npm run protect-key                 first time: lock MASTER_KEY from .env with a passphrase
//   npm run protect-key -- --change     change the unlock passphrase
//
// After this, DocVault starts LOCKED after every restart; a staff member unlocks it at /unlock
// from the college network.
import fs from 'node:fs';

import { KEY_FILE, MIN_PASSPHRASE, keyFileExists, writeKeyFile, openKeyFile } from '../src/keyVault.js';
import { ask, askHidden, quit } from './prompt.js';

const ENV_FILE = new URL('../.env', import.meta.url);
const changing = process.argv.includes('--change');

async function askNewPassphrase() {
  console.log(`\nChoose an unlock passphrase: at least ${MIN_PASSPHRASE} characters, e.g. four random words.`);
  console.log('Only give it to the staff who will unlock DocVault after a restart. Typing is hidden.');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await askHidden('New unlock passphrase: ');
    if (first.length < MIN_PASSPHRASE) { console.log(`That was ${first.length} characters; it needs at least ${MIN_PASSPHRASE}.`); continue; }
    if ((await askHidden('Type it again: ')) !== first) { console.log('They did not match. Try again.'); continue; }
    return first;
  }
  quit('No passphrase set. Nothing was changed.');
}

let key;
if (changing) {
  if (!keyFileExists()) quit('The key is not protected yet. Run npm run protect-key first.');
  key = await openKeyFile(await askHidden('Current unlock passphrase: '));
  if (!key) quit('That passphrase is not correct. Nothing was changed.');
} else {
  if (keyFileExists()) quit('The key is already protected. To change the passphrase: npm run protect-key -- --change', 0);
  key = Buffer.from(process.env.MASTER_KEY ?? '', 'hex');
  if (key.length !== 32) quit('MASTER_KEY is missing from .env, so there is no key to protect.');
}

const passphrase = await askNewPassphrase();
await writeKeyFile(key, passphrase);
if (!(await openKeyFile(passphrase))?.equals(key)) quit('Could not verify the new key file. Nothing else was changed.');
console.log(`\nKey locked with the new passphrase and saved to ${KEY_FILE}.`);

if (!changing) {
  console.log('\n================ RECOVERY KEY: SHOWN ONLY ONCE ================');
  console.log(key.toString('hex'));
  console.log('===============================================================');
  console.log('Print or write this down and keep it somewhere locked (e.g. the principal\'s safe).');
  console.log('If the unlock passphrase is ever forgotten, putting this back in .env as MASTER_KEY=... recovers every document.');
  console.log('Without the passphrase AND without this recovery key, the documents can never be opened.\n');

  const answer = (await ask('Remove MASTER_KEY from .env now, so the key is no longer stored on this disk? Type YES: ')).trim();
  if (answer === 'YES') {
    const env = fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter((line) => !line.startsWith('MASTER_KEY=')).join('\n');
    fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });
    console.log('MASTER_KEY removed. Restart DocVault; it will start LOCKED until staff unlock it at /unlock.');
  } else {
    console.log('MASTER_KEY left in .env. The key is still on disk until you remove that line and restart.');
  }
}
quit('Done.', 0);
