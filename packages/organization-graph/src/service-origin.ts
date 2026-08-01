import { isIP } from 'node:net';

export type GraphServiceNetworkMode = 'loopback' | 'internal';

function isIPv4Loopback(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && octets[0] === 127;
}

function isIPv4PrivateOrLinkLocal(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

function isIPv6PrivateOrLinkLocal(hostname: string): boolean {
  const firstHextet = hostname.toLowerCase().split(':')[0]!;
  const value = Number.parseInt(firstHextet, 16);
  return Number.isFinite(value) && ((value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80);
}

function allowedHostname(hostname: string, networkMode: GraphServiceNetworkMode): boolean {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (networkMode === 'loopback') {
    return (isIP(unbracketed) === 4 && isIPv4Loopback(unbracketed)) || unbracketed === '::1';
  }
  if (isIP(unbracketed) === 4) {
    return isIPv4Loopback(unbracketed) || isIPv4PrivateOrLinkLocal(unbracketed);
  }
  if (isIP(unbracketed) === 6) {
    return unbracketed === '::1' || isIPv6PrivateOrLinkLocal(unbracketed);
  }
  return false;
}

export function normalizeGraphServiceOrigin(
  value: string,
  networkMode: GraphServiceNetworkMode,
  label = 'Graph service origin',
): string {
  if (networkMode !== 'loopback' && networkMode !== 'internal') {
    throw new TypeError(`${label} network mode must be loopback or internal.`);
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new TypeError(`${label} must be a non-empty bounded URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL.`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !allowedHostname(parsed.hostname, networkMode) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  ) {
    throw new TypeError(`${label} must be an exact credential-free ${networkMode} HTTP origin.`);
  }
  return parsed.origin;
}
