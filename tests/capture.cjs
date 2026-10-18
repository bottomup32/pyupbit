// Capture the running sample workspace without modifying its data.
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('/workspace/shared/rea-cli/lib/node_modules/rea-agents/node_modules/playwright-core');
const root=path.resolve(__dirname,'..');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});const dir=path.join(root,'docs','screenshots');fs.mkdirSync(dir,{recursive:true});
 const routes=['overview','dispatch','customers','requests','estimates','invoices','agreements','equipment','pricebook','team','timesheets','expenses','inventory','tasks','reports','settings'];
 for(let i=0;i<routes.length;i++){const route=routes[i];await page.goto('http://127.0.0.1:8080/#'+route);await page.locator(`nav a[data-page=${route}][aria-current=page]`).waitFor();await page.screenshot({path:path.join(dir,`${String(i+1).padStart(2,'0')}-${route}.png`),fullPage:true});}
 await page.goto('http://127.0.0.1:8080/#overview');await page.locator('main h1').waitFor();await page.screenshot({path:root+'/docs/overview.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:root+'/docs/mobile.png',fullPage:true});
 console.log('Captured 16 desktop screens and the mobile overview.');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
