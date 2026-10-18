// Real Docker + Chromium smoke test. Publishes only to loopback; no customer DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {chromium} = require('/workspace/shared/rea-cli/lib/node_modules/rea-agents/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'airframe-container-'));
const name = 'airframe-verification-'+crypto.randomBytes(5).toString('hex');
const volume = name+'-data';
const env = {...process.env};
for (const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[key];
const docker = (...args) => execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const password = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16);
const verifier = `scrypt$1$${salt.toString('hex')}$${crypto.scryptSync(password,salt,32,{N:16384,r:8,p:1}).toString('hex')}`;
let browser, port, checks=0;
function check(value, message) {assert.ok(value,message); checks++; console.log('PASS',message);}
function run() {
  const settings = path.join(temp,'settings');
  fs.writeFileSync(settings,`AIRFRAME_PUBLIC_URL=http://127.0.0.1:${port}\nAIRFRAME_PASSWORD_HASH=${verifier}\n`,{mode:0o600});
  docker('run','-d','--name',name,'--mount',`type=volume,src=${volume},dst=/data`,'--env-file',settings,'-p',`127.0.0.1:${port}:8080`,'airframe-crm:0.2.0-online');
}
async function ready(url) {
  for (let i=0;i<100;i++) {
    try {if ((await fetch(url+'/api/health')).ok) return;} catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Container did not become ready.');
}
(async()=>{
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  run();
  const url = `http://127.0.0.1:${port}`;
  await ready(url);
  check(docker('exec',name,'id','-u')==='10001','Application container runs as non-root');
  browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading',{name:'A better service day starts here.'}).waitFor();
  await page.locator('#password').fill('wrong');
  await page.getByRole('button',{name:'Sign in to workspace'}).click();
  await page.getByText('Incorrect workspace password.').waitFor();
  await page.setViewportSize({width:320,height:720});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Login works at 320px without page overflow');
  fs.mkdirSync(path.join(root,'docs','screenshots'),{recursive:true});
  await page.screenshot({path:path.join(root,'docs','screenshots','17-online-login-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#password').fill(password);
  await page.getByRole('button',{name:'Sign in to workspace'}).click();
  await page.getByRole('heading',{name:'A little clarity for your day.'}).waitFor();
  check(true,'Browser signs in and loads the real CRM');
  await page.goto(url+'/#customers');
  await page.getByRole('button',{name:'+ Add customer',exact:true}).click();
  for (const [key,value] of Object.entries({name:'Deployment persistence check',email:'test@example.com',phone:'555-0100',address:'San Diego, CA',notes:'Isolated automated deployment test'})) await page.locator(`dialog [name=${key}]`).fill(value);
  const saved = page.waitForResponse(response=>response.url().endsWith('/api/state'));
  await page.getByRole('button',{name:'Save customer',exact:true}).click();
  await (await saved).finished();
  await page.locator('dialog .modal-close').click();
  check((await page.request.get(url+'/api/state').then(r=>r.json())).customers.some(c=>c.name==='Deployment persistence check'),'Browser customer creation persists in the mounted database');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.locator('#password').waitFor();
  check((await page.request.get(url+'/api/state')).status()===401,'Sign out revokes access to customer data');
  docker('rm','-f',name);
  run();
  await ready(url);
  await page.locator('#password').fill(password);
  await page.getByRole('button',{name:'Sign in to workspace'}).click();
  await page.getByRole('heading',{name:'A little clarity for your day.'}).waitFor();
  check((await page.request.get(url+'/api/state').then(r=>r.json())).customers.some(c=>c.name==='Deployment persistence check'),'Removing and recreating the container preserves customer data');
  check((await page.request.get(url+'/api/backup')).ok(),'Authenticated database backup download succeeds');
  await page.setViewportSize({width:320,height:720});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Signed-in mobile overview has no horizontal page overflow');
  check(errors.length===0,'Login, customer workflow and logout have no browser errors');
  console.log(`COMPLETED: ${checks} container/browser checks passed. No public deployment or original data was used.`);
})().catch(error=>{console.error(error); try {execFileSync('docker',['--host=unix:///var/run/docker.sock','logs',name],{env,stdio:'inherit'});} catch {} process.exitCode=1}).finally(async()=>{
  if (browser) await browser.close();
  try {docker('rm','-f',name);} catch {}
  try {docker('volume','rm',volume);} catch {}
  fs.rmSync(temp,{recursive:true,force:true});
});
