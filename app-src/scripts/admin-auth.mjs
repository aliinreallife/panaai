import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
const b32 = s => { const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits=0,v=0; const out=[]; for (const c of s) { v=(v<<5)|A.indexOf(c); bits+=5; if (bits>=8) { out.push((v>>>(bits-8))&255); bits-=8; } } return Buffer.from(out); };
export const totpAt = (secret, ms) => { const m=Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(ms/30000))); const d=createHmac('sha1',b32(secret)).update(m).digest(); const o=d[d.length-1]&15; return String((((d[o]&0x7f)<<24)|(d[o+1]<<16)|(d[o+2]<<8)|d[o+3])%1e6).padStart(6,'0'); };
/** Admin login = demo OTP (phone) + real TOTP; returns the TOTP secret. */
export async function elevateAdmin(client, callFn) {
  const otp = await callFn(client,'/api/v1/auth/otp/request',{phone:'09120000000'}); assert.equal(otp.status,200,JSON.stringify(otp.data));
  assert.equal((await callFn(client,'/api/v1/auth/otp/verify',{challengeId:otp.data.challengeId,code:otp.data.demoCode})).status,200);
  const enroll = await callFn(client,'/api/v1/admin/mfa/enroll',{}); assert.equal(enroll.status,200,JSON.stringify(enroll.data));
  assert.equal((await callFn(client,'/api/v1/admin/mfa/confirm',{code:totpAt(enroll.data.secret,Date.now())})).status,200);
  const elevated = await callFn(client,'/api/v1/admin/mfa/elevate',{code:totpAt(enroll.data.secret,Date.now()+30000)}); assert.equal(elevated.status,200,JSON.stringify(elevated.data));
  return { secret: enroll.data.secret, otp };
}
