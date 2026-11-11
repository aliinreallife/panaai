import assert from 'node:assert/strict';
import { elevateAdmin } from './admin-auth.mjs';
const root=process.env.TEST_BASE_URL||'http://localhost:3000';let cookie='';async function api(path,body){const r=await fetch(root+'/api/v1/'+path,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
await api('bootstrap',{});
await elevateAdmin(null,(c,p,b)=>api(p.replace('/api/v1/',''),b));const secret='PRIVATE_BANK_NOTE_MUST_STAY_ADMIN_ONLY';
const manual=await api('admin/provider/reconcile',{balance:1234567,reason:secret});assert.equal(manual.status,200);
const publicData=await api('data');assert.equal(publicData.status,200);assert.ok(!JSON.stringify(publicData.data.audit).includes(secret));assert.ok(!JSON.stringify(publicData.data.audit).includes('1234567'));
const privateAudit=await api('admin/audit');assert.equal(privateAudit.status,200);assert.ok(JSON.stringify(privateAudit.data).includes(secret));
console.log('PASS customer data excludes private notes while sandbox admin audit retains them');
