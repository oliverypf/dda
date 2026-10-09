// Independent UI regression harness: real built frontend, isolated browser storage,
// and a simulated native bridge. Never opens the user's app or runtime database.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(process.env.HMCODEX_UI_DIST ?? fileURLToPath(new URL('../dist/',import.meta.url)));
const output=resolve(process.env.HMCODEX_UI_ARTIFACTS ?? fileURLToPath(new URL('../../.codex-tmp/project-archive-ui/',import.meta.url)));
await mkdir(output,{recursive:true});
const types={'.js':'application/javascript','.css':'text/css','.html':'text/html'};
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;const path=resolve(root,pathname==='/'?'index.html':pathname.slice(1));if(!path.startsWith(root+sep))throw Error('outside root');res.setHeader('Content-Type',types[extname(path)]??'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end()}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url='http://127.0.0.1:'+server.address().port;
async function installFixture(context) {
  await context.addInitScript(() => {
    const projects = [{ id:'project-a', name:'项目甲', path:'C:/fixture/A', paths:['C:/fixture/A'], lastUsedAtMs:2 },
      { id:'project-b', name:'项目乙', path:'C:/fixture/B', paths:['C:/fixture/B'], lastUsedAtMs:1 }];
    if (!localStorage.getItem('supervisor.seeded')) {
      localStorage.setItem('hmcodex.projects.v1', JSON.stringify(projects));
      localStorage.setItem('hmcodex.projectOrder.v1', JSON.stringify(['project-a','project-b']));
      localStorage.setItem('hmcodex.threadArchives.v1', JSON.stringify({'a-archived':1}));
      localStorage.setItem('supervisor.seeded','1');
    }
    const threads = [{id:'a-live',title:'甲的普通会话',cwd:'C:/fixture/A',turnCount:2,updatedAtMs:2},
      {id:'a-archived',title:'甲的单独归档会话',cwd:'C:/fixture/A',turnCount:1,updatedAtMs:1},
      {id:'b-live',title:'乙的会话',cwd:'C:/fixture/B',turnCount:1,updatedAtMs:1},
      {id:'c-live',title:'自动发现项目的会话',cwd:'C:/fixture/C',turnCount:1,updatedAtMs:1}];
    const callbacks = new Map(), listeners = new Map(); let id=0;
    window.__supervisor = {threads, calls:[], listeners, callbacks};
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { callbacks.set(++id,callback); return id; },
      unregisterCallback: key => callbacks.delete(key),
      invoke: async (cmd,args={}) => {
        window.__supervisor.calls.push({cmd,args});
        if(cmd === 'plugin:event|listen') { listeners.set(args.event,args.handler); return ++id; }
        if(cmd === 'runtime_snapshot') return {platform:'WINDOWS',version:'0.1.0',readOnly:true,workspaceRead:true,commandExecution:false,networkSideEffects:false,runtimeReady:true,releaseChannel:'WINDOWS_PHASE1_READ_ONLY'};
        if(cmd === 'runtime_dashboard') return {summaryOnly:true,threads};
        if(cmd === 'default_workspace') return {rootPath:'C:/fixture/A',rootLabel:'A'};
        if(cmd === 'set_workspace') return {rootPath:args.path,rootLabel:args.path.split('/').pop()};
        if(cmd === 'list_workspace') return [];
        if(cmd === 'list_threads') return {threads};
        if(cmd === 'get_thread') return {thread:{...threads.find(t=>t.id===args.threadId),turns:[]}};
        if(cmd === 'list_thread_events') return {threadId:args.threadId,thread:threads.find(t=>t.id===args.threadId),events:[],hasMore:false,limit:args.limit??100};
        if(cmd === 'reconcile_runtime_state') return {ok:true,reconciled:0,execution:{reconciled:0,records:[]},roles:{reconciled:0,contexts:[]}};
        if(cmd === 'runtime_process_status') return {running:false,healthy:true};
        if(cmd === 'run_model_task') return new Promise(resolve=>{window.__supervisor.finishTask=resolve;});
        if(cmd === 'model_config') return undefined;
        if(cmd === 'context_sidecar_status' || cmd === 'dream_maintenance_status') return undefined;
        return {};
      }
    };
  });
}

const browser=await chromium.launch({channel:process.env.HMCODEX_BROWSER_CHANNEL??'msedge',headless:true}); const results=[];
const check=(name,pass,detail)=>results.push({name,pass,detail});
try{
const context=await browser.newContext({viewport:{width:1440,height:1000}});await installFixture(context);
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(url);await page.locator('[data-project-group="project-a"]').waitFor();
const centers=await page.locator('[data-project-group="project-a"] .project-header-row').evaluate(el=>Array.from(el.children).map(x=>{const r=x.getBoundingClientRect();return r.y+r.height/2}));
check('project header controls share one row',Math.max(...centers)-Math.min(...centers)<3,centers);
await page.locator('[data-action="archive-project"][data-project-id="project-a"]').click();
check('archive hides project',await page.locator('[data-project-group="project-a"]').count()===0);
check('archive clears current workspace',(await page.locator('.workspace-identity strong').innerText())!=='项目甲');
const beforeReload=await page.evaluate(()=>({catalog:localStorage.getItem('hmcodex.projects.v1'),threads:localStorage.getItem('hmcodex.threadArchives.v1'),order:localStorage.getItem('hmcodex.projectOrder.v1')}));
check('catalog and thread archive retained',JSON.parse(beforeReload.catalog).length===2&&JSON.parse(beforeReload.threads)['a-archived']===1);
await page.reload();await page.locator('.workspace-identity strong').waitFor();await page.waitForTimeout(300);
check('reload keeps archived project hidden',await page.locator('[data-project-group="project-a"]').count()===0);
check('reload does not select archived default',(await page.locator('.workspace-identity strong').innerText())!=='项目甲');
await page.locator('[data-action="open-settings"]').first().click();
await page.locator('[data-action="settings-section"]').filter({hasText:'已归档'}).click();
await page.locator('[data-settings-dialog] [data-action="restore-project"][data-project-id="project-a"]').click();
await page.locator('.settings-back').click();
check('restored project appears',await page.locator('[data-project-group="project-a"]').count()===1);
check('restored project expanded',await page.locator('[data-project-group="project-a"] [data-thread-id="a-live"]').first().isVisible());
check('individually archived thread stays hidden',await page.locator('[data-project-group="project-a"] [data-thread-id="a-archived"]').count()===0);
check('project order retained',await page.evaluate(x=>localStorage.getItem('hmcodex.projectOrder.v1')===x,beforeReload.order));
const discovered=page.locator('[data-project-group]').filter({has:page.locator('.project-header', {hasText:'C'})});
const discoveredId=await discovered.getAttribute('data-project-group');
await discovered.locator('[data-action="archive-project"]').click();
check('discovered project archive',await page.locator(`[data-project-group=${JSON.stringify(discoveredId)}]`).count()===0);
await page.locator('[data-action="open-settings"]').first().click();
await page.locator('[data-action="settings-section"]').filter({hasText:'已归档'}).click();
await page.locator(`[data-settings-dialog] [data-action="restore-project"][data-project-id=${JSON.stringify(discoveredId)}]`).click();
await page.locator('.settings-back').click();
check('discovered project restore',await page.locator(`[data-project-group=${JSON.stringify(discoveredId)}] [data-thread-id="c-live"]`).first().isVisible());
// Failed local storage persistence must not remove a project.
await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='hmcodex.projectArchives.v1')throw new Error('quota');return window.__setItem.call(this,k,v)}});
await page.locator('[data-action="archive-project"][data-project-id="project-b"]').click();
check('storage failure preserves project',await page.locator('[data-project-group="project-b"]').count()===1);
await page.evaluate(()=>Storage.prototype.setItem=window.__setItem);
// A separate window's archive update must clear an idle selected default.
await page.reload();await page.locator('[data-project-group="project-a"]').waitFor();await page.waitForTimeout(300);
await page.evaluate(()=>{const value=JSON.stringify({'project-a':{name:'项目甲',path:'C:/fixture/A',archivedAtMs:1}});localStorage.setItem('hmcodex.projectArchives.v1',value);dispatchEvent(new StorageEvent('storage',{key:'hmcodex.projectArchives.v1',newValue:value,storageArea:localStorage}));});
check('cross-window archive clears idle workspace',(await page.locator('.workspace-identity strong').innerText())!=='项目甲');
check('no frontend errors',errors.length===0,errors);
await page.screenshot({path:resolve(output,'ui.png')});

const runningContext=await browser.newContext();await installFixture(runningContext);const runPage=await runningContext.newPage();
await runPage.goto(url);await runPage.locator('[data-project-group="project-a"]').waitFor();
await runPage.locator('textarea[name="prompt"]').fill('first');await runPage.locator('textarea[name="prompt"]').press('Enter');
await runPage.waitForFunction(()=>typeof window.__supervisor.finishTask==='function');
check('running project cannot be archived',await runPage.locator('[data-action="archive-project"][data-project-id="project-a"]').isDisabled());
await runPage.evaluate(()=>{const value=JSON.stringify({'project-a':{name:'项目甲',path:'C:/fixture/A',archivedAtMs:1}});localStorage.setItem('hmcodex.projectArchives.v1',value);dispatchEvent(new StorageEvent('storage',{key:'hmcodex.projectArchives.v1',newValue:value}));});
check('cross-window archive does not interrupt running task',await runPage.locator('textarea[name="prompt"]').isDisabled());
await runPage.evaluate(()=>window.__supervisor.finishTask({ok:false,error:'fixture finished'}));
await runPage.waitForFunction(()=>!document.querySelector('textarea[name="prompt"]').disabled);
await runPage.locator('textarea[name="prompt"]').fill('second');await runPage.locator('textarea[name="prompt"]').press('Enter');
await runPage.waitForTimeout(300);
check('archived project cannot start another task',await runPage.evaluate(()=>window.__supervisor.calls.filter(c=>c.cmd==='run_model_task').length===1));
check('blocked archived project explains recovery',(await runPage.locator('body').innerText()).includes('此项目已归档'));
await runningContext.close();
} catch(error){check('test flow completed',false,String(error))}finally{await browser.close();await new Promise(done=>server.close(done))}
writeFileSync(resolve(output,'report.json'),JSON.stringify({backend:'fixture',frontend:root,results},null,2));console.log(JSON.stringify(results,null,2));process.exitCode=results.every(r=>r.pass)?0:1;

