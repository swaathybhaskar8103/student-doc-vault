// Puts DocVault online from this computer through a free Cloudflare "quick tunnel" (no account, no card).
//   npm run share     ->  prints a public https://….trycloudflare.com link; Ctrl+C stops sharing
//
// DocVault runs in online mode: secure cookies, and staff pages only open on THIS computer
// (http://localhost:3000/admin/login). Visitors through the link can only use the student pages.
// The link changes every time. The computer must stay on and awake (this script keeps it awake).
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const PORT = 3000;
const children = [];
const stopAll = (code = 0) => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};
process.on('SIGINT', () => { console.log('\nStopped sharing. DocVault is offline.'); stopAll(0); });
process.on('SIGTERM', () => stopAll(0));

try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore' }); } catch {
  console.error('cloudflared is not installed. On a Mac: brew install cloudflared');
  process.exit(1);
}
const portBusy = await new Promise((resolve) => {
  const probe = net.connect(PORT, '127.0.0.1');
  probe.on('connect', () => { probe.destroy(); resolve(true); });
  probe.on('error', () => resolve(false));
});
if (portBusy) {
  console.error(`Something is already running on port ${PORT} (probably DocVault from npm start). Stop it first, then run npm run share.`);
  process.exit(1);
}

console.log('Starting the Cloudflare tunnel…');
const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Cloudflare did not give a link within 60 seconds. Check the internet connection and try again.')), 60000);
  const onData = (chunk) => {
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('exit', (code) => reject(new Error(`cloudflared stopped (exit code ${code}).`)));
}).catch((err) => { console.error(err.message); stopAll(1); });

const server = spawn(process.execPath, ['--env-file=.env', 'server.js'], {
  stdio: 'inherit',
  env: {
    ...process.env, // these win over .env (Node's --env-file never overrides existing variables)
    NODE_ENV: 'production',
    APP_URL: url,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    STAFF_ALLOWED_NETWORKS: '127.0.0.1, ::1', // staff pages only on this computer
  },
});
children.push(server);
server.on('exit', (code) => { console.log(`DocVault stopped (exit code ${code}).`); stopAll(code ?? 1); });

// Keep a Mac awake while sharing; harmless elsewhere.
if (process.platform === 'darwin') children.push(spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' }));

setTimeout(() => {
  console.log('\n================================================================');
  console.log(` DocVault is online:  ${url}`);
  console.log(` Students: share this link.  Staff: use http://localhost:${PORT}/admin/login on THIS computer.`);
  console.log(' Keep this window open. Press Ctrl+C to stop sharing.');
  console.log('================================================================\n');
}, 2500);
