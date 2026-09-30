// Staff pages (and unlocking the server) are only reachable from the college's own network.
// STAFF_ALLOWED_NETWORKS: comma-separated IP addresses or ranges, e.g. "203.0.113.10, 10.20.0.0/16".
// Online, use the college's public internet address (open ifconfig.me from the college Wi-Fi).
import net from 'node:net';

// Local development default: this computer and private home/office networks.
const DEV_DEFAULT = '127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7';

export const STAFF_NETWORKS_CONFIGURED = Boolean(process.env.STAFF_ALLOWED_NETWORKS?.trim());
const spec = STAFF_NETWORKS_CONFIGURED ? process.env.STAFF_ALLOWED_NETWORKS : DEV_DEFAULT;

const allow = new net.BlockList(); // used here as an allow-list
for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = entry.split('/');
  const family = net.isIP(addr);
  if (!family || (bits !== undefined && !/^\d+$/.test(bits))) {
    throw new Error(`STAFF_ALLOWED_NETWORKS: "${entry}" is not an IP address or range like 10.0.0.0/8`);
  }
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (bits === undefined) allow.addAddress(addr, type);
  else allow.addSubnet(addr, Number(bits), type);
}

export function isStaffNetwork(ip) {
  let addr = String(ip ?? '');
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4 written as IPv6
  const family = net.isIP(addr);
  return family ? allow.check(addr, family === 6 ? 'ipv6' : 'ipv4') : false;
}

export const describeStaffNetworks = () => spec.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
