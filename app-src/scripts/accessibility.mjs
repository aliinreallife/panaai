import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
const base=process.env.TEST_BASE_URL || 'http://localhost:3000';
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const findings=[];
for(const theme of ['light','dark']) {
 for(const route of ['','wallet','purchase','orders','keys','usage','models','docs','settings','support','admin']) {
  await page.goto(`${base}/${route}`,{waitUntil:'networkidle'});await page.waitForSelector('.page-title, .welcome-hero, .analytics-heading');await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('platform-theme',theme);},theme);await page.waitForTimeout(220);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  console.log(`${theme} /${route}: ${result.violations.length} violation types`);
  for(const violation of result.violations) findings.push({route:route||'overview',theme,id:violation.id,impact:violation.impact,nodes:violation.nodes.map(n=>({target:n.target,summary:n.failureSummary}))});
 }
}
await writeFile('/tmp/platform-accessibility.json',JSON.stringify(findings,null,2));
await browser.close();
if(findings.length){console.log(JSON.stringify(findings,null,2));process.exitCode=1;}else console.log('PASS automated WCAG A/AA checks on all customer routes and admin overview in both themes. Manual assistive-technology testing remains a release gate.');
