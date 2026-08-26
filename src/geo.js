/**
 * Device + (optional) geo enrichment for login sessions.
 *
 * Device: parsed from the User-Agent — no network, always available.
 * Geo: OFF by default. Set ZOLLTAX_GEO=1 to look up an approximate city/country
 * from the client IP via ip-api.com (free, no key). This sends the login IP to a
 * third party, so it's opt-in; with it off, sessions show IP + device only.
 */

/** Compact "Browser on OS" label from a User-Agent string. */
export function parseDevice(ua = '') {
  const s = String(ua);
  let os = 'Unknown OS';
  if (/Windows NT 10/.test(s)) os = 'Windows';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = 'Unknown browser';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/.test(s)) br = 'Opera';
  else if (/Chrome\//.test(s) && !/Chromium/.test(s)) br = 'Chrome';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Safari\//.test(s) && /Version\//.test(s)) br = 'Safari';
  else if (/curl\//.test(s)) br = 'curl';
  return `${br} on ${os}`;
}

const GEO_ON = process.env.ZOLLTAX_GEO === '1';
const cache = new Map(); // ip → { at, geo }
const TTL = 24 * 60 * 60 * 1000;

function isPrivate(ip) {
  if (!ip) return true;
  const s = ip.replace(/^::ffff:/, '');
  return (
    s === '127.0.0.1' || s === '::1' || s === 'localhost' ||
    /^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s) ||
    /^fe80:/i.test(s) || /^fc|^fd/i.test(s)
  );
}

/** Best-effort { country, city } or null. Never throws. */
export async function lookupGeo(ip) {
  if (!GEO_ON || isPrivate(ip)) return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL) return hit.geo;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    const geo = j.status === 'success' ? { country: j.country || '', city: j.city || '' } : null;
    cache.set(ip, { at: Date.now(), geo });
    return geo;
  } catch {
    cache.set(ip, { at: Date.now(), geo: null });
    return null;
  }
}

export const geoEnabled = () => GEO_ON;
