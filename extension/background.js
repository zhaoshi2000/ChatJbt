import {DEFAULT_URL,VERSION,TERMINAL,normalizeBaseUrl,apiRequest} from './shared.js';
import {chatUrl,conversationUrl,validId,assertTask,assertPacket,planTaskIds} from './lane-core.js';
const storage=chrome.storage.local, PREFIX='lane:', ALARM='doubao-multi-recover';
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
  // Tab IDs are only meaningful for the current browser lifetime. Never trust
  // a persisted numerical ID after browser restart or extension reload.
  const session=await chrome.storage.session.get('doubaoSession');
  if(!session.doubaoSession){
    for(const lane of await allLanes()){
      if(lane.bridge)lane.bridge={...lane.bridge,tabId:null,documentKey:null};
      await saveLane(lane);
    }
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
function kick(delay=0){if(cyclePromise){if(delay===0)rerun=true;return;}clearTimeout(timer);timer=setTimeout(()=>runCycle().catch(()=>{}),delay);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ping(tabId){let timeout;try{return await Promise.race([chrome.tabs.sendMessage(tabId,{type:'jsc-ping'}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('页面响应超时')),3000);})]);}catch{return null;}finally{clearTimeout(timeout);}}
async function ensureContent(tabId,waitMs=60_000){
  const deadline=Date.now()+waitMs;let tab,lastInfo,reloaded=false;
  while(Date.now()<deadline){
    tab=await chrome.tabs.get(tabId);
    if(tab.discarded&&!reloaded){await chrome.tabs.reload(tabId).catch(()=>{});reloaded=true;continue;}
    const url=tab.url||tab.pendingUrl||'';
    if(chatUrl(url)){
      let info=await ping(tabId);
      if(!info||info.version!==VERSION){await chrome.scripting.executeScript({target:{tabId},files:['bridge-core.js','content.js'],injectImmediately:true}).catch(()=>{});info=await ping(tabId);}
      if(info?.ok&&info.version===VERSION){lastInfo=info;if(info.composer)return {tab,info};}
    }else if(tab.status==='complete'&&url&&!/^(edge|chrome):\/\/newtab/.test(url))throw new Error('工作标签页没有进入 ChatGPT，请检查登录或站点权限');
    await pause(250);
  }
  if(tab){await chrome.tabs.update(tabId,{active:true}).catch(()=>{});await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
  throw new Error(lastInfo?.detail||'已自动打开工作页，但 ChatGPT 输入框长时间未就绪；请在弹出的页面完成登录后重试');
}
async function ensureLane(conversationId,{focus=false}={}) {
  const config=await settings();if(!config.accountId)throw new Error('请先使用账号专属令牌配对');
  if(!validId(conversationId))throw new Error('请先新建一个本地会话');
  const conversation=await request('/api/conversations/'+conversationId);
  if(conversation.accountId!==config.accountId)throw new Error('此会话不属于当前浏览器绑定的账号');
  let lane=await loadLane(conversationId)||{conversationId,accountId:config.accountId,bridge:null,active:null,detail:''};
  if(lane.accountId!==config.accountId)throw new Error('旧工作区绑定与本账号不同，拒绝复用');
  const expected=conversationUrl(conversation.upstreamUrl)||conversationUrl(lane.active?.checkpoint?.url);
  let tab;
  if(lane.bridge?.tabId)try{tab=await chrome.tabs.get(lane.bridge.tabId);}catch{}
  if(tab&&!chatUrl(tab.url||tab.pendingUrl))throw new Error('工作标签页已离开 ChatGPT。关闭该标签页后点“打开工作网页”恢复原会话，不能在别的页面继续。');
  if(tab?.discarded)await chrome.tabs.reload(tab.id).catch(()=>{});
  if(!tab){
    if(lane.active?.task.submitted&&!expected)throw new Error('原提交没有确认会话地址，无法安全恢复。请停止此任务并到原网页核对，不会重复发送。');
    tab=await chrome.tabs.create({url:expected||'https://chatgpt.com/',active:focus});
    lane.bridge={tabId:tab.id,url:expected||'https://chatgpt.com/',autoDiscardable:tab.autoDiscardable!==false,documentKey:null};await saveLane(lane);
  }
  if(focus){await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true}).catch(()=>{});}
  const bound=await ensureContent(tab.id), actual=conversationUrl(bound.info.href||bound.tab.url);
  if(expected&&actual!==expected)throw new Error('工作网页地址与本地会话不一致，已阻止串聊。请恢复原对话地址：'+expected);
  if(!expected&&!lane.active?.task.submitted&&(actual||bound.info.userCount>0))throw new Error('新建会话的工作页已有其他聊天内容。请关闭该工作页后重新打开，不会接管已有对话。');
  if(lane.active?.task.submitted&&lane.bridge.documentKey&&lane.bridge.documentKey!==bound.info.documentKey&&!expected)
    throw new Error('提交后的页面已被替换，且没有安全恢复地址。请停止并核对原网页。');
  lane.bridge={...lane.bridge,tabId:tab.id,documentKey:bound.info.documentKey,url:bound.info.href||bound.tab.url};
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
    a.checkpoint={...a.checkpoint,...packet.checkpoint};
    a.pending={id:a.task.id,accountId:lane.accountId,conversationId:lane.conversationId,clientId:await get('clientId'),lease:a.task.lease,seq:a.seq+1,eventId:packet.eventId,type:packet.eventType,checkpoint:a.checkpoint};
    if(typeof packet.text==='string')a.pending.text=packet.text.slice(0,1_000_000);
    if(packet.images!==undefined){if(!Array.isArray(packet.images)||packet.images.length>4||packet.images.some(x=>!x||typeof x.name!=='string'||typeof x.mimeType!=='string'||typeof x.base64!=='string'||x.base64.length>8_100_000))throw new Error('回复图片数据无效');a.pending.images=packet.images;}
    if(typeof packet.detail==='string')a.pending.detail=packet.detail.slice(0,600);
    if(packet.eventType==='submitting')a.task.submitted=true;
    await saveLane(lane);lane=await flush(lane);
    return {ok:true,state:lane.active.task.state,terminal:TERMINAL.has(lane.active.task.state)};
  });
}
async function release(lane,state){
  if(lane.bridge?.tabId&&lane.active)await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-release',id:lane.active.task.id,state}).catch(()=>{});
  if(lane.bridge?.tabId)await chrome.tabs.update(lane.bridge.tabId,{autoDiscardable:lane.bridge.autoDiscardable!==false}).catch(()=>{});
  lane.active=null;await saveLane(lane);
}
async function workLane(id,summary,enabled){
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
      if(!bound.info.composer||(!lane.active&&(bound.info.busy||bound.info.hasDraft||bound.info.activeTask)))throw new Error(bound.info.hasDraft?'工作网页有未发送的草稿，不会覆盖；请先处理草稿':'工作网页尚未就绪、未登录或正在生成其他消息');
      const result=await request('/api/browser/poll',{method:'POST',body:{clientId:await get('clientId'),conversationId:id,waitSeconds:0}});
      if(!result.task)return;
      const task=result.task;assertTask(task,lane.accountId,id);
      if(lane.active&&lane.active.task.id!==task.id)throw new Error('会话任务发生冲突，停止自动切换');
      if(!lane.active)lane.active={task:{...task,text:''},seq:task.lastSeq||0,checkpoint:task.checkpoint||{},pending:null,lastAck:''};
      else{lane.active.task={...task,text:'',submitted:task.submitted||lane.active.task.submitted};lane.active.seq=Math.max(lane.active.seq,task.lastSeq||0);}
      await saveLane(lane);await chrome.tabs.update(lane.bridge.tabId,{autoDiscardable:false}).catch(()=>{});
      const reply=await chrome.tabs.sendMessage(lane.bridge.tabId,{type:'jsc-run',task:{...task,submitted:lane.active.task.submitted},checkpoint:lane.active.checkpoint,documentKey:lane.bridge.documentKey,expectedUrl:bound.expected});
      if(!reply?.ok)throw new Error(reply?.error||'页面未接受任务');
      lane.detail='本会话正在独立生成';lane.ready=true;await saveLane(lane);
    }catch(error){
      lane=await loadLane(id);
      if(lane){lane.detail=error.message||String(error);lane.ready=false;await saveLane(lane);}
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
      const ids=planTaskIds(config.enabled?tasks:[],active,me.maxConcurrent||3);
      await Promise.all(ids.map(id=>workLane(id,tasks.find(t=>t.conversationId===id&&!TERMINAL.has(t.state)),config.enabled)));
      const updated=(await allLanes()).filter(l=>l.accountId===config.accountId),count=updated.filter(l=>l.active).length;
      await request('/api/bridge/heartbeat',{method:'POST',body:{clientId:await get('clientId'),ready:config.enabled,activeCount:count,detail:config.enabled?'独立账号桥接在线；每个会话使用独立工作标签页':'已暂停领取新任务'}});
      await setStatus({backend:'online',ready:config.enabled,activeCount:count,accountId:config.accountId,detail:config.enabled?'账号桥接在线':'已暂停接单'});failures=0;
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
      if(me.role!=='account')throw new Error('管理员令牌不能直接桥接。请在逗包网页“账号管理”创建账号，使用返回的账号专属令牌');
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
  if(['ui-open-bridge','ui-prepare-bridge','ui-repair'].includes(op)){
    if(!config.enabled&&op==='ui-prepare-bridge')throw new Error('后台接单已暂停；消息未入队');
    await request('/api/me');
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
    if(message?.type==='bridge-hello'){
      if(sender.frameId!==0||!chatUrl(sender.url))throw new Error('不可信网页');
      const lane=(await allLanes()).find(l=>l.bridge?.tabId===sender.tab?.id);if(lane)kick();return {ok:true,bound:!!lane};
    }
    if(message?.type==='doubao-web'){if(!await localPage(sender))throw new Error('拒绝非当前本机逗包地址的网页操作');return uiOperation(message,sender);}
    if(!internal(sender))throw new Error('只有扩展设置或本机逗包网页可执行此操作');return uiOperation(message,sender,true);
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
