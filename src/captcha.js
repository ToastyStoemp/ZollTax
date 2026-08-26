/**
 * Zero-dep proof-of-work CAPTCHA for account creation. The server hands out a
 * signed challenge; the browser must find a `solution` whose
 * sha256(nonce:solution) starts with N zero bits before it can submit. This
 * costs a real device a fraction of a second but makes mass automated signups
 * expensive — no third-party service, script, or account needed.
 *
 * (Swappable later for Cloudflare Turnstile if stronger bot detection is wanted.)
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DIFFICULTY = Math.min(24, Math.max(8, Number(process.env.ZOLLTAX_CAPTCHA_BITS || 18)));
const TTL_MS = 10 * 60 * 1000;

function secret() {
  return process.env.ZOLLTAX_SESSION_SECRET || process.env.ZOLLTAX_MASTER_KEY || 'zolltax-captcha-secret';
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload) => b64url(createHmac('sha256', secret()).update(payload).digest());

/** Issue a fresh challenge. Returns what the browser needs to solve + submit. */
export function issueChallenge() {
  const nonce = randomBytes(16).toString('hex');
  const exp = Date.now() + TTL_MS;
  const payload = b64url(JSON.stringify({ nonce, difficulty: DIFFICULTY, exp }));
  return { token: `${payload}.${sign(payload)}`, nonce, difficulty: DIFFICULTY };
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let m = 7; m >= 0; m--) {
      if ((byte >> m) & 1) return bits;
      bits += 1;
    }
    break;
  }
  return bits;
}

const usedNonces = new Map(); // nonce → exp (single-use)
setInterval(() => {
  const now = Date.now();
  for (const [n, e] of usedNonces) if (now >= e) usedNonces.delete(n);
}, 5 * 60 * 1000).unref?.();

/** Verify a solved challenge. Returns { ok } or { ok:false, error }. */
export function verifyChallenge(token, solution) {
  if (!token || solution == null) return { ok: false, error: 'Missing CAPTCHA.' };
  const dot = String(token).lastIndexOf('.');
  if (dot < 1) return { ok: false, error: 'Malformed CAPTCHA.' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, error: 'Invalid CAPTCHA.' };
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return { ok: false, error: 'Malformed CAPTCHA.' };
  }
  if (!data.exp || Date.now() > data.exp) return { ok: false, error: 'CAPTCHA expired — please retry.' };
  if (usedNonces.has(data.nonce)) return { ok: false, error: 'CAPTCHA already used.' };
  const digest = createHash('sha256').update(`${data.nonce}:${solution}`).digest();
  if (leadingZeroBits(digest) < data.difficulty) return { ok: false, error: 'CAPTCHA not solved.' };
  usedNonces.set(data.nonce, data.exp);
  return { ok: true };
}

/**
 * Browser-side solver, served inline so the page stays self-contained. Uses a
 * synchronous SHA-256 (WebCrypto is async-only and far too slow for a PoW loop)
 * that matches node's crypto output byte-for-byte.
 */
export const SOLVER_JS = `
var _K256=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function _sha256bytes(msg){
  function rr(x,n){return (x>>>n)|(x<<(32-n));}
  var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var l=msg.length,bl=((l+8>>6)+1)<<6,bytes=new Uint8Array(bl);
  bytes.set(msg);bytes[l]=0x80;
  var bitLen=l*8;
  bytes[bl-4]=(bitLen>>>24)&255;bytes[bl-3]=(bitLen>>>16)&255;bytes[bl-2]=(bitLen>>>8)&255;bytes[bl-1]=bitLen&255;
  var w=new Int32Array(64);
  for(var o=0;o<bl;o+=64){
    for(var i=0;i<16;i++)w[i]=(bytes[o+i*4]<<24)|(bytes[o+i*4+1]<<16)|(bytes[o+i*4+2]<<8)|bytes[o+i*4+3];
    for(i=16;i<64;i++){var s0=rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3);var s1=rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0;}
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(i=0;i<64;i++){
      var S1=rr(e,6)^rr(e,11)^rr(e,25);var ch=(e&f)^(~e&g);var t1=(h+S1+ch+_K256[i]+w[i])|0;
      var S0=rr(a,2)^rr(a,13)^rr(a,22);var mj=(a&b)^(a&c)^(b&c);var t2=(S0+mj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
  }
  var out=new Uint8Array(32);
  for(i=0;i<8;i++){out[i*4]=(H[i]>>>24)&255;out[i*4+1]=(H[i]>>>16)&255;out[i*4+2]=(H[i]>>>8)&255;out[i*4+3]=H[i]&255;}
  return out;
}
function _leadingZeros(bytes){var bits=0;for(var k=0;k<bytes.length;k++){var b=bytes[k];if(b===0){bits+=8;continue;}for(var m=7;m>=0;m--){if((b>>m)&1)return bits;bits++;}break;}return bits;}
function solveCaptcha(nonce,difficulty,onProgress){
  var enc=new TextEncoder();
  for(var i=0;;i++){
    if(_leadingZeros(_sha256bytes(enc.encode(nonce+':'+i)))>=difficulty)return String(i);
    if(onProgress&&(i&8191)===0)onProgress(i);
  }
}`;
