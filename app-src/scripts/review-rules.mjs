import assert from 'node:assert/strict';
import { elevateAdmin } from './admin-auth.mjs';
import sharp from 'sharp';
const root=process.env.TEST_BASE_URL||'http://localhost:3000';let cookie='';
async function call(path,body,form=false){const r=await fetch(root+'/api/v1/'+path,{method:'POST',headers:{...(cookie?{cookie}:{}),...(!form?{'content-type':'application/json'}:{})},body:form?body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};}
const boot=await call('bootstrap',{});assert.equal(boot.status,200);
await elevateAdmin(null,(c,p,b)=>call(p.replace('/api/v1/',''),b));
const quote=await call('quotes',{amountToman:90000});const order=await call('orders',{quoteId:quote.data.id});
const image=await sharp({create:{width:321,height:355,channels:3,background:`#${(Date.now()%0xffffff).toString(16).padStart(6,'0')}`}}).png().toBuffer();const form=new FormData();form.set('file',new Blob([image],{type:'image/png'}),'test.png');form.set('amountToman','90000');form.set('transferredAt',new Date().toISOString());
const receipt=await call(`orders/${order.data.id}/receipt`,form,true);assert.equal(receipt.data.state,'receipt_submitted');
const secret='PRIVATE BANK VERIFICATION NOTE - DO NOT DISPLAY TO CUSTOMER';
const unsafe=await call(`admin/orders/${order.data.id}/reject`,{note:secret});assert.equal(unsafe.status,400);assert.equal(unsafe.data.code,'customer_message_required');
const safe='لطفاً تصویر خواناتری از رسید آزمایشی بارگذاری کنید.';
const rejected=await call(`admin/orders/${order.data.id}/reject`,{note:secret,reasonCode:'unclear_receipt',customerMessage:safe});assert.equal(rejected.status,200);assert.equal(rejected.data.state,'rejected');assert.equal(rejected.data.reviewNote,safe);assert.ok(!rejected.data.reviewNote.includes(secret));
const approved=await call(`admin/orders/${order.data.id}/approve`,{note:secret,bankVerified:true,bankReference:'TEST',confirmedIrr:order.data.amountIrr});assert.equal(approved.status,409);assert.equal(approved.data.code,'invalid_transition');
console.log('PASS customer-safe rejection, mandatory reason and no grant after rejection');
