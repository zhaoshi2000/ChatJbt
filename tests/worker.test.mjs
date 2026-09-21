/** Actual v1.2 worker, deterministic Chrome/storage/HTTP adapters. Not a real extension install. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const ID='a'.repeat(32),ORIGIN=`chrome-extension://${ID}/`,TOKEN='b'.repeat(43),VERSION='1.2.0',CONTENT_REVISION='2026-09-21.10';
const ACCOUNT='account-aaaaaaaa',CLIENT='client-aaaaaaaa',C1='conversation-1111',C2='conversation-2222';
const source=['extension/shared.js','extension/lane-core.js','extension/background.js'].map(p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8').replace(/^import .*\n/gm,'').replaceAll('export ','')).join('\n');
const clone=x=>x===undefined?undefined:structuredClone(x);
const event=()=>({handlers:[],addListener(f){this.handlers.push(f);}});
function harness({saved={},session={doubaoSession:'browser-session'},server={}}={}){
 saved.settings??={backendUrl:'http://127.0.0.1:48643',token:TOKEN,enabled:true,accountId:ACCOUNT,accountName:'账号 A'};
 saved.clientId??=CLIENT;
 const tasks=server.tasks??=[C1,C2].map((c,i)=>({id:`task-0000000${i}`,accountId:ACCOUNT,conversationId:c,message:'测试 '+i,state:'queued',provider:'browser',created:Date.now()+i,text:'',lastSeq:0,submitted:false,lease:'lease-'+i,deadline:Date.now()+120000,checkpoint:{}}));
 const conversations=server.conversations??=Object.fromEntries([C1,C2].map(id=>[id,{id,accountId:ACCOUNT,title:id,upstreamUrl:''}]));
 const counters={creates:[],runs:[],requests:[],events:[],uploads:[],downloads:[],resolves:[],discards:[],reloads:[],injections:[],wakeMessages:[],alarms:0,scheduled:[]};
 const tabs=new Map([[10,{id:10,url:'https://chatgpt.com/c/manual',windowId:1,autoDiscardable:true,active:true}]]),pages=new Map();
 const messages=event(),removed=event();
 const makeStorage=obj=>({get:async keys=>keys===null?clone(obj):Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,clone(obj[k])])),set:async patch=>Object.assign(obj,clone(patch)),remove:async key=>{for(const k of Array.isArray(key)?key:[key])delete obj[k];},setAccessLevel:async()=>{}});
 const chrome={storage:{local:makeStorage(saved),session:makeStorage(session)},runtime:{id:ID,getURL:p=>ORIGIN+p,onMessage:messages,onStartup:event(),onInstalled:event()},alarms:{get:async()=>null,create:async()=>{counters.alarms++;},onAlarm:event()},action:{onClicked:event(),setBadgeText:async()=>{}},windows:{update:async()=>{}},scripting:{executeScript:async spec=>{if(spec.world==='MAIN'){counters.resolves.push({tabId:spec.target.tabId,args:clone(spec.args)});return [{result:{ok:true,status:200,downloadUrl:'https://chatgpt.com/backend-api/estuary/content?id=resolved',fileName:'resolved.txt',mimeType:'text/plain'}}];}counters.injections.push(spec.target.tabId);const page=pages.get(spec.target.tabId);if(page){page.version=VERSION;page.revision=CONTENT_REVISION;}}},tabs:{onUpdated:event(),onRemoved:removed,
  get:async id=>{if(!tabs.has(id))throw Error('missing tab');return clone(tabs.get(id));},
  query:async({active,windowId})=>Array.from(tabs.values()).filter(tab=>(active===undefined||tab.active===active)&&(windowId===undefined||tab.windowId===windowId)).map(clone),
  create:async({url,active})=>{const id=Math.max(...tabs.keys())+1,tab={id,url,active,windowId:1,autoDiscardable:true};tabs.set(id,tab);pages.set(id,{ok:true,version:VERSION,revision:CONTENT_REVISION,composer:true,busy:false,hasDraft:false,activeTask:null,documentKey:'doc-'+id,href:url,userCount:url.includes('/c/')?1:0,detail:'fixture ready'});counters.creates.push(id);return clone(tab);},
  reload:async id=>{if(!tabs.has(id))throw Error('missing');tabs.get(id).discarded=false;counters.reloads.push(id);return clone(tabs.get(id));},
  remove:async id=>{tabs.delete(id);pages.delete(id);},
  update:async(id,patch)=>{if(!tabs.has(id))throw Error('missing');Object.assign(tabs.get(id),patch);if(patch.url&&pages.has(id)){const page=pages.get(id);page.href=patch.url;page.userCount=patch.url.includes('/c/')?1:0;page.documentKey='doc-'+id+'-'+counters.requests.length;}if('autoDiscardable'in patch)counters.discards.push([id,patch.autoDiscardable]);return clone(tabs.get(id));},
  sendMessage:async(id,packet)=>{if(packet.type==='jsc-ping')return clone(pages.get(id));if(packet.type==='jsc-run')counters.runs.push({id,packet:clone(packet)});if(packet.type==='jsc-download-file')counters.downloads.push({id,packet:clone(packet)});return {ok:true};}}};
 const fetch=async(url,options={})=>{
   const parsed=new URL(url),path=parsed.pathname;if(parsed.hostname==='chatgpt.com'&&path==='/backend-api/estuary/content')return new Response(new Uint8Array([80,75,3,4]),{status:200,headers:{'Content-Type':'application/zip'}});
   const body=typeof options.body==='string'?JSON.parse(options.body):{};counters.requests.push({path,body});let value={ok:true},status=200;
   if(path==='/api/me')value={version:VERSION,role:server.role||'account',account:{id:server.accountId||ACCOUNT,name:'账号 A',clientId:CLIENT},maxConcurrent:3};
   else if(path==='/health')value={version:VERSION};
   else if(path==='/api/tasks')value={tasks:clone([...tasks].reverse())};
   else if(path.startsWith('/api/tasks/'))value=clone(tasks.find(t=>t.id===path.split('/').at(-1)));
   else if(path.startsWith('/api/conversations/'))value=clone(conversations[path.split('/').at(-1)]);
   else if(path==='/api/browser/poll'){const t=tasks.find(t=>t.conversationId===body.conversationId&&!['completed','cancelled','interrupted','error'].includes(t.state));if(t)t.state='running';value={task:clone(t)||null};}
   else if(path.startsWith('/api/browser/files/')){counters.uploads.push({path,headers:clone(options.headers),size:options.body.size});value={id:'file-aaaaaaaa',name:decodeURIComponent(options.headers['X-Doubao-File-Name']),mimeType:options.headers['Content-Type'],size:options.body.size};status=201;}
   else if(path==='/api/browser/event'){
     const t=tasks.find(t=>t.id===body.id);counters.events.push(clone(body));
     if(server.failEvent){status=503;value={error:'offline'};}
     else if(body.seq>t.lastSeq+1){status=409;value={error:'sequence gap'};}
     else if(body.seq<=t.lastSeq)value={lastSeq:t.lastSeq,state:t.state,duplicate:true};
     else {t.lastSeq=body.seq;t.checkpoint=body.checkpoint;if(body.type==='submitting')t.submitted=true;if(['snapshot','done'].includes(body.type))t.text=body.text;if(body.type==='done'){t.state='completed';t.downloads=body.downloads||[];}value={lastSeq:t.lastSeq,state:t.state};}
   }else if(path==='/api/bridge/register')value={account:{id:server.accountId||ACCOUNT,name:'账号 A'},maxConcurrent:3};
   return new Response(JSON.stringify(value??{error:'missing'}),{status:value===undefined?404:status,headers:{'Content-Type':'application/json'}});
 };
 const context=vm.createContext({chrome,fetch,console,URL,Response,AbortController,TextDecoder,TextEncoder,Uint8Array,structuredClone,crypto:webcrypto,Promise,Date,Math,Error,JSON,Set,Map,setTimeout:(fn,delay)=>{counters.scheduled.push(delay);return 1;},clearTimeout:()=>{}});
 vm.runInContext(source+'\n;globalThis.__test={boot,runCycle,ensureLane,forwardEvent};',context);
 async function msg(message,sender){return new Promise(resolve=>messages.handlers[0](message,{id:ID,...sender},resolve));}
 const web=(operation,extra={},url='http://127.0.0.1:48643/web/',frameId=0)=>msg({type:'doubao-web',operation,accountId:ACCOUNT,...extra},{url,frameId,tab:{id:50,url}});
 const internal=(type,extra={})=>msg({type,...extra},{url:ORIGIN+'options.html'});
 const packet=(c,text='快照',extra={})=>{const lane=saved['lane:'+c];return {type:'bridge-event',id:lane.active.task.id,accountId:ACCOUNT,conversationId:c,documentKey:lane.bridge.documentKey,eventId:crypto.randomUUID(),eventType:'snapshot',text,checkpoint:{phase:'observing'},...extra};};
 async function content(p,override={}){const lane=saved['lane:'+p.conversationId],id=lane?.bridge?.tabId;return msg(p,{url:tabs.get(id)?.url||'https://chatgpt.com/',frameId:0,tab:clone(tabs.get(id)),...override});}
 return {saved,session,server,tasks,conversations,tabs,pages,counters,web,internal,packet,content,boot:context.__test.boot,cycle:()=>context.__test.runCycle()};
}

test('one account serializes conversations through one work tab and never adopts a manual chat',async()=>{
 const h=harness();await h.cycle();assert.equal(h.counters.runs.length,1);
 const a=h.saved['lane:'+C1];assert.equal(h.saved['lane:'+C2],undefined);assert.notEqual(a.bridge.tabId,10);assert.equal(h.counters.creates.length,1);
 h.tasks[0].state='completed';await h.cycle();await h.cycle();const b=h.saved['lane:'+C2];assert.equal(h.counters.runs.length,2);assert.equal(b.bridge.tabId,a.bridge.tabId);assert.equal(h.counters.creates.length,1);
});
test('stale same-version content script is reinjected before claiming queued work',async()=>{
 const saved={accountWorkTab:{accountId:ACCOUNT,tabId:10,currentConversationId:''}},h=harness({saved});
 h.tabs.get(10).url='https://chatgpt.com/';h.pages.set(10,{ok:true,version:VERSION,revision:'old-revision',composer:true,busy:false,hasDraft:false,activeTask:null,documentKey:'old-doc',href:'https://chatgpt.com/',userCount:0,detail:'stale fixture'});
 await h.cycle();assert.deepEqual(h.counters.injections,[10]);assert.equal(h.counters.runs.length,1);assert.equal(h.counters.runs[0].packet.task.conversationId,C1);
});
test('selected model is delivered unchanged to the bound ChatGPT page',async()=>{
 const h=harness();h.tasks[0].model='gpt-5-6-thinking-extended';await h.cycle();const run=h.counters.runs.find(x=>x.packet.task.conversationId===C1);assert.equal(run.packet.task.model,'gpt-5-6-thinking-extended');
});
test('queued second conversation cannot overlap the active account work tab',async()=>{
 const h=harness();await h.cycle();assert.ok(h.saved['lane:'+C1].active);assert.equal(h.saved['lane:'+C2],undefined);
 assert.equal(h.counters.runs.filter(x=>x.packet.task.conversationId===C1).length,1);assert.equal(h.counters.runs.filter(x=>x.packet.task.conversationId===C2).length,0);
});
test('manual open cannot navigate the shared tab away from another queued conversation',async()=>{
 const h=harness();const result=await h.web('ui-open-bridge',{conversationId:C2});assert.equal(result.ok,true);assert.equal(result.ready,false);assert.match(result.detail,/不会切走/);assert.equal(h.counters.creates.length,0);
});
test('foreign tab, document, account, conversation and iframe packets are rejected',async()=>{
 const h=harness();await h.cycle();const base=h.packet(C1);
 for(const patch of [{accountId:'account-bbbbbbbb'},{documentKey:'old-document'},{conversationId:C2},{id:'other-task000'}])assert.equal((await h.content({...base,...patch})).ok,false);
 assert.equal((await h.content(base,{tab:{id:10}})).ok,false);assert.equal((await h.content(base,{frameId:1})).ok,false);assert.equal(h.counters.events.length,0);
});
test('durable outbox replays exactly once after worker restart with same browser session',async()=>{
 const options={saved:{},session:{doubaoSession:'same'},server:{}};let h=harness(options);await h.cycle();h.server.failEvent=true;
 const p=h.packet(C1,'只保留一次');assert.equal((await h.content(p)).ok,false);assert.equal(h.saved['lane:'+C1].active.pending.seq,1);
 h.server.failEvent=false;const tabs=h.tabs,pages=h.pages;h=harness(options);for(const [k,v]of tabs)h.tabs.set(k,v);for(const [k,v]of pages)h.pages.set(k,v);
 await h.cycle();assert.equal(h.tasks[0].lastSeq,1);assert.equal(h.tasks[0].text,'只保留一次');assert.equal((await h.content(p)).ok,true);assert.equal(h.tasks[0].lastSeq,1);
});
test('completed reply downloads a signed ChatGPT artifact into the local backend before ACK',async()=>{
 const h=harness();await h.cycle();const packet=h.packet(C1,'源码已生成',{eventType:'done',fileSources:[{name:'forum.zip',mimeType:'application/zip',url:'https://chatgpt.com/backend-api/estuary/content?id=signed',key:'/mnt/data/forum.zip'}]});const result=await h.content(packet);
 assert.equal(result.ok,true);assert.equal(h.counters.uploads.length,1);assert.equal(h.counters.uploads[0].size,4);assert.match(h.counters.uploads[0].path,/\/api\/browser\/files\/task-/);assert.equal(h.tasks[0].state,'completed');
});
test('sandbox file card trusts the live checkpoint after ChatGPT SPA navigation and saves immediately',async()=>{
 const h=harness();await h.cycle();const lane=h.saved['lane:'+C1],tab=h.tabs.get(lane.bridge.tabId),upstream='upstream-1111';tab.url='https://chatgpt.com/c/stale-before-spa-navigation';h.pages.get(tab.id).href='https://chatgpt.com/c/'+upstream;
 const packet=h.packet(C1,'文件已生成',{eventType:'done',checkpoint:{phase:'finished',url:'https://chatgpt.com/c/'+upstream},fileSources:[{name:'server-auto.txt',mimeType:'application/octet-stream',conversation:upstream,messageId:'message-1111',sandboxPath:'/mnt/data/server-auto.txt',key:'/mnt/data/server-auto.txt'}]});const result=await h.content(packet);
 assert.equal(result.ok,true);assert.equal(h.counters.resolves.length,1);assert.equal(h.counters.uploads.length,1);assert.equal(h.tasks[0].state,'completed');
});
test('local file button triggers the matching ChatGPT card without focusing its work tab',async()=>{
 const h=harness();await h.cycle();const task=h.tasks[0],done=h.packet(C1,'已生成文件：下载 forum.zip',{eventType:'done',downloads:[{name:'forum.zip'}]});assert.equal((await h.content(done)).ok,true);
 const result=await h.web('ui-download-file',{conversationId:C1,taskId:task.id,fileName:'forum.zip'});assert.equal(result.ok,true);assert.equal(h.counters.downloads.length,1);assert.equal(h.counters.downloads[0].packet.fileName,'forum.zip');assert.equal(h.tabs.get(h.counters.downloads[0].id).active,false);
});
test('browser restart invalidates persistent numerical tab IDs',async()=>{
 const options={saved:{},session:{doubaoSession:'old'},server:{}};let h=harness(options);await h.cycle();options.session={};h=harness(options);await h.boot;
 assert.equal(h.saved['lane:'+C1].bridge.tabId,null);assert.equal(h.saved.accountWorkTab,null);
});
test('extension reload reuses the exact recorded ChatGPT work tab',async()=>{
 const options={saved:{},session:{doubaoSession:'loaded'},server:{}};let h=harness(options);await h.cycle();const lane=h.saved['lane:'+C1],id=lane.bridge.tabId,url='https://chatgpt.com/c/reload-reuse';
 h.tabs.get(id).url=url;h.pages.get(id).href=url;lane.bridge.url=url;lane.active.checkpoint.url=url;lane.active.task.submitted=true;h.saved.accountWorkTab.currentConversationId=C1;const oldTabs=h.tabs,oldPages=h.pages;
 options.session={};h=harness(options);for(const [key,value] of oldTabs)h.tabs.set(key,value);for(const [key,value] of oldPages)h.pages.set(key,value);await h.boot;
 assert.equal(h.saved['lane:'+C1].bridge.tabId,id);assert.equal(h.saved.accountWorkTab.tabId,id);
});
test('discarded work tab is automatically reloaded instead of requiring a manual click',async()=>{
 const h=harness();await h.cycle();const id=h.saved['lane:'+C1].bridge.tabId;h.tabs.get(id).discarded=true;await h.cycle();assert.ok(h.counters.reloads.includes(id));assert.equal(h.saved['lane:'+C1].ready,true);
});
test('uncertain submitted task is never blindly sent to a replacement blank tab',async()=>{
 const h=harness();await h.cycle();const lane=h.saved['lane:'+C1];lane.active.task.submitted=true;h.tasks[0].submitted=true;h.tabs.delete(lane.bridge.tabId);
 const count=h.counters.runs.length;await h.cycle();assert.match(h.saved['lane:'+C1].detail,/无法安全恢复/);assert.equal(h.counters.runs.filter(x=>x.packet.task.conversationId===C1).length,1);assert.ok(h.counters.runs.length>=count);
});
test('submitted task reattaches after extension reload when managed tab reached a real conversation',async()=>{
 const h=harness();await h.cycle();const lane=h.saved['lane:'+C1],id=lane.bridge.tabId,url='https://chatgpt.com/c/WEB:recover-one';lane.active.task.submitted=true;lane.active.checkpoint={phase:'submitting',url:'https://chatgpt.com/'};h.tasks[0].submitted=true;h.tabs.get(id).url=url;Object.assign(h.pages.get(id),{href:url,userCount:1,documentKey:'reloaded-doc'});
 const before=h.counters.runs.length;await h.cycle();assert.equal(h.counters.runs.length,before+1);assert.equal(h.counters.runs.at(-1).packet.task.submitted,true);assert.equal(h.saved['lane:'+C1].bridge.documentKey,'reloaded-doc');
});
test('a tracked work tab that leaves ChatGPT is replaced without adopting a manual chat',async()=>{
 const h=harness();await h.cycle();const lane=h.saved['lane:'+C1],old=lane.bridge.tabId;h.tabs.get(old).url='https://example.org/';
 await h.cycle();assert.notEqual(h.saved['lane:'+C1].bridge.tabId,old);assert.notEqual(h.saved['lane:'+C1].bridge.tabId,10);assert.equal(h.counters.creates.length,2);
});
test('cancelled task discards pending outbox and releases only its own work page',async()=>{
 const h=harness();await h.cycle();h.server.failEvent=true;await h.content(h.packet(C1));h.tasks[0].state='cancelled';await h.cycle();
 assert.equal(h.saved['lane:'+C1].active,null);assert.equal(h.saved['lane:'+C2],undefined);assert.ok(h.counters.discards.some(([id,v])=>id===h.saved['lane:'+C1].bridge.tabId&&v));await h.cycle();assert.ok(h.saved['lane:'+C2].active);assert.equal(h.saved['lane:'+C2].bridge.tabId,h.saved['lane:'+C1].bridge.tabId);
});
test('web operations require local origin, top frame, correct account and non-incognito profile',async()=>{
 const h=harness();for(const url of ['https://example.org/web/','http://127.0.0.1:49999/web/','http://127.0.0.1:48643/not-web'])assert.equal((await h.web('ui-status',{},url)).ok,false);
 assert.equal((await h.web('ui-status',{},undefined,1)).ok,false);assert.equal((await h.web('ui-prepare-bridge',{accountId:'other-account00',conversationId:C1})).ok,false);
});
test('master token cannot pair as a web bridge',async()=>{
 const h=harness({server:{role:'admin'}});assert.equal((await h.internal('ui-save-settings',{settings:{token:TOKEN,confirmProfile:true}})).ok,false);
});
test('changing account inside an already bound profile is refused',async()=>{
 const h=harness({server:{accountId:'account-bbbbbbbb'}});const result=await h.internal('ui-save-settings',{settings:{token:TOKEN,confirmProfile:true}});assert.equal(result.ok,false);assert.match(result.error,/另一个账号/);
});
test('extension icon/workspace action opens independent pages instead of side panel',async()=>{
 const h=harness();await h.internal('ui-open-workspace');await h.internal('ui-open-workspace');assert.equal(h.counters.creates.length,2);for(const id of h.counters.creates)assert.equal(h.tabs.get(id).url,'http://127.0.0.1:48643/web/');
});
