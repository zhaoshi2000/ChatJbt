import {DEFAULT_URL,VERSION,TERMINAL,normalizeBaseUrl,apiRequest} from './shared.js';
import {chatUrl,conversationUrl,stableConversationUrl,pageAtTarget,validId,assertTask,assertPacket,planTaskIds} from './lane-core.js';
const storage=chrome.storage.local, PREFIX='lane:', ACCOUNT_TAB='accountWorkTab', ALARM='doubao-multi-recover';
const CONTENT_REVISION='2026-09-22.27';
const get=async key=>(await storage.get(key))[key];
const write=value=>storage.set(value);
const locks=new Map();
let timer,cyclePromise,rerun=false,failures=0,pairing=false;
function ordered(key,operation){const result=(locks.get(key)||Promise.resolve()).then(operation);const tail=result.catch(()=>{});locks.set(key,tail);tail.finally(()=>{if(locks.get(key)===tail)locks.delete(key);});return result;}
const settings=async()=>await get('settings')||{backendUrl:DEFAULT_URL,token:'',enabled:true,accountId:''};
const request=async(path,options={})=>apiRequest(await settings(),path,options);
const laneKey=id=>PREFIX+id;
const loadLane=async id=>await get(laneKey(id));
const saveLane=lane=>write({[laneKey(lane.conversationId)]:lane});
const allLanes=async()=>Object.entries(await storage.get(null)).filter(([k])=>k.startsWith(PREFIX)).map(([,v])=>v);
const internal=sender=>sender.id===chrome.runtime.id&&(sender.url||'').startsWith(chrome.runtime.getURL(''));
const boot=(async()=>{
  await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  let saved=await storage.get(['clientId','settings']);
  if(!saved.clientId)await write({clientId:crypto.randomUUID()});
  if(!saved.settings)await write({settings:{backendUrl:DEFAULT_URL,token:'',enabled:true,accountId:''}});
  // A manual extension reload clears session storage while the browser tabs
  // stay alive. Reuse only a tab whose current durable conversation URL still
  // exactly matches the recorded lane; otherwise discard the numerical ID.
  const session=await chrome.storage.session.get('doubaoSession');
  if(!session.doubaoSession){
    const retained=new Set();
    for(const lane of await allLanes()){
      if(lane.bridge?.tabId){
        let tab=null;try{tab=await chrome.tabs.get(lane.bridge.tabId);}catch{}
        const actual=stableConversationUrl(tab?.url||tab?.pendingUrl||''),recorded=stableConversationUrl(lane.bridge.url)||stableConversationUrl(lane.active?.checkpoint?.url);
        const safe=!!tab&&chatUrl(tab.url||tab.pendingUrl)&&((recorded&&actual===recorded)||(!lane.active?.task.submitted&&!recorded));
        if(safe)retained.add(lane.bridge.tabId);else lane.bridge={...lane.bridge,tabId:null,documentKey:null};
      }
      await saveLane(lane);
    }
    const shared=await get(ACCOUNT_TAB);if(!retained.has(shared?.tabId))await write({[ACCOUNT_TAB]:null});
    await chrome.storage.session.set({doubaoSession:crypto.randomUUID()});
  }
  if(!(await chrome.alarms.get(ALARM)))await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
})();
async function setStatus(value){await write({bridgeStatus:{...value,updated:Date.now(),version:VERSION}});await chrome.action.setBadgeText({text:value.backend==='offline'?'!':value.activeCount?String(value.activeCount):value.ready?'ON':''}).catch(()=>{});}
async function readImage(url){
  let u;try{u=new URL(url);}catch{throw new Error('图片地址无效');}
  const allowed=u.protocol==='https:'&&((u.hostname==='chatgpt.com'&&u.pathname==='/backend-api/estuary/content')||u.hostname==='oaidalleapiprodscus.blob.core.windows.net'||u.hostname.endsWith('.oaiusercontent.com'));if(!allowed)throw new Error('拒绝读取非 OpenAI 图片地址');
  const response=await fetch(u.href,{cache:'no-store',credentials:'omit'});if(!response.ok)throw new Error('读取图片失败：HTTP '+response.status);const blob=await response.blob();if(!blob.size||blob.size>6_000_000)throw new Error('生成图片超过 6 MB');
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return {ok:true,mimeType:['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type)?blob.type:'image/png',base64:btoa(binary)};
}
async function resolveGeneratedFile(source,tabId,pageUrl){
  if(typeof source.url==='string'&&source.url)return source;
  if(!Number.isInteger(tabId)||typeof source.conversation!=='string'||typeof source.messageId!=='string'||typeof source.sandboxPath!=='string'||!/^\/mnt\/data\/[^/\\]{1,160}$/.test(source.sandboxPath))throw new Error('生成文件解析信息无效');
  const page=conversationUrl(pageUrl);if(page!=='https://chatgpt.com/c/'+source.conversation)throw new Error('生成文件会话与工作页不匹配');
  const endpoint='/backend-api/conversation/'+encodeURIComponent(source.conversation)+'/interpreter/download?message_id='+encodeURIComponent(source.messageId)+'&sandbox_path='+encodeURIComponent(source.sandboxPath);
  const executed=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:async ({path,fileName})=>{const parse=async response=>{const data=await response.clone().json().catch(()=>({}));return {ok:response.ok,status:response.status,downloadUrl:data.download_url||'',fileName:data.file_name||'',mimeType:data.mime_type||''};};try{const target=new URL(path,location.href),headers={'x-chatgpt-sandbox-download-source':'web_artifact_download','x-openai-target-path':target.pathname,'x-openai-target-route':'/backend-api/conversation/{conversation_id}/interpreter/download','x-openai-web-frontend':'core_web','oai-language':document.documentElement.lang||navigator.language||'zh-CN'},direct=await fetch(target.href,{credentials:'include',cache:'no-store',headers}),value=await parse(direct);if(value.ok)return value;
    const originalFetch=window.fetch,originalClick=HTMLAnchorElement.prototype.click,originalOpen=window.open;let finish;const captured=new Promise(resolve=>finish=resolve),timer=setTimeout(()=>finish({ok:false,status:value.status}),12_000);
    window.fetch=async function(...args){const response=await originalFetch.apply(this,args);try{const url=new URL(typeof args[0]==='string'?args[0]:args[0]?.url||'',location.href);if(url.pathname===target.pathname&&url.searchParams.get('message_id')===target.searchParams.get('message_id'))finish(await parse(response));}catch{}return response;};
    HTMLAnchorElement.prototype.click=function(){try{const url=new URL(this.href,location.href);if(url.pathname==='/backend-api/estuary/content')return;}catch{}return originalClick.call(this);};window.open=function(url,...args){try{if(new URL(url,location.href).pathname==='/backend-api/estuary/content')return null;}catch{}return originalOpen.call(this,url,...args);};
    const norm=value=>String(value||'').replace(/\s+/g,' ').trim(),buttons=Array.from(document.querySelectorAll('button,[role="button"]')),wanted=norm(fileName),button=buttons.find(el=>{const label=norm(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.textContent);return label===wanted||(/^(?:下载|download)\s+/i.test(label)&&label.includes(wanted));});if(!button)finish({ok:false,status:404,error:'未找到文件卡片'});else button.click();const result=await captured;clearTimeout(timer);window.fetch=originalFetch;HTMLAnchorElement.prototype.click=originalClick;window.open=originalOpen;return result;}catch(error){return {ok:false,status:0,error:error?.message||String(error)};}},args:[{path:endpoint,fileName:source.name}]});
  const value=executed?.[0]?.result;if(!value?.ok)throw new Error('获取生成文件下载地址失败：HTTP '+(value?.status||0));return {...source,url:value.downloadUrl,name:(value.fileName||source.name),mimeType:value.mimeType||source.mimeType};
}
async function uploadGeneratedFile(task,source,tabId,pageUrl){
  if(!source||typeof source.name!=='string'||typeof source.key!=='string'||source.name.length>160)throw new Error('生成文件信息无效');source=await resolveGeneratedFile(source,tabId,pageUrl);
  const remote=new URL(source.url);if(remote.protocol!=='https:'||remote.hostname!=='chatgpt.com'||remote.pathname!=='/backend-api/estuary/content')throw new Error('生成文件地址不安全');
  const response=await fetch(remote.href,{cache:'no-store',credentials:'include',referrer:pageUrl,referrerPolicy:'strict-origin-when-cross-origin'});if(!response.ok)throw new Error('下载 ChatGPT 生成文件失败：HTTP '+response.status);
  const blob=await response.blob();if(!blob.size)throw new Error('ChatGPT 返回了空文件');if(blob.size>50_000_000)throw new Error('生成文件超过 50 MB，未自动保存');
  const config=await settings(),clientId=await get('clientId'),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source.key)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  const saved=await fetch(config.backendUrl+'/api/browser/files/'+encodeURIComponent(task.id),{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':blob.type||source.mimeType||'application/octet-stream','X-Doubao-Client':clientId,'X-Doubao-Lease':task.lease,'X-Doubao-File-Key':hash,'X-Doubao-File-Name':encodeURIComponent(source.name)},body:blob,credentials:'omit',redirect:'error'});
  const data=await saved.json().catch(()=>({}));if(!saved.ok)throw Object.assign(new Error(data.error||'服务端保存生成文件失败：HTTP '+saved.status),{status:saved.status});return data;
}
function kick(delay=0){if(cyclePromise){if(delay===0)rerun=true;return;}clearTimeout(timer);timer=setTimeout(()=>runCycle().catch(()=>{}),delay);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ping(tabId){let timeout;try{return await Promise.race([chrome.tabs.sendMessage(tabId,{type:'jsc-ping'}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('页面响应超时')),3000);})]);}catch{return null;}finally{clearTimeout(timeout);}}
async function ensureContent(tabId,waitMs=60_000,targetUrl=''){
  const deadline=Date.now()+waitMs;let tab,lastInfo,reloaded=false,injectionFailures=0;
  while(Date.now()<deadline){
    tab=await chrome.tabs.get(tabId);
    if(tab.discarded&&!reloaded){await chrome.tabs.reload(tabId).catch(()=>{});reloaded=true;continue;}
    const url=tab.url||tab.pendingUrl||'';
    if(chatUrl(url)){
      let info=await ping(tabId);
      if(!info||info.version!==VERSION||info.revision!==CONTENT_REVISION){
        const injected=await chrome.scripting.executeScript({target:{tabId},files:['bridge-core.js','content.js'],injectImmediately:true}).then(()=>true).catch(()=>false);
        info=await ping(tabId);if(!injected||!info)injectionFailures++;
        // Reloading an unpacked extension invalidates the old isolated world.
        // If direct reinjection cannot repair it, refresh the existing work tab
        // once so the manifest content scripts attach to the new extension world.
        if(!info&&!reloaded&&injectionFailures>=2){await chrome.tabs.reload(tabId).catch(()=>{});reloaded=true;await pause(500);continue;}
      }
      if(info?.ok&&info.version===VERSION&&info.revision===CONTENT_REVISION){lastInfo=info;if(targetUrl&&!pageAtTarget(info.href||url,targetUrl)){lastInfo={...info,detail:'等待工作页切换到目标会话…'};await pause(250);continue;}if(info.composer)return {tab,info};}
    }else if(tab.status==='complete'&&url&&!/^(edge|chrome):\/\/newtab/.test(url))throw new Error('工作标签页没有进入 ChatGPT，请检查登录或站点权限');
    await pause(250);
  }
  if(tab){await chrome.tabs.update(tabId,{active:true}).catch(()=>{});await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
  throw new Error(lastInfo?.detail||'已自动打开工作页，但 ChatGPT 输入框长时间未就绪；请在弹出的页面完成登录后重试');
}
async function accountWorkTab(config,lane){
  let shared=await get(ACCOUNT_TAB),tab;
  if(shared?.accountId===config.accountId&&shared.tabId)try{tab=await chrome.tabs.get(shared.tabId);}catch{}
  if(tab&&chatUrl(tab.url||tab.pendingUrl))return {shared,tab};
  const lanes=(await allLanes()).filter(item=>item.accountId===config.accountId),active=lanes.find(item=>item.active&&item.bridge?.tabId),fallback=lane.bridge?.tabId?lane:lanes.find(item=>item.bridge?.tabId),source=active||fallback;
  if(source)try{tab=await chrome.tabs.get(source.bridge.tabId);}catch{}
  if(tab&&chatUrl(tab.url||tab.pendingUrl))shared={accountId:config.accountId,tabId:tab.id,currentConversationId:source.conversationId};
  else{tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:false});shared={accountId:config.accountId,tabId:tab.id,currentConversationId:''};}
  // v1.2 originally created one tab per conversation. On the first run of the
  // shared-tab design, close only inactive tabs that the extension itself had
  // recorded, leaving manual ChatGPT tabs and any legacy active task untouched.
  for(const old of lanes){
    const oldId=old.bridge?.tabId;if(!oldId||oldId===tab.id||old.active)continue;
    try{const candidate=await chrome.tabs.get(oldId);if(chatUrl(candidate.url||candidate.pendingUrl))await chrome.tabs.remove(oldId);}catch{}
    old.bridge={...old.bridge,tabId:null,documentKey:null};await saveLane(old);
  }
  await write({[ACCOUNT_TAB]:shared});return {shared,tab};
}
async function ensureLane(conversationId,options={}) {
  const config=await settings();if(!config.accountId)throw new Error('请先使用账号专属令牌配对');
  return ordered('account-tab:'+config.accountId,()=>ensureLaneUnlocked(config,conversationId,options));
}
async function ensureLaneUnlocked(config,conversationId,{focus=false}={}) {
  if(!validId(conversationId))throw new Error('请先新建一个本地会话');
  const conversation=await request('/api/conversations/'+conversationId);
  if(conversation.accountId!==config.accountId)throw new Error('此会话不属于当前浏览器绑定的账号');
  let lane=await loadLane(conversationId)||{conversationId,accountId:config.accountId,bridge:null,active:null,detail:''};
  if(lane.accountId!==config.accountId)throw new Error('旧工作区绑定与本账号不同，拒绝复用');
  // ChatGPT briefly uses /c/WEB:* while creating a conversation and then
  // replaces it with the durable conversation URL. Never lock a lane to that
  // provisional address.
  const expected=stableConversationUrl(conversation.upstreamUrl)||stableConversationUrl(lane.active?.checkpoint?.url);
  let {shared,tab}=await accountWorkTab(config,lane);
  if(lane.active?.task.submitted&&!expected&&shared.currentConversationId!==conversationId)throw new Error('原提交没有确认会话地址，无法安全恢复。请停止此任务并到原网页核对，不会重复发送。');
  const switching=shared.currentConversationId!==conversationId;
  if(switching){tab=await chrome.tabs.update(tab.id,{url:expected||'https://chatgpt.com/'});shared={...shared,currentConversationId:conversationId,documentKey:null};await write({[ACCOUNT_TAB]:shared});}
  if(tab?.discarded)await chrome.tabs.reload(tab.id).catch(()=>{});
  if(focus){await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
  const targetUrl=switching?(expected||'https://chatgpt.com/'):'';
  const bound=await ensureContent(tab.id,60_000,targetUrl), actual=conversationUrl(bound.info.href||bound.tab.url);
  if(expected&&actual!==expected)throw new Error('工作网页地址与本地会话不一致，已阻止串聊。请恢复原对话地址：'+expected);
  if(!expected&&!switching&&!lane.active?.task.submitted&&(actual||bound.info.userCount>0))throw new Error('新建会话的工作页已有其他聊天内容。请点击“新对话”后重试，不会接管已有对话。');
  if(lane.active?.task.submitted&&lane.bridge.documentKey&&lane.bridge.documentKey!==bound.info.documentKey&&!expected&&!actual)
    throw new Error('提交后的页面已被替换，且没有安全恢复地址。请停止并核对原网页。');
  lane.bridge={...lane.bridge,tabId:tab.id,documentKey:bound.info.documentKey,url:bound.info.href||bound.tab.url};
  await write({[ACCOUNT_TAB]:{...shared,tabId:tab.id,currentConversationId:conversationId,documentKey:bound.info.documentKey}});
  lane.detail=bound.info.detail;lane.ready=!!bound.info.composer;await saveLane(lane);
  return {lane,info:bound.info,conversation,expected};
}
async function flush(lane){
  const a=lane.active;if(!a?.pending)return lane;
  const result=await request('/api/browser/event',{method:'POST',body:a.pending,timeout:7000});
  a.seq=Math.max(a.pending.seq,result.lastSeq||0);a.lastAck=a.pending.eventId;a.task.state=result.state||a.task.state;
  a.task.submitted ||= a.pending.type==='submitting';a.pending=null;await saveLane(lane);return lane;
}
async function forwardEvent(packet,sender){
  if(!validId(packet.conversationId))throw new Error('无效会话 ID');
  return ordered(packet.conversationId,async()=>{
    let lane=await loadLane(packet.conversationId);assertPacket(packet,sender,lane);
    lane=await flush(lane);const a=lane.active;
    if(a.lastAck===packet.eventId||TERMINAL.has(a.task.state))return {ok:true,state:a.task.state,terminal:TERMINAL.has(a.task.state)};
    if(!['checkpoint','submitting','snapshot','progress','done','error','interrupted'].includes(packet.eventType)||typeof packet.eventId!=='string'||packet.eventId.length>100)throw new Error('无效事件类型');
    if(packet.fileSources!==undefined){if(packet.eventType!=='done'||!Array.isArray(packet.fileSources)||packet.fileSources.length>4)throw new Error('生成文件回传无效');const pageUrl=packet.checkpoint?.url||a.checkpoint?.url||sender.url;for(const source of packet.fileSources)await uploadGeneratedFile(a.task,source,sender.tab?.id,pageUrl);}
    a.checkpoint={...a.checkpoint,...packet.checkpoint};
    a.pending={id:a.task.id,accountId:lane.accountId,conversationId:lane.conversationId,clientId:await get('clientId'),lease:a.task.lease,seq:a.seq+1,eventId:packet.eventId,type:packet.eventType,checkpoint:a.checkpoint};
    if(typeof packet.text==='string')a.pending.text=packet.text.slice(0,1_000_000);
    if(packet.images!==undefined){if(!Array.isArray(packet.images)||packet.images.length>4||packet.images.some(x=>!x||typeof x.name!=='string'||typeof x.mimeType!=='string'||typeof x.base64!=='string'||x.base64.length>8_100_000))throw new Error('回复图片数据无效');a.pending.images=packet.images;}
    if(packet.downloads!==undefined){if(packet.eventType!=='done'||!Array.isArray(packet.downloads)||packet.downloads.length>4||packet.downloads.some(x=>!x||typeof x.name!=='string'||!x.name.trim()||x.name.length>160))throw new Error('网页下载项无效');a.pending.downloads=packet.downloads.map(x=>({name:x.name.trim()}));}
    if(typeof packet.detail==='string')a.pending.detail=packet.detail.slice(0,600);
    if(packet.eventType==='submitting')a.task.submitted=true;
    await saveLane(lane);lane=await flush(lane);
    if(['submitting','done','error','interrupted'].includes(packet.eventType))await restorePreviousTab(lane);
    return {ok:true,state:lane.active.task.state,terminal:TERMINAL.has(lane.active.task.state)};
  });
}
async function restorePreviousTab(lane){
  const previousId=lane.restoreTabId;if(!previousId)return;
  delete lane.restoreTabId;await saveLane(lane);
  const work=await chrome.tabs.get(lane.bridge?.tabId).catch(()=>null),previous=await chrome.tabs.get(previousId).catch(()=>null);
  if(!work||!previous||work.windowId!==previous.windowId)return;
  const visible=(await chrome.tabs.query({active:true,windowId:work.windowId}))[0];
  if(visible?.id===work.id)await chrome.tabs.update(previous.id,{active:true}).catch(()=>{});
}
const wakePulses=new Map();
async function wakeHiddenWorkTab(packet,sender){
  if(!validId(packet.conversationId))throw new Error('无效会话 ID');
  const lane=await loadLane(packet.conversationId);assertPacket(packet,sender,lane);
  const tabId=lane.bridge.tabId,now=Date.now(),last=wakePulses.get(tabId)||0;if(now-last<6000)return {ok:true,skipped:true};
  const work=await chrome.tabs.get(tabId),visible=(await chrome.tabs.query({active:true,windowId:work.windowId}))[0];
  if(!visible||visible.id===tabId)return {ok:true,alreadyVisible:true};
  wakePulses.set(tabId,now);await chrome.tabs.update(tabId,{active:true});
  await pause(2000);
  const current=await chrome.tabs.get(tabId).catch(()=>null),previous=await chrome.tabs.get(visible.id).catch(()=>null);
  if(current&&previous&&current.windowId===previous.windowId)await chrome.tabs.update(previous.id,{active:true}).catch(()=>{});
  return {ok:true,woken:true};
}
async function release(lane,state){
  if(lane.bridge?.tabId&&lane.active)await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-release',id:lane.active.task.id,state}).catch(()=>{});
  if(lane.bridge?.tabId)await chrome.tabs.update(lane.bridge.tabId,{autoDiscardable:lane.bridge.autoDiscardable!==false}).catch(()=>{});
  await restorePreviousTab(lane);lane.active=null;await saveLane(lane);
}
async function workLane(id,summary,enabled,abandonedDrafts=[]){
  return ordered(id,async()=>{
    let lane=await loadLane(id);
    try{
      if(lane?.active){
        let current;
        try{current=await request('/api/tasks/'+lane.active.task.id);}catch(e){if(e.status!==404)throw e;current={state:'interrupted'};}
        if(TERMINAL.has(current.state)){await release(lane,current.state);return;}
        lane=await flush(lane);
      }
      if(!lane?.active&&(!enabled||!summary||TERMINAL.has(summary.state)))return;
      const bound=await ensureLane(id);lane=bound.lane;
      if(!lane.active&&bound.info.hasDraft&&summary){
        for(const candidate of [summary,...abandonedDrafts]){
          const cleanup=await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-clear-owned-draft',task:{id:candidate.id,accountId:candidate.accountId,conversationId:candidate.conversationId,message:candidate.message},documentKey:lane.bridge.documentKey,forceApi:false}).catch(()=>null);
          if(cleanup?.cleared){bound.info.hasDraft=false;break;}
        }
        if(bound.info.hasDraft&&summary.conversationId.startsWith('api-')){
          const cleanup=await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-clear-owned-draft',task:{id:summary.id,accountId:summary.accountId,conversationId:summary.conversationId,message:summary.message},documentKey:lane.bridge.documentKey,forceApi:true}).catch(()=>null);
          if(cleanup?.cleared)bound.info.hasDraft=false;
        }
      }
      if(!bound.info.composer||(!lane.active&&(bound.info.busy||bound.info.hasDraft||bound.info.activeTask)))throw new Error(bound.info.hasDraft?'工作网页有未发送的草稿，不会覆盖；请先处理草稿':'工作网页尚未就绪、未登录或正在生成其他消息');
      const result=await request('/api/browser/poll',{method:'POST',body:{clientId:await get('clientId'),conversationId:id,waitSeconds:0}});
      if(!result.task)return;
      const task=result.task;assertTask(task,lane.accountId,id);
      if(lane.active&&lane.active.task.id!==task.id)throw new Error('会话任务发生冲突，停止自动切换');
      if(!lane.active)lane.active={task:{...task,text:''},seq:task.lastSeq||0,checkpoint:task.checkpoint||{},pending:null,lastAck:''};
      else{lane.active.task={...task,text:'',submitted:task.submitted||lane.active.task.submitted};lane.active.seq=Math.max(lane.active.seq,task.lastSeq||0);}
      await saveLane(lane);await chrome.tabs.update(lane.bridge.tabId,{autoDiscardable:false}).catch(()=>{});
      const workTab=await chrome.tabs.get(lane.bridge.tabId),previous=(await chrome.tabs.query({active:true,windowId:workTab.windowId}))[0];
      if(previous&&previous.id!==workTab.id){lane.restoreTabId=previous.id;await saveLane(lane);await chrome.tabs.update(workTab.id,{active:true});}
      const reply=await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-run',task:{...task,submitted:lane.active.task.submitted},checkpoint:lane.active.checkpoint,documentKey:lane.bridge.documentKey,expectedUrl:bound.expected});
      if(!reply?.ok)throw new Error(reply?.error||'页面未接受任务');
      lane.detail='本会话正在独立生成';lane.ready=true;await saveLane(lane);
    }catch(error){
      lane=await loadLane(id);
      if(!lane){const config=await settings();lane={conversationId:id,accountId:config.accountId,bridge:null,active:null,detail:'',ready:false};}
      await restorePreviousTab(lane);lane.detail=error.message||String(error);lane.ready=false;await saveLane(lane);
      // Isolate a broken lane: other accounts/conversations continue. No silent resend.
      if(error.status===401||error.status===403)throw error;
    }
  });
}
async function runCycle(){
  await boot;if(cyclePromise)return cyclePromise;
  cyclePromise=(async()=>{
    let delay=2500;
    try{
      if(pairing){delay=1000;return;}
      const config=await settings();
      if(!config.token||!config.accountId){await setStatus({backend:'unpaired',ready:false,detail:'请在网页账号管理中创建账号，并使用专属令牌配对'});delay=30000;return;}
      const me=await request('/api/me');
      if(me.version!==VERSION||me.role!=='account'||me.account.id!==config.accountId)throw new Error('账号或版本不匹配，请同时更新后端和扩展并重新配对');
      if(me.account.clientId!==await get('clientId'))throw new Error('此配置文件的账号绑定已失效，请到网页连接设置重新配对');
      const {tasks}=await request('/api/tasks');const lanes=(await allLanes()).filter(l=>l.accountId===config.accountId);
      const active=lanes.filter(l=>l.active).map(l=>l.conversationId);
      // One signed-in account owns exactly one ChatGPT work tab. Tasks from
      // different local conversations therefore run serially in that tab.
      const ids=planTaskIds(config.enabled?tasks:[],active,1);
      const abandonedDrafts=tasks.filter(t=>TERMINAL.has(t.state)&&!t.submitted).slice(0,12);
      await Promise.all(ids.map(id=>workLane(id,tasks.find(t=>t.conversationId===id&&!TERMINAL.has(t.state)),config.enabled,abandonedDrafts)));
      const updated=(await allLanes()).filter(l=>l.accountId===config.accountId),count=updated.filter(l=>l.active).length,waiting=tasks.some(t=>!TERMINAL.has(t.state)),blocked=updated.find(l=>ids.includes(l.conversationId)&&!l.active&&l.ready===false&&l.detail);
      const ready=config.enabled&&!blocked,detail=!config.enabled?'已暂停领取新任务':blocked?.detail||'账号桥接在线；同一账号复用一个工作标签页';
      await request('/api/bridge/heartbeat',{method:'POST',body:{clientId:await get('clientId'),ready,activeCount:count,detail}});
      await setStatus({backend:'online',ready,activeCount:count,accountId:config.accountId,detail});failures=0;
      if(!count&&!tasks.some(t=>!TERMINAL.has(t.state)))delay=12000;
    }catch(error){failures++;delay=Math.min(30000,1000*2**Math.min(5,failures));await setStatus({backend:error.status===401?'unpaired':'offline',ready:false,detail:error.message||String(error)}).catch(()=>{});}
    finally{cyclePromise=null;const next=rerun?0:delay;rerun=false;kick(next);}
  })();return cyclePromise;
}
async function pair(next){
  return ordered('settings',async()=>{
    pairing=true;
    try{
      if(cyclePromise)await cyclePromise;
      const old=await settings();
      const config={backendUrl:normalizeBaseUrl(next.backendUrl||old.backendUrl),token:String(next.token||'').trim(),enabled:next.enabled!==false};
      if(!/^[A-Za-z0-9_-]{40,100}$/.test(config.token))throw new Error('请粘贴账号专属令牌的完整内容');
      if((await allLanes()).some(l=>l.active)&&(old.token!==config.token||old.backendUrl!==config.backendUrl))throw new Error('仍有任务，先停止或等待完成后再修改连接');
      const me=await apiRequest(config,'/api/me');
      if(me.version!==VERSION)throw new Error('请同时更新后端和扩展到 '+VERSION);
      if(me.role!=='account')throw new Error('管理员令牌不能直接桥接。请在 GBT 网页“账号管理”创建账号，使用返回的账号专属令牌');
      if(old.accountId&&old.accountId!==me.account.id)throw new Error('本浏览器配置文件已用于另一个账号。请新建独立浏览器配置文件，不能只换令牌冒充登录隔离');
      const registered=await apiRequest(config,'/api/bridge/register',{method:'POST',body:{clientId:await get('clientId'),confirmProfile:next.confirmProfile===true,profileLabel:String(next.profileLabel||me.account.name)}});
      await write({settings:{...config,accountId:me.account.id,accountName:me.account.name},maxConcurrent:registered.maxConcurrent});
      return {ok:true,account:registered.account};
    }finally{pairing=false;kick();}
  });
}
async function localPage(sender){
  if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.tab||sender.tab.incognito)return false;
  try{const u=new URL(sender.url),config=await settings();return ['127.0.0.1','localhost'].includes(u.hostname)&&u.protocol==='http:'&&u.port===new URL(config.backendUrl).port&&['/web/','/web/app.html','/','/app.html'].includes(u.pathname);}catch{return false;}
}
async function uiStatus(id){
  const config=await settings(),lane=validId(id)?await loadLane(id):null;
  return {ok:true,version:VERSION,paired:!!config.accountId,settings:{backendUrl:config.backendUrl,enabled:config.enabled,accountId:config.accountId,accountName:config.accountName},status:await get('bridgeStatus'),lane:lane&&{conversationId:lane.conversationId,accountId:lane.accountId,detail:lane.detail,ready:lane.ready,tabId:lane.bridge?.tabId,activeTask:lane.active?.task.id},active:(await allLanes()).some(l=>l.active)};
}
async function uiOperation(message,sender,isInternal=false){
  const op=message.operation||message.type;
  if(op==='ui-status')return uiStatus(message.conversationId);
  if(op==='web-pair'||op==='ui-save-settings')return pair(isInternal?message.settings||{}:message);
  if(op==='ui-open-workspace'){await openWorkspace();return {ok:true};}
  const config=await settings();
  if(!isInternal&&message.accountId!==config.accountId)throw new Error('本网页账号与扩展配置文件不一致；请到对应账号的浏览器窗口操作');
  if(op==='ui-wake'){kick();return {ok:true};}
  if(op==='ui-download-file'){
    if(!validId(message.conversationId)||!validId(message.taskId)||typeof message.fileName!=='string'||!message.fileName.trim()||message.fileName.length>160)throw new Error('无效下载请求');
    const other=(await allLanes()).find(l=>l.accountId===config.accountId&&l.active&&l.conversationId!==message.conversationId);if(other)throw new Error('工作页正在处理另一条消息，请完成后再下载');
    const task=await request('/api/tasks/'+encodeURIComponent(message.taskId));if(task.accountId!==config.accountId||task.conversationId!==message.conversationId||task.state!=='completed')throw new Error('文件所属任务尚未完成或账号不匹配');
    const inferred=(task.text||'').match(/已生成文件[：:\s]*(?:下载\s+)?([^\n]{1,160}\.[A-Za-z0-9]{1,12})/i)?.[1]?.trim(),allowed=(task.downloads||[]).some(file=>file.name===message.fileName)||inferred===message.fileName;if(!allowed)throw new Error('此任务没有登记该下载文件');
    const result=await ensureLane(message.conversationId,{focus:false}),reply=await chrome.tabs.sendMessage(result.lane.bridge.tabId,{type:'jsc-download-file',documentKey:result.lane.bridge.documentKey,taskMessage:task.message,fileName:message.fileName});if(!reply?.ok)throw new Error(reply?.error||'ChatGPT 文件下载按钮未响应');return {ok:true,name:message.fileName};
  }
  if(['ui-open-bridge','ui-prepare-bridge','ui-repair'].includes(op)){
    if(!config.enabled&&op==='ui-prepare-bridge')throw new Error('后台接单已暂停；消息未入队');
    await request('/api/me');
    const other=(await allLanes()).find(l=>l.accountId===config.accountId&&l.active&&l.conversationId!==message.conversationId);
    if(other){
      if(other.bridge?.tabId){await chrome.tabs.update(other.bridge.tabId,{active:true}).catch(()=>{});const tab=await chrome.tabs.get(other.bridge.tabId).catch(()=>null);if(tab)await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
      return {ok:true,ready:false,tabId:other.bridge?.tabId,detail:'此账号的唯一工作页正在处理另一会话；当前任务会自动排队'};
    }
    const taskList=await request('/api/tasks'),queuedOther=taskList.tasks.find(t=>!TERMINAL.has(t.state)&&t.conversationId!==message.conversationId);
    if(queuedOther){
      const shared=await get(ACCOUNT_TAB);if(shared?.tabId){await chrome.tabs.update(shared.tabId,{active:true}).catch(()=>{});const tab=await chrome.tabs.get(shared.tabId).catch(()=>null);if(tab)await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
      return {ok:true,ready:false,tabId:shared?.tabId,detail:'此账号已有其他会话排队或处理中；不会切走唯一工作页'};
    }
    const result=await ordered(message.conversationId,()=>ensureLane(message.conversationId,{focus:op!=='ui-prepare-bridge'}));
    kick();
    if(op==='ui-prepare-bridge'&&(!result.info.composer||(!result.lane.active&&(result.info.busy||result.info.hasDraft||result.info.activeTask))))throw new Error('本会话工作页尚未就绪、未登录、已有草稿或正在生成。消息未入队；请先点击“打开工作网页”处理后重试');
    return {ok:true,ready:!!result.info.composer,tabId:result.lane.bridge.tabId,detail:result.info.detail};
  }
  throw new Error('不支持的扩展操作');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  (async()=>{
    await boot;if(sender.id!==chrome.runtime.id)throw new Error('不可信扩展消息');
    if(sender.tab?.incognito)throw new Error('请使用独立浏览器配置文件；本版不使用无痕窗口共享账号状态');
    if(message?.type==='bridge-read-image'){if(sender.frameId!==0||!chatUrl(sender.url))throw new Error('不可信网页');return readImage(message.url);}
    if(message?.type==='bridge-event'){if(!chatUrl(sender.url))throw new Error('不可信网页');return forwardEvent(message,sender);}
    if(message?.type==='bridge-wake-tab'){if(sender.frameId!==0||!chatUrl(sender.url))throw new Error('不可信网页');return wakeHiddenWorkTab(message,sender);}
    if(message?.type==='bridge-hello'){
      if(sender.frameId!==0||!chatUrl(sender.url))throw new Error('不可信网页');
      const shared=await get(ACCOUNT_TAB),lanes=await allLanes(),lane=lanes.find(l=>l.conversationId===shared?.currentConversationId&&l.bridge?.tabId===sender.tab?.id)||lanes.find(l=>l.active&&l.bridge?.tabId===sender.tab?.id);if(lane)kick();return {ok:true,bound:!!lane};
    }
    if(message?.type==='doubao-web'){if(!await localPage(sender))throw new Error('拒绝非当前本机 GBT 地址的网页操作');return uiOperation(message,sender);}
    if(!internal(sender))throw new Error('只有扩展设置或本机 GBT 网页可执行此操作');return uiOperation(message,sender,true);
  })().then(r=>respond(r||{ok:true})).catch(error=>respond({ok:false,error:error.message||String(error),retry:!!(error.status===0||error.status>=500)}));return true;
});
async function openWorkspace(){await boot;const config=await settings();try{const h=await apiRequest(config,'/health');if(h.version!==VERSION)throw new Error('版本不匹配');await chrome.tabs.create({url:normalizeBaseUrl(config.backendUrl)+'/web/',active:true});}catch{await chrome.tabs.create({url:chrome.runtime.getURL('options.html')});}}
chrome.action.onClicked.addListener(()=>openWorkspace().catch(console.error));
chrome.alarms.onAlarm.addListener(a=>{if(a.name===ALARM)kick();});
chrome.runtime.onStartup.addListener(()=>kick());
chrome.runtime.onInstalled.addListener(details=>{if(details.reason==='install')chrome.tabs.create({url:chrome.runtime.getURL('options.html')});kick();});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete'||change.url)allLanes().then(lanes=>{if(lanes.some(l=>l.bridge?.tabId===tabId))kick();}).catch(()=>{});});
chrome.tabs.onRemoved.addListener(tabId=>{allLanes().then(async lanes=>{for(const l of lanes)if(l.bridge?.tabId===tabId)await ordered(l.conversationId,async()=>{const lane=await loadLane(l.conversationId);if(lane?.bridge?.tabId===tabId){lane.bridge.tabId=null;lane.bridge.documentKey=null;lane.ready=false;lane.detail='工作页已关闭，将仅按原会话地址尝试恢复';await saveLane(lane);}});kick();}).catch(()=>{});});
boot.then(()=>kick()).catch(console.error);
