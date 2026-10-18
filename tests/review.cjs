const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('/workspace/shared/rea-cli/lib/node_modules/rea-agents/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync('/tmp/airframe-review-');
const url='http://127.0.0.1:8084';
let server,browser,count=0;
const pass=message=>{count++;console.log('PASS '+message)};
async function state(){return fetch(url+'/api/state').then(r=>r.json())}
async function save(page,label){const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/'));const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/state'));await page.getByRole('button',{name:label,exact:true}).click();const r=await response;assert.ok(r.ok(),await r.text());await(await refreshed).finished();await page.waitForTimeout(80);}
async function nav(page,name){await page.goto(url+'/#'+name);await page.locator(`nav a[data-page=${name}][aria-current=page]`).waitFor();}
(async()=>{
 server=spawn('python',[root+'/server.py','--port','8084'],{env:{...process.env,HVAC_DB:temp+'/crm.sqlite3'},stdio:['ignore','ignore','pipe']});let log='';server.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{await state();break}catch{}if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,80));}
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await nav(page,'estimates');await page.locator('tr[data-act=estimate][data-id="5"]').click();await page.getByRole('button',{name:'Edit draft',exact:true}).click();
 assert.equal(await page.locator('dialog [name=unit_price]').inputValue(),'8200.00');
 await page.locator('dialog [name=title]').fill('Heat pump scope — revised');await page.locator('dialog [name=quantity]').fill('2');await page.locator('dialog [name=unit_price]').fill('3000.00');await page.locator('dialog [name=discount]').fill('100.00');await page.locator('dialog [name=tax]').fill('7.25');
 assert.ok((await page.locator('.estimate-preview').innerText()).includes('$6,327.75'));
 await save(page,'Save estimate');let s=await state();assert.equal(s.quotes.length,5);assert.equal(s.quotes.find(q=>q.id===5).total,632775);pass('Editing a draft preserves its identity, items and exact tax total');
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await nav(page,'settings');await page.locator('main [name=company]').fill('Morning Ready HVAC');await save(page,'Save settings');assert.equal(await page.locator('.workspace strong').innerText(),'Morning Ready HVAC');await nav(page,'overview');assert.ok((await page.locator('main .eyebrow').first().innerText()).includes('MORNING READY HVAC'));pass('Company branding updates in settings, navigation and the dashboard');
 await nav(page,'customers');const row=page.locator('tr[data-act=customer][data-id="1"]');await row.focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Olivia Bennett',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);pass('Customer records and dialogs work with keyboard navigation');
 await nav(page,'invoices');await page.locator('tr[data-act=invoice][data-id="1"]').click();const pdf=root+'/docs/review-invoice.pdf';await page.pdf({path:pdf,format:'Letter',printBackground:true});const text=execFileSync('pdftotext',[pdf,'-'],{encoding:'utf8'});assert.ok(text.includes('Morning Ready HVAC')&&text.includes('165.00')&&text.includes('INVOICE'));assert.ok(!text.includes('Good service starts'));pass('Printable invoice PDF contains the company, invoice and correct amount');await page.keyboard.press('Escape');
 await nav(page,'settings');const downloaded=page.waitForEvent('download');await page.getByRole('link',{name:'Download workspace backup'}).click();const download=await downloaded;await download.saveAs(temp+'/download.sqlite3');assert.ok(fs.readFileSync(temp+'/download.sqlite3').subarray(0,15).toString()==='SQLite format 3');pass('Settings download button exports a real SQLite workspace backup');
 const routes=['overview','dispatch','customers','requests','estimates','invoices','agreements','equipment','pricebook','team','timesheets','expenses','inventory','tasks','reports','settings'];
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:width<600?844:1050});
  for(const route of routes){await nav(page,route);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false,`${route} overflows at width ${width}`);}
  pass(`All 16 screens fit a ${width}px viewport without page overflow`);
 }
 // Check all create forms on a narrow phone, including the price-book selector.
 await page.setViewportSize({width:320,height:844});
 for(const [route,button] of [['customers','+ Add customer'],['requests','+ New request'],['estimates','+ New estimate'],['dispatch','+ Schedule visit'],['agreements','+ Add maintenance plan'],['equipment','+ Add equipment'],['pricebook','+ Add service'],['team','+ Add technician'],['timesheets','+ Record work time'],['expenses','+ Record expense'],['inventory','+ Add stock item'],['tasks','+ Add task']]){
  await nav(page,route);await page.getByRole('button',{name:button,exact:true}).click();await page.locator('dialog[open]').waitFor();
  const overflow=await page.locator('dialog').evaluate(d=>d.scrollWidth>d.clientWidth+1);assert.equal(overflow,false,`${route} dialog overflows on a small phone`);await page.keyboard.press('Escape');
 }
 pass('All 12 create dialogs fit a 320px phone');
 const realState=await state();const empty=Object.fromEntries(Object.entries(realState).map(([k,v])=>[k,Array.isArray(v)&&k!=='settings'?[]:v]));
 await page.route('**/api/state',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(empty)}));
 for(const route of routes){await page.goto(url+'/#'+route);await page.reload();await page.locator(`nav a[data-page=${route}][aria-current=page]`).waitFor();}
 assert.equal(errors.length,0,errors.join('\n'));pass('All 16 empty-state screens render without JavaScript errors');
 console.log(`COMPLETED: ${count} UI acceptance groups passed, including 64 responsive screen checks and 12 create dialogs.`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server&&server.exitCode===null)server.kill('SIGTERM')});
