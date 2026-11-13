// What the hub may fetch for an agent (design 5, Unattended options): which URLs, and which addresses their hosts may
// resolve to. The hub sits on a server with its own loopback services, a private network and, in a cloud, a metadata
// service; an agent that reads hostile text must not be able to point the hub at any of them. So a URL names a public
// site by its DNS name, and every address that name resolves to must be public unicast. Pure: no I/O.
import { isIP } from 'node:net';
import { FETCH_URL_MAX } from '@agflow/core';

/** What an address is; only 'public' is ever connected to. */
export type AddressKind =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'carrier-grade NAT'
  | 'unique local'
  | 'multicast'
  | 'documentation'
  | 'reserved'
  | 'IPv4-mapped'
  | 'invalid';

/** Dotted decimal in its one plain form, as a 32-bit number: four parts of 0 to 255, none with a leading zero. */
function parseIpv4(text: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!parts) return null;
  let value = 0;
  for (const part of parts.slice(1)) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** An IPv6 address as its eight 16-bit groups; a zone id, brackets or anything else unusual gives null. */
function parseIpv6(text: string): number[] | null {
  if (text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let rest = text;
  if (text.includes('.')) {
    // The last 32 bits written as dotted decimal.
    const colon = text.lastIndexOf(':');
    const embedded = colon < 0 ? null : parseIpv4(text.slice(colon + 1));
    if (embedded === null) return null;
    rest = `${text.slice(0, colon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = groupsOf(halves[0] as string);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = groupsOf(halves[1] as string);
  if (!right || left.length + right.length > 7) return null;
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** The IPv4 ranges that are not public unicast (the IANA special-purpose registry), as [first address, prefix, kind]. */
const IPV4_SPECIAL: readonly (readonly [string, number, AddressKind])[] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  // Cloud metadata services live here (169.254.169.254).
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const IPV4_RANGES = IPV4_SPECIAL.map(([first, prefix, kind]) => ({
  first: parseIpv4(first) as number,
  size: 2 ** (32 - prefix),
  kind,
}));

function classifyIpv4(value: number): AddressKind {
  return IPV4_RANGES.find((range) => value >= range.first && value < range.first + range.size)?.kind ?? 'public';
}

function classifyIpv6(groups: number[]): AddressKind {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const leadingZeros = groups.findIndex((group) => group !== 0);
  if (leadingZeros === -1) return 'unspecified';
  if (leadingZeros === 7 && g7 === 1) return 'loopback';
  // ::ffff:a.b.c.d reaches the IPv4 address it embeds. No resolver answers one unasked, so none is trusted.
  if (leadingZeros === 5 && g5 === 0xffff) return 'IPv4-mapped';
  // The NAT64 well-known prefix 64:ff9b::/96 reaches the IPv4 address in its last 32 bits: judged as that address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return classifyIpv4(g6 * 0x10000 + g7);
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xfe00) === 0xfc00) return 'unique local';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  // Global unicast is 2000::/3; nothing else is routed on the internet.
  if ((g0 & 0xe000) !== 0x2000) return 'reserved';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation';
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return 'documentation';
  // 2001::/23 holds Teredo and other protocol assignments, and 2002::/16 is 6to4: both can wrap an IPv4 address.
  if ((g0 === 0x2001 && g1 < 0x0200) || g0 === 0x2002) return 'reserved';
  return 'public';
}

/** What a resolved address is. Only an address written in its plain form is recognised; the rest is 'invalid'. */
export function classifyAddress(address: string): AddressKind {
  const v4 = parseIpv4(address);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  return v6 === null ? 'invalid' : classifyIpv6(v6);
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

/** A URL or an address the hub will not fetch; the message tells the agent what to change. */
export class FetchRefusal extends Error {
  override name = 'FetchRefusal';
}

/** Whitespace and control characters, which the URL parser would drop or encode silently, and the backslash, which it reads as "/". */
const UNSAFE_IN_URL = /[\s\p{Cc}\\]/u;

/** One label of a DNS host name: letters, digits and inner hyphens. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The URL as the hub fetches it, or a FetchRefusal: http or https on its default port, no credentials, and a DNS host
 * name with a dot. The URL parser has already turned every spelling of an IPv4 address (decimal, hex, octal, short,
 * percent-encoded, full-width) into dotted decimal, so an IP address is recognised whatever was written. The fragment
 * is dropped: it is never sent.
 */
export function parseFetchUrl(raw: string): URL {
  if (raw.length > FETCH_URL_MAX) throw new FetchRefusal(`the URL is longer than ${FETCH_URL_MAX} characters`);
  if (UNSAFE_IN_URL.test(raw)) throw new FetchRefusal('the URL contains whitespace, a control character or a backslash');
  const url = URL.parse(raw);
  if (!url) throw new FetchRefusal('this is not a URL; write it in full, such as https://example.com/page');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefusal(`only http and https URLs can be fetched, not ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') throw new FetchRefusal('the URL must not carry a user name or a password');
  if (url.port !== '') {
    throw new FetchRefusal(`the URL names port ${url.port}; only the default ports are reached (80 for http, 443 for https)`);
  }
  const host = url.hostname;
  if (host.startsWith('[') || isIP(host) !== 0) {
    throw new FetchRefusal('the URL names an IP address; name the site by its DNS host name');
  }
  const labels = host.split('.');
  const top = labels.at(-1) as string;
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)) || !/^[a-z]/.test(top)) {
    throw new FetchRefusal(`"${host}" is not a public DNS host name, such as example.com`);
  }
  url.hash = '';
  return url;
}
