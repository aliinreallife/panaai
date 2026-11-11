import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const proxy=process.env.TEST_PROXY_BASE_URL;
let base=process.env.TEST_BASE_URL;
let fixture, directory, browser;
try {
 if(proxy){
  directory=await mkdtemp(join(tmpdir(),'pana-https-test-'));
  const keyPath=join(directory,'fixture.key'), certPath=join(directory,'fixture.crt');
  // An ephemeral self-signed test certificate, never an application credential.
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore'});
  fixture=https.createServer({key:await readFile(keyPath),cert:await readFile(certPath)},async(request,response)=>{
   try {
    const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const headers={...request.headers,host:new URL(proxy).host,'accept-encoding':'identity'};
    if(headers.origin)headers.origin=proxy;
    const body=Buffer.concat(chunks);
    const upstream=await fetch(`${proxy}${request.url}`,{method:request.method,headers,body:body.length?body:undefined,redirect:'manual'});
    const responseHeaders=Object.fromEntries(upstream.headers.entries());
    delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];delete responseHeaders['transfer-encoding'];delete responseHeaders['set-cookie'];
    response.writeHead(upstream.status,{...responseHeaders,...(upstream.headers.getSetCookie().length?{'set-cookie':upstream.headers.getSetCookie()}:{})});
    response.end(Buffer.from(await upstream.arrayBuffer()));
   }catch{response.writeHead(502,{'content-type':'text/plain'});response.end('Local HTTPS test fixture transport failed.');}
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  base=`https://127.0.0.1:${fixture.address().port}`;
  console.log('INFO using a real, ephemeral local HTTPS fixture; the external hosting access gateway is not part of this test.');
 }
 if(!base?.startsWith('https://'))throw new Error('Set TEST_BASE_URL to a reachable HTTPS preview, or set TEST_PROXY_BASE_URL=http://localhost:3000 for the local HTTPS fixture.');
 browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox',...(proxy?['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,PrivateNetworkAccessSendPreflights']:[])]});
 const context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:!!proxy});
 const page=await context.newPage();
 page.on('requestfailed', request => console.log('Fixture network failure:', request.url(), request.failure()?.errorText));
 let sessionHeader='';
 page.on('response',async response=>{if(response.url()===`${base}/api/v1/bootstrap`){sessionHeader=(await response.allHeaders())['set-cookie']||'';}});
 await page.route('https://preview-shell.example/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><title>Sandbox embed test</title></head><body style="margin:0"><iframe title="Persian platform preview" src="${base}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`}));
 await page.goto('https://preview-shell.example/',{waitUntil:'networkidle'});
 const frame=page.frameLocator('iframe');
 await frame.locator('.balance-card').waitFor({timeout:30000});
 for(const flag of [/httponly/i,/; secure/i,/samesite=none/i,/partitioned/i])assert.ok(flag.test(sessionHeader),'Secure partitioned session flag is missing.');
 console.log('PASS application session is HttpOnly, Secure, SameSite=None and Partitioned');
 await frame.getByRole('button',{name:'ساخت کلید API',exact:true}).click();
 await frame.getByPlaceholder('مثلاً پروژه اصلی یا محیط توسعه').fill('کلید پیش‌نمایش تعبیه‌شده');
 await frame.getByRole('button',{name:'ساخت کلید',exact:true}).click();
 await frame.getByRole('button',{name:'کلید را ذخیره کردم'}).waitFor({timeout:30000});
 await frame.getByRole('button',{name:'کلید را ذخیره کردم'}).click();
 const cookies=await context.cookies();
 const session=cookies.find(c=>c.name==='platform_session'&&c.domain===new URL(base).hostname);
 assert.ok(session?.httpOnly&&session?.secure&&session?.partitionKey,JSON.stringify(cookies.map(c=>({name:c.name,domain:c.domain,secure:c.secure,httpOnly:c.httpOnly,partitionKey:c.partitionKey}))));
 console.log('PASS real third-party HTTPS iframe retains an authenticated, partition-isolated browser session');
} finally {
 if(browser)await browser.close();
 if(fixture){fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
 if(directory)await rm(directory,{recursive:true,force:true});
}
