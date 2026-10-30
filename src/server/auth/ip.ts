import ipaddr from "ipaddr.js";

/**
 * Client IP as seen by the trusted reverse proxy. With TRUST_PROXY the
 * rightmost X-Forwarded-For entry is the address our proxy observed; anything
 * to its left is client-controlled and ignored.
 */
export function clientIp(headers: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const xff = headers.get("x-forwarded-for");
  if (!xff) return null;
  const last = xff.split(",").at(-1)?.trim();
  return last && ipaddr.isValid(last) ? last : null;
}

function normalize(ip: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed;
}

export function parseCidrs(cidrs: string[]): [ipaddr.IPv4 | ipaddr.IPv6, number][] {
  return cidrs.map((c) => {
    const range = c.includes("/") ? c : `${c}/${ipaddr.parse(c).kind() === "ipv4" ? 32 : 128}`;
    return ipaddr.parseCIDR(range);
  });
}

export function ipAllowed(ip: string | null, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  if (!ip || !ipaddr.isValid(ip)) return false;
  const addr = normalize(ip);
  return parseCidrs(cidrs).some(
    ([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits),
  );
}
