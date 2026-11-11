// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) and RFC 4648 base32. Node crypto only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buffer: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid_base32");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export function hotp(secret: Buffer, counter: number, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}
export const totpStep = (time = Date.now(), period = 30) => Math.floor(time / 1000 / period);
export const totp = (secretBase32: string, time = Date.now()) => hotp(base32Decode(secretBase32), totpStep(time));
/** Returns the matched step (±1 window for clock drift) or null. Callers must reject steps <= the last accepted step. */
export function verifyTotp(secretBase32: string, code: string, time = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32); const now = totpStep(time);
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(secret, now + drift));
    if (timingSafeEqual(expected, Buffer.from(code))) return now + drift;
  }
  return null;
}
export const otpauthUri = (secret: string, account: string, issuer = "PanaAI Admin") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
