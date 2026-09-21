import {VERSION,TERMINAL,apiRequest,parseSse,stateLabel,taskMarkdown} from './shared.js';
import {webWorker} from './web-rpc.js';
import {renderMarkdown} from './render.js';
const $=id=>document.getElementById(id),KEY='doubao.v12.connection';
const parse=(s,fallback)=>{try{return JSON.parse(s)||fallback;}catch{return fallback;}};
let saved=parse(localStorage.getItem(KEY),{}),config={backendUrl:location.origin,token:saved.token||'',enabled:saved.enabled!==false};
let account=null,provider='browser',conversations=[],summaries=[],tasks=[],current=null,epoch=0,refreshing=false,sending=false,mode='chat',toastTimer,attachments=[],openHistoryMenu=null,actionConversationId='',bannerTaskId='',dialogDeleteArmed=false;
let selected=new URL(location.href).searchParams.get('c')||'',createDraftId='';
const streams=new Map();
let lastAuth=0,newCredential=null;
const validId=id=>/^[A-Za-z0-9_-]{8,100}$/.test(id||'');
const modelLabel=value=>({'gpt-5-6':'6 · 即时','gpt-5-6-thinking':'6 · 中','gpt-5-6-thinking-standard':'6 · 中','gpt-5-6-thinking-extended':'6 · 高','gpt-5-6-thinking-max':'6 · 极高','gpt-5-6-pro':'6 Pro','gpt-6-pro':'6 Pro'}[value]||'当前模型');
if(!validId(selected))selected='';
function banner(text,taskId=''){bannerTaskId=taskId;$('banner').textContent=text;$('banner').hidden=!text;}
function clearTaskBanner(taskId){if(taskId&&bannerTaskId===taskId)banner('');}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function showDialog(id){$(id).showModal();}
function result(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
function draftKey(id=selected){return 'doubao.v12.draft:'+account?.id+':'+(id||'new');}
function pendingKey(id=selected){return 'doubao.v12.pending:'+account?.id+':'+id;}
function pending(){return account&&selected?parse(sessionStorage.getItem(pendingKey()),null):null;}
function saveDraft(){if(account)sessionStorage.setItem(draftKey(),$('input').value);}
function restoreDraft(){const p=pending();$('input').value=p?.message||sessionStorage.getItem(draftKey())||'';autosize();updateComposer();}
function autosize(){$('input').style.height='auto';$('input').style.height=Math.min(190,Math.max(62,$('input').scrollHeight))+'px';}
function activeTask(){return tasks.find(t=>!TERMINAL.has(t.state));}
function updateComposer(){const p=pending(),active=activeTask();$('input').readOnly=!!p;$('attachImage').disabled=!!p||!!active||sending;$('send').disabled=sending||(!p&&!!active);$('send').textContent=p?'重试确认':sending?'检查中…':'发送 ↑';$('cancelTask').hidden=!active;$('composerHint').textContent=p?'发送结果待确认，不会重复创建任务':active?'此会话正在生成':attachments.length?`已添加 ${attachments.length} 张图片`:account?'仅发送到 '+account.name:'请先连接账号';}
function applyUrl(){const u=new URL(location.href);u.search='';if(selected)u.searchParams.set('c',selected);history.replaceState(null,'',u.pathname+u.search);document.title=(current?.title||'新对话')+' · '+(account?.name||'逗包');}
function abortStreams(){for(const c of streams.values())c.abort();streams.clear();}
function clearCurrent(){abortStreams();tasks=[];current=null;$('messages').replaceChildren();$('welcome').hidden=false;renderHeader();}
function renderHeader(){$('accountName').textContent=account?.name||'未连接工作区';$('accountAvatar').textContent=account?.name?.slice(0,1)||'逗';$('accountSub').textContent=account?'账号独立 · 历史隔离':'点击配置账号';$('conversationTitle').textContent=current?.title||'新对话';$('scopeLabel').textContent=account?`${account.name} · ${provider==='browser'?'网页桥接':provider==='mock'?'本地模拟（非真实模型）':'API 模式'}`:'独立账号 · 独立会话 · 多网页';$('welcomeKicker').textContent=account?account.name+' 的独立聊天空间':'你的独立聊天空间';$('welcomeConnect').hidden=!!account;applyUrl();}
const actionIcons={copy:['<rect x="9" y="9" width="12" height="12" rx="2"/>','<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'],up:['<path d="M7 10v12H3V10h4Z"/>','<path d="M7 20h11.3a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 19.7 9H15l.7-3.4A3 3 0 0 0 12.8 2L7 10Z"/>'],down:['<path d="M7 14V2H3v12h4Z"/>','<path d="M7 4h11.3a2 2 0 0 1 2 1.6l1.4 7a2 2 0 0 1-2 2.4H15l.7 3.4a3 3 0 0 1-2.9 3.6L7 14Z"/>'],share:['<circle cx="18" cy="5" r="3"/>','<circle cx="6" cy="12" r="3"/>','<circle cx="18" cy="19" r="3"/>','<path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>'],retry:['<path d="M3 12a9 9 0 1 0 3-6.7"/>','<path d="M3 3v6h6"/>'],more:['<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/>','<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>','<circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>']};
function actionButton(kind,label,handler){const button=document.createElement('button');button.type='button';button.className='turn-action';button.title=label;button.setAttribute('aria-label',label);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');for(const source of actionIcons[kind]){const box=document.createElementNS('http://www.w3.org/2000/svg','g');box.innerHTML=source;while(box.firstChild)svg.append(box.firstChild);}button.append(svg);button.addEventListener('click',handler);return button;}
function setFeedback(taskId,value,up,down){const key='doubao.v12.feedback:'+taskId,current=localStorage.getItem(key),next=current===value?'':value;if(next)localStorage.setItem(key,next);else localStorage.removeItem(key);up.setAttribute('aria-pressed',String(next==='up'));down.setAttribute('aria-pressed',String(next==='down'));toast(next==='up'?'已标记为有帮助':next==='down'?'已标记为需改进':'已取消评价');}
async function shareReply(task){const text=task.text||'';if(navigator.share)try{await navigator.share({title:current?.title||'逗包回复',text});return;}catch(error){if(error.name==='AbortError')return;}await copyText(text);toast('回复已复制，可以粘贴分享');}
function regenerate(task){if(pending()||activeTask()){toast('请等待当前任务结束后再重新生成');return;}$('input').value=task.message;attachments=(task.attachments||[]).map(a=>({...a,bytes:Math.floor((a.base64?.length||0)*.75)}));renderAttachments();saveDraft();autosize();send();}
function closeHistoryMenu(){if(openHistoryMenu)openHistoryMenu.hidden=true;openHistoryMenu=null;}
function openConversationDialog(id){const c=conversations.find(x=>x.id===id);if(!c)return;actionConversationId=id;dialogDeleteArmed=false;$('deleteConversation').textContent='删除本地会话';$('renameTitle').value=c.title;$('pinConversation').textContent=c.pinned?'取消置顶':'置顶';showDialog('conversationDialog');}
function historyMenuButton(label,icon,handler,danger=false,keepOpen=false){const button=document.createElement('button');button.type='button';button.innerHTML=`<span aria-hidden="true">${icon}</span><span>${label}</span>`;if(danger)button.classList.add('danger');button.addEventListener('click',event=>{event.stopPropagation();if(!keepOpen)closeHistoryMenu();handler();});return button;}
function confirmHistoryDelete(c,menu){const text=document.createElement('p');text.className='history-delete-confirm';text.textContent='确定删除“'+c.title+'”？';const actions=document.createElement('div');actions.className='history-delete-actions';actions.append(historyMenuButton('确定删除','🗑',()=>deleteConversation(c.id),true),historyMenuButton('取消','×',closeHistoryMenu));menu.replaceChildren(text,actions);}
function renderHistory(){closeHistoryMenu();const q=$('search').value.trim().toLowerCase(),items=conversations.filter(c=>c.title.toLowerCase().includes(q));$('conversationCount').textContent=String(conversations.length);$('history').replaceChildren();
  for(const c of items){const row=document.createElement('div');row.className='history-row'+(c.id===selected?' active':'');const button=document.createElement('button');button.className='history-item';button.dataset.id=c.id;const label=document.createElement('span');label.className='label';label.textContent=c.title;button.append(label);if(c.pinned){const pin=document.createElement('span');pin.className='pin-mark';pin.textContent='⌖';pin.title='已置顶';button.append(pin);}if(summaries.some(t=>t.conversationId===c.id&&!TERMINAL.has(t.state))){const dot=document.createElement('span');dot.className='running-dot';dot.title='正在生成';button.append(dot);}button.addEventListener('click',()=>{closeHistoryMenu();select(c.id);});const more=document.createElement('button');more.type='button';more.className='history-more';more.textContent='•••';more.title='会话操作';more.setAttribute('aria-label',c.title+' 的操作');const menu=document.createElement('div');menu.className='history-menu';menu.hidden=true;menu.append(historyMenuButton('分享','↗',()=>shareConversation(c.id)),historyMenuButton('重命名','✎',()=>openConversationDialog(c.id)),historyMenuButton(c.pinned?'取消置顶':'置顶','⌖',()=>setPinned(c.id,!c.pinned)),historyMenuButton('删除','🗑',()=>confirmHistoryDelete(c,menu),true,true));more.addEventListener('click',event=>{event.stopPropagation();const opening=menu.hidden;closeHistoryMenu();if(opening){menu.hidden=false;openHistoryMenu=menu;}});row.append(button,more,menu);$('history').append(row);}
  if(!items.length){const el=document.createElement('div');el.className='empty-history';el.textContent=q?'没有匹配的会话':account?'此账号还没有会话，开始新对话吧':'连接账号后查看独立历史';$('history').append(el);}
}
function turnElement(task){let row=document.getElementById('turn-'+task.id);if(row)return row;row=document.createElement('article');row.id='turn-'+task.id;row.className='turn';
  const user=document.createElement('div');user.className='user-message';const bubble=document.createElement('div');bubble.className='user-bubble';const userText=document.createElement('div');userText.textContent=task.message;bubble.append(userText);if(task.attachments?.length){const images=document.createElement('div');images.className='message-images';for(const a of task.attachments){if(!a.base64)continue;const img=document.createElement('img');img.src=`data:${a.mimeType};base64,${a.base64}`;img.alt=a.name||'已发送图片';images.append(img);}bubble.append(images);}user.append(bubble);
  const head=document.createElement('div');head.className='assistant-head';const icon=document.createElement('img');icon.src='avatar.png';icon.alt='逗包头像';const name=document.createElement('span');name.textContent='逗包';const tag=document.createElement('span');tag.className='state-tag';head.append(icon,name,tag);
  const answer=document.createElement('div');answer.className='answer';const detail=document.createElement('div');detail.className='task-detail';const actions=document.createElement('div');actions.className='turn-actions';
  const latest=()=>tasks.find(t=>t.id===task.id)||task,copy=actionButton('copy','复制回复',()=>copyText(latest().text||'')),up=actionButton('up','有帮助',()=>setFeedback(task.id,'up',up,down)),down=actionButton('down','需要改进',()=>setFeedback(task.id,'down',up,down)),share=actionButton('share','分享回复',()=>shareReply(latest())),retry=actionButton('retry','重新生成',()=>regenerate(latest())),menu=document.createElement('div'),more=actionButton('more','更多操作',()=>menu.hidden=!menu.hidden);
  menu.className='turn-menu';menu.hidden=true;const edit=document.createElement('button');edit.type='button';edit.textContent='编辑后再次提问';edit.addEventListener('click',()=>{menu.hidden=true;$('input').value=latest().message;saveDraft();autosize();$('input').focus();});const save=document.createElement('button');save.type='button';save.textContent='导出本条 Markdown';save.addEventListener('click',()=>{menu.hidden=true;download('逗包回复-'+task.id+'.md',taskMarkdown(latest()),'text/markdown;charset=utf-8');});menu.append(edit,save);const feedback=localStorage.getItem('doubao.v12.feedback:'+task.id);up.setAttribute('aria-pressed',String(feedback==='up'));down.setAttribute('aria-pressed',String(feedback==='down'));actions.append(copy,up,down,share,retry,more,menu);row.append(user,head,answer,detail,actions);return row;
}
function inferredDownloads(task){if(task.downloads?.length)return task.downloads;const name=(task.text||'').match(/已生成文件[：:\s]*(?:下载\s+)?([^\n]{1,160}\.[A-Za-z0-9]{1,12})/i)?.[1]?.trim();return name?[{name}]:[];}
function renderTasks(forceBottom=false){const box=$('conversation'),stick=forceBottom||box.scrollHeight-box.scrollTop-box.clientHeight<100;const ids=new Set(tasks.map(t=>'turn-'+t.id));
  for(const el of $('messages').children)if(!ids.has(el.id))el.remove();
  for(const task of tasks){const row=turnElement(task),answer=row.querySelector('.answer');
    if(row.dataset.version!==String(task.version)||row.dataset.state!==task.state){
      const remote=inferredDownloads(task).filter(file=>!(task.files||[]).some(saved=>saved.name===file.name)),signature=task.text+'|'+JSON.stringify([(task.images||[]).map(x=>[x.name,x.base64?.length]),(task.files||[]).map(x=>[x.id,x.name,x.size]),remote.map(x=>x.name)]);if(answer._content!==signature||(!task.text&&!task.images?.length&&!task.files?.length&&!remote.length&&row.dataset.state!==task.state)){answer._content=signature;if(task.text)renderMarkdown(answer,task.text);else answer.replaceChildren();if(task.images?.length){const images=document.createElement('div');images.className='message-images';for(const [index,a] of task.images.entries()){if(!a.base64)continue;const link=document.createElement('a');link.href=`data:${a.mimeType};base64,${a.base64}`;link.download=a.name||`生成图片-${index+1}`;link.title='点击下载生成图片';const img=document.createElement('img');img.src=link.href;img.alt=a.name||'生成图片';link.append(img);images.append(link);}answer.append(images);}if(task.files?.length||remote.length){const files=document.createElement('div');files.className='generated-files';for(const file of task.files||[]){const button=document.createElement('button');button.type='button';button.className='generated-file';button.innerHTML='<span aria-hidden="true">⇩</span><span></span><small></small>';button.children[1].textContent=file.name;button.querySelector('small').textContent=formatBytes(file.size);button.addEventListener('click',()=>downloadTaskFile(task,file,button));files.append(button);}for(const file of remote){const button=document.createElement('button');button.type='button';button.className='generated-file';button.innerHTML='<span aria-hidden="true">⇩</span><span></span><small>浏览器直接下载</small>';button.children[1].textContent=file.name;button.addEventListener('click',()=>downloadRemoteFile(task,file,button));files.append(button);}answer.append(files);}if(!task.text&&!task.images?.length&&!task.files?.length&&!remote.length){const el=document.createElement('span');el.className='empty';el.textContent=task.state==='queued'?'任务已进入本账号队列，等待此会话工作页接入…':TERMINAL.has(task.state)?'本次没有正文、图片或文件输出。':'正在等待本会话的回复…';answer.append(el);}}
      row.querySelector('.state-tag').textContent=stateLabel(task.state);row.querySelector('.task-detail').textContent=task.detail||'';row.querySelector('.turn-actions').hidden=!TERMINAL.has(task.state)||(!task.text&&!task.images?.length&&!task.files?.length&&!remote.length);row.dataset.version=String(task.version);row.dataset.state=task.state;
    }$('messages').append(row);
  }$('welcome').hidden=tasks.length>0;updateComposer();if(stick)box.scrollTop=box.scrollHeight;
}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch{toast('复制被浏览器阻止，请手动选择文本复制');}}
function formatBytes(value){const n=Number(value)||0;return n<1024?n+' B':n<1024*1024?(n/1024).toFixed(1)+' KB':(n/1024/1024).toFixed(1)+' MB';}
async function downloadTaskFile(task,file,button){const content=button.innerHTML;button.disabled=true;button.textContent='正在下载…';try{const response=await fetch(config.backendUrl+'/api/tasks/'+encodeURIComponent(task.id)+'/files/'+encodeURIComponent(file.id),{headers:{Authorization:'Bearer '+config.token},credentials:'omit',redirect:'error',cache:'no-store'});if(!response.ok)throw new Error('下载失败：HTTP '+response.status);const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file.name||'生成文件';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('已下载 '+a.download);}catch(error){banner(error.message);}finally{button.disabled=false;button.innerHTML=content;}}
async function downloadRemoteFile(task,file,button){const content=button.innerHTML;button.disabled=true;button.textContent='正在调用浏览器下载…';try{await webWorker('ui-download-file',{accountId:account.id,conversationId:task.conversationId,taskId:task.id,fileName:file.name});toast('浏览器已开始下载 '+file.name);}catch(error){banner(error.message);}finally{button.disabled=false;button.innerHTML=content;}}
function renderAttachments(){$('attachmentTray').replaceChildren();for(const [index,a] of attachments.entries()){const chip=document.createElement('div');chip.className='attachment-chip';const img=document.createElement('img');img.src=`data:${a.mimeType};base64,${a.base64}`;img.alt=a.name;const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='移除图片';remove.addEventListener('click',()=>{attachments.splice(index,1);renderAttachments();updateComposer();});chip.append(img,remove);$('attachmentTray').append(chip);}$('attachmentTray').hidden=!attachments.length;updateComposer();}
async function addImages(files){const allowed=new Set(['image/png','image/jpeg','image/webp','image/gif']);try{for(const file of files){if(attachments.length>=3)throw new Error('每条消息最多附带 3 张图片');if(!allowed.has(file.type))throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');if(file.size>1_500_000)throw new Error('单张图片须小于 1.5 MB');if(attachments.reduce((n,a)=>n+a.bytes,0)+file.size>1_800_000)throw new Error('每条消息的图片总大小须小于 1.8 MB');const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});attachments.push({name:file.name.slice(0,120).replace(/[\\/]/g,'_')||'图片',mimeType:file.type,base64:dataUrl.slice(dataUrl.indexOf(',')+1),bytes:file.size});}renderAttachments();}catch(error){banner(error.message);}}
function download(name,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function loadIdentity(){
  const myEpoch=epoch,local={...config};
  if(!local.token){account=null;$('connection').textContent='未连接';$('connection').classList.remove('online');renderHeader();return false;}
  const me=await apiRequest(local,'/api/me');if(myEpoch!==epoch)return false;
  if(me.version!==VERSION)throw new Error('请同时更新后端、网页和扩展到 '+VERSION+'，旧后端不支持账号隔离');
  if(me.role!=='account')throw new Error('这是管理员令牌，请先在“账号管理”创建账号，再使用账号专属令牌连接');
  account=me.account;provider=me.provider;lastAuth=Date.now();$('connection').textContent='后端在线';$('connection').classList.add('online');renderHeader();return true;
}
async function select(id){saveDraft();epoch++;selected=id;createDraftId='';clearCurrent();restoreDraft();$('sidebar').classList.remove('open');$('shade').hidden=true;renderHistory();banner('');await refresh(true);}
async function refresh(force=false){
  if(refreshing&&!force)return;refreshing=true;const e=epoch,cid=selected,local={...config};
  try{
    if(!account||Date.now()-lastAuth>30000){if(!await loadIdentity())return;}
    if(e!==epoch)return;
    const [c,t]=await Promise.all([apiRequest(local,'/api/conversations'),apiRequest(local,'/api/tasks')]);if(e!==epoch)return;
    conversations=c.conversations;summaries=t.tasks;renderHistory();
    if(cid){
      const detail=await apiRequest(local,`/api/conversations/${cid}/tasks`);if(e!==epoch||cid!==selected)return;
      if(detail.conversation.accountId!==account.id)throw new Error('会话账号不匹配，拒绝展示');
      current=detail.conversation;const latest=new Map(tasks.map(t=>[t.id,t]));tasks=detail.tasks.map(t=>latest.get(t.id)?.version>t.version?latest.get(t.id):t).sort((a,b)=>a.created-b.created);renderHeader();renderTasks();if(bannerTaskId&&tasks.some(t=>t.id===bannerTaskId&&TERMINAL.has(t.state)))banner('');
      const p=pending(),received=p&&tasks.find(x=>x.requestId===p.requestId);
      if(received){sessionStorage.removeItem(pendingKey());sessionStorage.removeItem(draftKey());if($('input').value===p.message)$('input').value='';updateComposer();}
      const active=activeTask();if(active&&!streams.has(active.id))observe(active,e,local);
    }
    if(provider==='browser'){
      try{const s=await webWorker('ui-status',{conversationId:cid});if(e!==epoch)return;
        if(s.settings?.accountId&&s.settings.accountId!==account.id)$('bridgeLabel').textContent='此浏览器配置文件绑定了其他账号，请使用对应的独立窗口';
        else if(!s.paired)$('bridgeLabel').textContent='网页已连接；请打开连接设置完成扩展配对';
        else $('bridgeLabel').textContent=s.lane?.detail||s.status?.detail||'账号桥接在线；发送时为本会话分配独立工作页';
      }catch{$('bridgeLabel').textContent='未检测到新版多账号扩展；安装后刷新此网页，不需要侧边栏';}
    }else $('bridgeLabel').textContent=provider==='mock'?'模拟模式：测试多网页与隔离，不会访问真实账号':'API 模式：只携带本账号、本会话最近 20 轮已完成消息';
  }catch(error){if(e!==epoch)return;
    if(error.status===404&&cid){epoch++;selected='';clearCurrent();restoreDraft();banner('这条会话不存在或已在其他网页删除；没有切换到别的账号。');}
    else{if(error.status===401){epoch++;account=null;conversations=[];summaries=[];clearCurrent();renderHistory();}$('connection').textContent='连接异常';$('connection').classList.remove('online');banner(error.message);}
  }finally{refreshing=false;updateComposer();}
}
async function observe(task,e,local){
  const controller=new AbortController();streams.set(task.id,controller);let lastActivity=Date.now();const watchdog=setInterval(()=>{if(Date.now()-lastActivity>35000)controller.abort();},5000);
  try{const response=await fetch(local.backendUrl+'/api/tasks/'+task.id+'/events',{headers:{Authorization:'Bearer '+local.token,Accept:'text/event-stream'},signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'});if(!response.ok||!response.body)throw new Error('实时订阅暂不可用');
    for await(const frame of parseSse(response.body,()=>lastActivity=Date.now())){if(e!==epoch||selected!==task.conversationId)break;const snapshot=JSON.parse(frame.data);if(snapshot.accountId!==account?.id||snapshot.conversationId!==selected||snapshot.id!==task.id)throw new Error('拒绝不属于本会话的流式消息');const previous=tasks.find(t=>t.id===snapshot.id);if(!previous||snapshot.version>=previous.version){tasks=tasks.filter(t=>t.id!==snapshot.id).concat(snapshot).sort((a,b)=>a.created-b.created);renderTasks();}if(TERMINAL.has(snapshot.state)){clearTaskBanner(snapshot.id);break;}}
  }catch(error){if(e===epoch&&!controller.signal.aborted)console.warn('Stream will resume from backend snapshot:',error.message);}
  finally{clearInterval(watchdog);if(streams.get(task.id)===controller)streams.delete(task.id);controller.abort();}
}
async function ensureConversation(text='新对话'){
  if(selected){if(!current){const c=await apiRequest(config,'/api/conversations/'+selected);if(c.accountId!==account.id)throw new Error('会话账号不匹配');current=c;}return current;}
  createDraftId=createDraftId||sessionStorage.getItem('doubao.v12.create:'+account.id)||crypto.randomUUID();sessionStorage.setItem('doubao.v12.create:'+account.id,createDraftId);
  const previousKey=draftKey(),draft=$('input').value,e=epoch;
  const c=await apiRequest(config,'/api/conversations',{method:'POST',body:{id:createDraftId,title:text.slice(0,50)}});if(e!==epoch)throw new Error('网页已切换会话，未发送消息');
  selected=c.id;current=c;createDraftId='';sessionStorage.removeItem('doubao.v12.create:'+account.id);sessionStorage.removeItem(previousKey);sessionStorage.setItem(draftKey(),draft);conversations=[c,...conversations.filter(x=>x.id!==c.id)];renderHeader();renderHistory();return c;
}
async function send(){
  if(sending)return;if(!account){openSettings();return;}
  const p=pending(),packetAttachments=p?.attachments||attachments.map(({name,mimeType,base64})=>({name,mimeType,base64}));let text=p?.message||$('input').value.trim();if(!text&&packetAttachments.length)text='请查看并分析这张图片。';if(!text)return;
  if(activeTask()&&!p){banner('本会话已有生成任务，可点击“多开一个网页”在其他会话独立提问。');return;}
  sending=true;updateComposer();banner('');let packet,pk,cid,e;
  try{
    const c=await ensureConversation(text);cid=c.id;e=epoch;
    if(e!==epoch||cid!==selected)throw new Error('已切换会话，消息未发送');
    packet=p||{requestId:crypto.randomUUID(),conversationId:cid,message:text,model:$('modelSelect').value,attachments:packetAttachments};pk=pendingKey(cid);try{sessionStorage.setItem(pk,JSON.stringify(packet));}catch{throw new Error('图片过大，浏览器无法保存待确认副本；请压缩图片后重试');}updateComposer();
    const response=await apiRequest(config,'/api/tasks',{method:'POST',body:packet,timeout:12000});
    sessionStorage.removeItem(pk);
    if(e!==epoch||cid!==selected)return;
    if(response.accountId!==account.id||response.conversationId!==cid)throw new Error('任务返回的账号或会话不匹配');
    sessionStorage.removeItem(draftKey());if($('input').value.trim()===text||(!$('input').value.trim()&&text==='请查看并分析这张图片。'))$('input').value='';attachments=[];renderAttachments();autosize();
    tasks=tasks.filter(t=>t.id!==response.id).concat(response).sort((a,b)=>a.created-b.created);summaries=[response,...summaries.filter(t=>t.id!==response.id)];renderTasks(true);renderHistory();
    if(provider==='browser'){banner('任务已提交，正在自动打开并唤醒 ChatGPT 工作页…',response.id);webWorker('ui-wake',{accountId:account.id,conversationId:cid}).catch(()=>{});}
    if(!streams.has(response.id))observe(response,e,{...config});
  }catch(error){
    if(pk&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==429)sessionStorage.removeItem(pk);
    if(e===undefined||e===epoch)banner(error.message+(pk&&sessionStorage.getItem(pk)?' 发送结果尚未确认，请点击“重试确认”；会沿用原请求编号，不会自动重发新任务。':''));
  }finally{sending=false;updateComposer();saveDraft();}
}
async function openWork(){if(!account){openSettings();return;}try{const c=await ensureConversation();const s=await webWorker('ui-open-bridge',{accountId:account.id,conversationId:c.id});banner(s.ready?'工作网页已就绪，切回这里继续聊天即可。':'工作网页已打开，请在其中登录对应账号并等待输入框出现。');}catch(error){banner(error.message);}}
function syncTokenActions(){$('copyCurrentToken').disabled=!$('token').value.trim();}
function openSettings(){$('backendUrl').value=location.origin;$('token').value=config.token;$('enabled').checked=config.enabled;$('quickSetup').hidden=!!config.token;syncTokenActions();result('settingsResult',config.token?'当前账号令牌可直接复制并粘贴到 GPT 桥接模块。':'');showDialog('settingsDialog');}
function openAdmin(){if($('settingsDialog').open)$('settingsDialog').close();showDialog('adminDialog');}
function clearAdmin(){$('adminToken').value='';$('createdToken').value='';$('credentialBox').hidden=true;newCredential=null;$('accountsList').replaceChildren();}
async function quickCreate(){const button=$('quickCreate');button.disabled=true;result('settingsResult','正在创建第一个账号…');try{const response=await apiRequest({backendUrl:location.origin},'/api/bootstrap-account',{method:'POST',body:{name:$('quickAccountName').value}});newCredential=response;$('token').value=response.token;$('quickSetup').hidden=true;$('confirmProfile').checked=false;syncTokenActions();await copyText(response.token);result('settingsResult','已创建 '+response.account.name+'，账号令牌已填入并复制。请勾选配置文件确认后保存配对，也可粘贴到 GPT 桥接模块。');}catch(error){result('settingsResult',error.message,true);}finally{button.disabled=false;}}
async function saveConnection(event){event.preventDefault();$('pairButton').disabled=true;result('settingsResult','正在验证账号…');
  const next={backendUrl:location.origin,token:$('token').value.trim(),enabled:$('enabled').checked};
  try{const me=await apiRequest(next,'/api/me');if(me.role!=='account')throw new Error('这是管理员令牌。点击“首次使用：创建账号”，创建后再用账号专属令牌配对');if(me.version!==VERSION)throw new Error('组件版本不匹配，请完整更新至 '+VERSION);
    let bridgeError='';
    if(me.provider==='browser')try{await webWorker('web-pair',{token:next.token,enabled:next.enabled,confirmProfile:$('confirmProfile').checked,profileLabel:me.account.name});}catch(error){bridgeError=error.message;}
    // Do not silently connect a webpage to a different account than its profile.
    if(bridgeError.includes('另一个账号')||bridgeError.includes('其他账号')||bridgeError.includes('其他浏览器')||bridgeError.includes('另一个浏览器')||bridgeError.includes('不一致'))throw new Error(bridgeError);
    saveDraft();epoch++;config=next;account=me.account;provider=me.provider;selected='';clearCurrent();conversations=[];summaries=[];renderHistory();restoreDraft();
    localStorage.setItem(KEY,JSON.stringify({...next,accountId:account.id}));lastAuth=0;
    result('settingsResult',bridgeError?'网页账号已连接；扩展仍未配对：'+bridgeError:'已连接 '+account.name+'。可以关闭设置开始聊天。',!!bridgeError);
    await refresh(true);
  }catch(error){result('settingsResult',error.message,true);}finally{$('pairButton').disabled=false;}
}
const adminConfig=()=>({backendUrl:location.origin,token:$('adminToken').value.trim()});
async function showCredential(response){newCredential=response;$('createdAccountTitle').textContent=response.account.name+' · 专属令牌';$('createdToken').value=response.token;$('credentialBox').hidden=false;result('adminResult','请保存专属令牌；不同账号要放在不同浏览器配置文件中。');}
async function createAccount(){$('createAccount').disabled=true;try{await showCredential(await apiRequest(adminConfig(),'/api/accounts',{method:'POST',body:{name:$('newAccountName').value}}));$('newAccountName').value='';await loadAccounts();}catch(error){result('adminResult',error.message,true);}finally{$('createAccount').disabled=false;}}
async function loadAccounts(){try{const r=await apiRequest(adminConfig(),'/api/accounts');$('accountsList').replaceChildren();for(const a of r.accounts){const row=document.createElement('div');row.className='account-row';const title=document.createElement('span');title.textContent=a.name;const note=document.createElement('small');note.textContent=a.clientId?'已绑定独立配置文件 · '+(a.profileLabel||a.clientId.slice(0,8)):'尚未绑定浏览器';title.append(note);const reset=document.createElement('button');reset.textContent='重置令牌与绑定';reset.addEventListener('click',async()=>{if(!confirm('重置 '+a.name+' 的令牌和浏览器绑定？旧令牌将失效，历史记录保留。'))return;try{await showCredential(await apiRequest(adminConfig(),'/api/accounts/'+a.id+'/rotate',{method:'POST',body:{}}));await loadAccounts();}catch(e){result('adminResult',e.message,true);}});row.append(title,reset);$('accountsList').append(row);}}catch(error){result('adminResult',error.message,true);}}
function conversationMarkdown(conversation=current,rows=tasks){return '# '+(conversation?.title||'逗包会话')+'\n\n账号：'+(account?.name||'')+'\n会话 ID：'+(conversation?.id||selected)+'\n\n'+rows.map(t=>taskMarkdown(t)).join('\n\n---\n\n');}
async function shareConversation(id){try{const detail=await apiRequest(config,`/api/conversations/${id}/tasks`),text=conversationMarkdown(detail.conversation,detail.tasks),title=detail.conversation.title;if(navigator.share)try{await navigator.share({title,text});return;}catch(error){if(error.name==='AbortError')return;}await copyText(text);toast('会话内容已复制，可以粘贴分享');}catch(error){toast(error.message);}}
async function setPinned(id,pinned){try{await apiRequest(config,'/api/conversations/'+id,{method:'POST',body:{pinned}});toast(pinned?'已置顶':'已取消置顶');await refresh(true);}catch(error){toast(error.message);}}
async function deleteConversation(id){try{await apiRequest(config,'/api/conversations/'+id,{method:'DELETE'});if($('conversationDialog').open)$('conversationDialog').close();if(id===selected)await select('');else await refresh(true);}catch(error){toast(error.message);}}
function suggestions(){const samples=mode==='chat'?['帮我把今天的想法整理成一份清单','一起构思一个有趣的科幻故事','给我讲清楚一个复杂的概念','帮我润色这段话，让表达更自然']:['把需求拆成可执行的开发任务','检查这段代码的边界条件与潜在问题','把会议记录整理成决策和待办','为这周的项目写一份工作总结'];$('suggestions').replaceChildren();for(const text of samples){const b=document.createElement('button');b.textContent=text;b.addEventListener('click',()=>{if(pending())return;$('input').value=text;saveDraft();autosize();$('input').focus();});$('suggestions').append(b);}}
$('settingsForm').addEventListener('submit',saveConnection);$('token').addEventListener('input',syncTokenActions);$('quickCreate').addEventListener('click',quickCreate);$('copyCurrentToken').addEventListener('click',()=>copyText($('token').value.trim()));$('createAccount').addEventListener('click',createAccount);$('loadAccounts').addEventListener('click',loadAccounts);
$('attachImage').addEventListener('click',()=>$('imageInput').click());$('imageInput').addEventListener('change',()=>{addImages($('imageInput').files);$('imageInput').value='';});$('input').addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.files||[]).filter(f=>f.type.startsWith('image/'));if(files.length){event.preventDefault();addImages(files);}});$('modelSelect').value=sessionStorage.getItem('doubao.v12.model')||'';$('modelSelect').addEventListener('change',()=>{sessionStorage.setItem('doubao.v12.model',$('modelSelect').value);toast('将使用 '+modelLabel($('modelSelect').value));});
$('copyAccountToken').addEventListener('click',()=>copyText($('createdToken').value));$('useAccount').addEventListener('click',()=>{if(!newCredential)return;const value=newCredential.token;$('adminDialog').close();openSettings();$('token').value=value;$('confirmProfile').checked=false;result('settingsResult','请确认这个浏览器配置文件属于所选账号，再保存并配对。');});
$('adminDialog').addEventListener('close',clearAdmin);
$('legacyExport').addEventListener('click',async()=>{try{const r=await apiRequest(adminConfig(),'/api/legacy-export');download('逗包-旧版归档.json',JSON.stringify(r,null,2),'application/json');}catch(e){result('adminResult',e.message,true);}});
$('diagnostics').addEventListener('click',async()=>{try{download('逗包-本账号诊断.json',JSON.stringify(await apiRequest(config,'/api/diagnostics'),null,2),'application/json');}catch(e){result('settingsResult',e.message,true);}});
$('forget').addEventListener('click',()=>{if(!confirm('只清除此浏览器配置文件中的逗包网页连接设置？不会停止后台任务或删除历史。'))return;localStorage.removeItem(KEY);location.reload();});
for(const id of ['accountCard','settingsButton','welcomeConnect'])$(id).addEventListener('click',openSettings);
$('openAdmin').addEventListener('click',openAdmin);$('fromSettingsAdmin').addEventListener('click',openAdmin);
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close());
$('send').addEventListener('click',send);$('input').addEventListener('input',()=>{saveDraft();autosize();});$('input').addEventListener('keydown',e=>{if(!e.isComposing&&e.keyCode!==229&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
$('newChat').addEventListener('click',()=>select(''));$('newPage').addEventListener('click',()=>window.open('/web/','_blank','noopener'));
$('openSame').addEventListener('click',()=>window.open('/web/'+(selected?'?c='+encodeURIComponent(selected):''),'_blank','noopener'));
$('openBridge').addEventListener('click',openWork);$('search').addEventListener('input',renderHistory);
$('cancelTask').addEventListener('click',async()=>{const t=activeTask();if(!t)return;try{await apiRequest(config,'/api/tasks/'+t.id+'/cancel',{method:'POST',body:{}});webWorker('ui-wake',{accountId:account.id,conversationId:selected}).catch(()=>{});await refresh(true);}catch(e){banner(e.message);}});
$('conversationMenu').addEventListener('click',()=>{if(!current){toast('开始对话后才有会话操作');return;}openConversationDialog(selected);});
$('rename').addEventListener('click',async()=>{const id=actionConversationId||selected;try{await apiRequest(config,'/api/conversations/'+id,{method:'POST',body:{title:$('renameTitle').value}});$('conversationDialog').close();await refresh(true);}catch(e){toast(e.message);}});
$('shareConversation').addEventListener('click',()=>{const id=actionConversationId||selected;$('conversationDialog').close();shareConversation(id);});
$('pinConversation').addEventListener('click',()=>{const id=actionConversationId||selected,c=conversations.find(x=>x.id===id);if(c)setPinned(id,!c.pinned);$('conversationDialog').close();});
$('deleteConversation').addEventListener('click',()=>{const id=actionConversationId||selected,c=conversations.find(x=>x.id===id);if(!dialogDeleteArmed){dialogDeleteArmed=true;$('deleteConversation').textContent='确定删除“'+(c?.title||'此会话')+'”';return;}deleteConversation(id);});
for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>{mode=b.dataset.mode;for(const x of document.querySelectorAll('[data-mode]'))x.classList.toggle('active',x===b);suggestions();});
for(const b of document.querySelectorAll('[data-template]'))b.addEventListener('click',()=>{if(pending())return;$('input').value=b.dataset.template;saveDraft();autosize();$('input').focus();});
$('showSidebar').addEventListener('click',()=>{$('sidebar').classList.add('open');$('shade').hidden=false;});function hideSidebar(){$('sidebar').classList.remove('open');$('shade').hidden=true;}$('closeSidebar').addEventListener('click',hideSidebar);$('shade').addEventListener('click',hideSidebar);
window.addEventListener('pagehide',()=>{saveDraft();abortStreams();});
document.addEventListener('click',closeHistoryMenu);document.addEventListener('keydown',event=>{if(event.key==='Escape')closeHistoryMenu();});
window.addEventListener('storage',e=>{if(e.key!==KEY)return;saveDraft();epoch++;saved=parse(e.newValue,{});config={backendUrl:location.origin,token:saved.token||'',enabled:saved.enabled!==false};account=null;conversations=[];summaries=[];clearCurrent();renderHistory();lastAuth=0;banner('连接设置已在另一个网页更新，正在重新校验账号。');refresh(true).then(restoreDraft);});
window.addEventListener('popstate',()=>{const id=new URL(location.href).searchParams.get('c');select(validId(id)?id:'');});
renderHeader();suggestions();updateComposer();
refresh(true).then(restoreDraft);setInterval(()=>refresh(),4000);
