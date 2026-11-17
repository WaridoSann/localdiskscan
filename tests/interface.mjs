import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const webRoot = path.join(root, 'local_disk_analyzer', 'web');
const output = path.join(root, 'test-results');
await fs.mkdir(output, {recursive:true});
const server = http.createServer(async (req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/assets\//,'');
  if (name.includes('..')) { res.writeHead(400); res.end(); return; }
  try {
    const data = await fs.readFile(path.join(webRoot,name));
    const ext = path.extname(name);
    res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[ext] || 'text/plain');
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(8765,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
const context = await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
const errors = [], resourceLogs = [], calls = [], rootPath = 'C:\\', GiB = 1024**3;
let state = {state:'idle',scan:0,root:'',files:0,folders:0,bytes:0,elapsed:0,volume:null,errors:[],error_count:0,skipped:0};
let polls=0,failScan=false,forceAuth=false;
const fileRows = [
  ['backup-projets-2026.zip',28.4,'archive', 'Users\\Alex\\Documents'],
  ['The Last of Us Part I.iso',23.7,'archive','Users\\Alex\\Downloads'],
  ['vacances-japon-final.mov',18.2,'video','Users\\Alex\\Videos'],
  ['machine-dev.vhdx',15.6,'archive','Users\\Alex\\Virtual Machines'],
  ['rushes-weekend.mp4',12.3,'video','Users\\Alex\\Videos'],
  ['photos-archives-2025.zip',8.7,'archive','Users\\Alex\\Pictures'],
  ['presentation-studio.psd',4.2,'image','Users\\Alex\\Documents'],
  ['installation-windows.iso',3.8,'archive','Users\\Alex\\Downloads'],
  ['textures-environnement.zip',2.1,'archive','Users\\Alex\\Documents'],
].map(([name,size,kind,parent],i)=>({id:100+i,name,size:Math.round(size*GiB),folder:false,path:rootPath+parent+'\\'+name}));
const folders = [
 {id:2,name:'Users',size:276.4*GiB,folder:true,path:'C:\\Users'},
 {id:3,name:'Games',size:142.7*GiB,folder:true,path:'C:\\Games'},
 {id:4,name:'Program Files',size:98.3*GiB,folder:true,path:'C:\\Program Files'},
 {id:5,name:'Windows',size:37.2*GiB,folder:true,path:'C:\\Windows',partial:true},
 {id:6,name:'ProgramData',size:18.6*GiB,folder:true,path:'C:\\ProgramData'},
 {id:7,name:'pagefile.sys',size:8*GiB,folder:false,path:'C:\\pagefile.sys'},
];
const finished = () => ({...state,state:'completed',scan:1,root:rootPath,files:183204,folders:14872,bytes:582.3*GiB,elapsed:48,volume:{total:953.9*GiB,used:681.7*GiB,free:272.2*GiB},errors:[],error_count:0,skipped:13});
await context.route('**/api/**',async route=>{
 const request=route.request(), url=new URL(request.url()), p=url.pathname.replace('/api','');
 calls.push({path:p,method:request.method(),body:request.postDataJSON(),auth:request.headers().authorization});
 if(forceAuth){await route.fulfill({status:401,json:{detail:'Unauthorized'}});return;}
 let data;
 if(p==='/status'){
  if(state.state==='scanning' && ++polls>=2) state=finished();
  data=state;
 }else if(p==='/scan'){
  assert.equal(request.method(),'POST');assert.deepEqual(request.postDataJSON(),{path:rootPath});
  if(failScan){await route.fulfill({status:400,json:{detail:'Accès au lecteur refusé.'}});return;}
  polls=0;state={...finished(),state:'scanning',files:42631,folders:3104,bytes:98.4*GiB,elapsed:8};data=state;
 }else if(p==='/cancel'){state={...state,state:'cancelled'};data=state;}
 else if(p.match(/\/largest$/)){data={total:250,file_count:183204,rows:url.searchParams.get('page')==='1'?fileRows.slice(4):fileRows,chart:fileRows,other:48.3*GiB};}
 else if(p.match(/\/folders\/1$/)){data={directory:{id:1,name:rootPath,size:582.3*GiB},total:folders.length,rows:folders,chart:folders,other:1.1*GiB,trail:[{id:1,name:rootPath}]};}
 else if(p.match(/\/folders\/2$/)){data={directory:{id:2,name:'Users',size:276.4*GiB},total:2,rows:fileRows.slice(0,2),chart:fileRows.slice(0,2),trail:[{id:1,name:rootPath},{id:2,name:'Users'}]};}
 else if(p.match(/\/search$/)){const rows=url.searchParams.get('q')==='absent'?[]:fileRows.filter(x=>x.name.endsWith('.zip'));data={total:rows.length,rows,chart:rows};}
 else if(p.match(/\/items\/\d+\/open$/)){data={ok:true};}
 else if(p==='/quit'){data={ok:true};}
 else throw new Error('Unexpected API request '+p);
 await route.fulfill({json:data});
});
const page=await context.newPage();
page.on('pageerror',error=>errors.push(String(error)));
page.on('console',msg=>{
 if(msg.type()!=='error')return;
 const url=msg.location().url;
 if(/Failed to load resource:.*(400|401)/.test(msg.text()) && /\/api\/(scan|status)$/.test(url))resourceLogs.push({url,text:msg.text()});
 else errors.push(msg.text());
});
const expectText=async(selector,text)=>{await page.waitForFunction(([s,t])=>document.querySelector(s)?.textContent.includes(t),[selector,text]);};
try{
 await page.goto('http://127.0.0.1:8765/#test-session-token');
 await page.waitForFunction(()=>!document.getElementById('scan').disabled);
 assert.equal(await page.locator('#location,#drives,#browse').count(),0);
 assert.equal(new URL(page.url()).hash,'');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('disk-session')),'test-session-token');
 assert.equal(calls.filter(x=>x.path==='/scan').length,0,'No automatic scan');
 assert.equal(await page.locator('#used-percent').textContent(),'—','No invented disk data');
 await page.screenshot({path:path.join(output,'01-accueil.png'),fullPage:true});
 await page.locator('#help').click();assert.equal(await page.locator('#help-dialog').evaluate(x=>x.open),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#help-dialog').evaluate(x=>x.open),false);
 await page.locator('#theme').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.reload();await page.waitForFunction(()=>!document.getElementById('scan').disabled);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.locator('#theme').click();
 await page.locator('#scan').click();await expectText('#state-label','Analyse en cours');
 assert.equal(await page.locator('#scan').isDisabled(),true);
 assert.equal(await page.locator('#cancel').isVisible(),true);
 await page.screenshot({path:path.join(output,'02-scan.png'),fullPage:true});
 await expectText('#state-label','Analyse terminée');await page.waitForSelector('#rows tr');
 assert.equal(await page.locator('#rows tr').count(),9);
 assert.equal(await page.locator('#used-percent').textContent(),'71%');
 assert.equal(await page.locator('#pagination').isVisible(),true);
 await page.screenshot({path:path.join(output,'03-fichiers.png'),fullPage:true});
 await page.locator('#next').click();await expectText('#page-label','Page 2 sur 3');
 assert.equal(await page.locator('#rows tr').count(),5);
 await page.locator('#previous').click();await expectText('#page-label','Page 1 sur 3');
 await page.locator('#rows .open').first().click();assert.ok(calls.some(x=>/\/items\/100\/open$/.test(x.path)));
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.locator('#rows .copy').first().click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),fileRows[0].path);
 await page.locator('#explore').click();await expectText('#result-title',rootPath);
 assert.equal(await page.locator('#rows tr').count(),6);
 assert.equal(await page.locator('#path-heading').isVisible(),false);
 await page.screenshot({path:path.join(output,'04-dossiers.png'),fullPage:true});
 await page.locator('#treemap').click({position:{x:20,y:20}});await expectText('#result-title','Users');
 assert.equal(await page.locator('#trail button').count(),2);
 await page.locator('#trail button').first().click();await expectText('#result-title',rootPath);
 await page.locator('#rows button').filter({hasText:'Users'}).click();await expectText('#result-title','Users');
 await page.locator('#trail button').first().click();await expectText('#result-title',rootPath);
 await page.locator('#query').fill('absent');await page.locator('#search').click();await expectText('#result-title','Résultats de recherche');
 assert.equal(await page.locator('#no-rows').isVisible(),true);
 await page.locator('#query').fill('backup');await page.locator('#extension').fill('.zip');await page.locator('#search').click();await expectText('#result-caption','3 résultats');
 assert.ok(calls.some(x=>x.path.endsWith('/search')));
 await page.locator('#clear').click();await expectText('#result-title','Ce qui pèse le plus');
 await page.keyboard.press('/');assert.equal(await page.locator('#query').evaluate(x=>x===document.activeElement),true);
 // A filename is always text, never executable markup.
 fileRows[0].name='<img src=x onerror="window.injected=true">.zip';
 await page.locator('#largest').click();await expectText('#rows','<img src=x');
 assert.equal(await page.locator('#rows img').count(),0);
 fileRows[0].name='backup-projets-2026.zip';
 await page.locator('#largest').click();await expectText('#rows','backup-projets');
 // Responsive layouts, in both themes, must not overflow the viewport.
 for(const width of [1920,1440,1280,1024,768,540,390,320]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow at '+width);
 }
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(output,'05-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1050});
 await page.locator('#theme').click();
 await page.screenshot({path:path.join(output,'06-theme-clair.png'),fullPage:true});
 await page.locator('#theme').click();
 // Scan submission failure keeps existing results, exposes the error, unlocks Scan.
 failScan=true;await page.locator('#scan').click();await expectText('#notice','Accès au lecteur refusé');
 assert.equal(await page.locator('#scan').isDisabled(),false);failScan=false;
 // Cancellation keeps the partial scan available.
 await page.locator('#scan').click();await expectText('#state-label','Analyse en cours');
 await page.locator('#cancel').click();await expectText('#state-label','Analyse arrêtée');await page.waitForSelector('#rows tr');
 assert.equal(await page.locator('#scan').isDisabled(),false);
 // Error samples and partial state.
 state={...finished(),state:'partial',error_count:2,errors:[{path:'C:\\System Volume Information',message:'Accès refusé'}]};
 await page.reload();await expectText('#state-label','Avec quelques réserves');
 assert.equal(await page.locator('#warnings').isVisible(),true);await page.locator('#warning-summary').click();await expectText('#errors','Accès refusé');
 // An expired token does not expose enabled scan controls.
 forceAuth=true;await page.reload();await expectText('#notice','Relancez LocalDiskAnalyzer.exe');assert.equal(await page.locator('#scan').isDisabled(),true);
 forceAuth=false;state=finished();await page.reload();await page.waitForSelector('#rows tr');
 await page.locator('#quit').click();await expectText('#main','Localdisk est fermé');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('disk-session')),null);
 assert.ok(calls.every(x=>x.auth==='Bearer test-session-token'));
 assert.equal(calls.filter(x=>x.path==='/browse'||x.path==='/locations').length,0);
 assert.deepEqual(errors,[],'Browser console/page errors');
 assert.equal(resourceLogs.length,2,'Exactly the two intentional API error responses');
 // Pure geometry checks, including zero-sized and highly skewed data.
 const {layout}=await import(pathToFileURL(path.join(webRoot,'treemap.js')));
 for(const sizes of [[],[0],[1],[100,40,20,0],[1e12,1,1,1],[10,9,8,7,6,5,4,3,2,1]]){
  const tiles=layout(sizes.map((size,id)=>({id,size})),300,300);
  for(const tile of tiles)for(const key of ['x','y','width','height'])assert.ok(Number.isFinite(tile[key])&&tile[key]>=-1e-6,JSON.stringify(tile));
  if(sizes.some(x=>x>0))assert.ok(Math.abs(tiles.reduce((sum,t)=>sum+t.width*t.height,0)-90000)<1e-3);
 }
 const result={passed:true,checks:['C:\\ fixé sans sélecteur ni scan automatique','jeton de session et authentification','scan et polling','annulation et résultats partiels','pagination','navigation et fil d’Ariane','recherche et filtres','ouverture emplacement','noms de fichier échappés','thème clair persistant','aide et clavier','8 largeurs sans débordement','erreur du scan et session expirée','fermeture et suppression du jeton','géométrie treemap'],apiCalls:calls.length,browserErrors:errors};
 await fs.writeFile(path.join(output,'resultats.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
