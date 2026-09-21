/* DOM adapter only. No cookies, browser session extraction, private ChatGPT APIs or remote code. */
(() => {
  const VERSION='1.2.0';
  const documentKey=crypto.randomUUID();
  function conversationUrl(raw){try{const u=new URL(raw);return u.protocol==='https:'&&['chatgpt.com','chat.openai.com'].includes(u.hostname)&&/^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/[A-Za-z0-9_-]+$/.test(u.pathname)?'https://chatgpt.com'+u.pathname:'';}catch{return '';}}
  // Re-injection repairs this isolated world without reloading the ChatGPT page.
  try { globalThis.__JSCBridge?.dispose(); } catch {}
  const core=globalThis.JSCBridgeCore;
  if(!core)return;
  let disposed=false,active=null,helloTimer;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
  const pick=selector=>Array.from(document.querySelectorAll(selector)).find(visible) || null;
  const composer=()=>pick('textarea#prompt-textarea, [contenteditable="true"]#prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], textarea[data-testid="prompt-textarea"]');
  const fileInput=()=>Array.from(document.querySelectorAll('input[type="file"]')).find(el=>!el.disabled&&(!el.accept||/image|png|jpeg|jpg|webp|gif/i.test(el.accept)))||null;
  const modelPatterns={
    'gpt-5-6':[/^5\.6$/i,/^5\.6\s*(?:instant|即时)/i],
    'gpt-5-6-thinking':[/^5\.6\s*(?:thinking|思考)/i],
    'gpt-5-6-pro':[/^5\.6\s*pro/i],
    'gpt-6-pro':[/^6\s*pro/i]
  };
  const compactText=el=>elementText(el).replace(/GPT[- ]?/ig,'').replace(/\s+/g,' ').trim();
  const modelMatches=(el,slug)=>!!el&&modelPatterns[slug]?.some(pattern=>pattern.test(compactText(el)));
  function modelButton(){
    const candidates=Array.from(document.querySelectorAll('button[data-testid*="model" i],button[aria-label*="model" i],button[aria-label*="模型"],button[aria-haspopup="menu"],button[aria-haspopup="listbox"]')).filter(visible);
    return candidates.find(el=>Object.keys(modelPatterns).some(slug=>modelMatches(el,slug)))||null;
  }
  const sendButton=()=>pick('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="发送提示"], button[aria-label="发送消息"], button[aria-label="发送"]');
  const stopButton=()=>pick('button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="Stop streaming" i], button[aria-label*="停止生成"], button[aria-label="停止"]');
  const elementText=el=>(el?.innerText ?? el?.textContent ?? '').replace(/\u00a0/g,' ');
  const composerText=el=>('value' in el ? el.value : elementText(el));
  function users() {
    return Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node,index)=>{
      const id=node.getAttribute('data-message-id') || node.closest('[data-message-id]')?.getAttribute('data-message-id');
      const text=elementText(node);return {node,text,key:id?`id:${id}`:`index:${index}:${core.hash(text)}`};
    });
  }
  function assistantAfter(userNode) {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(node=>
      !!(userNode.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING));
  }
  function answerText(node) {
    const markdown=Array.from(node.querySelectorAll('.markdown')).filter(n=>!n.parentElement?.closest('.markdown'));
    return (markdown.length?markdown.map(elementText).join('\n\n'):elementText(node)).trim();
  }
  function generatedImageSource(src){
    try{
      const url=new URL(src,location.href);
      return url.protocol==='blob:'||url.protocol==='data:'||(url.hostname==='chatgpt.com'&&url.pathname==='/backend-api/estuary/content')||url.hostname==='oaidalleapiprodscus.blob.core.windows.net'||url.hostname.endsWith('.oaiusercontent.com');
    }catch{return false;}
  }
  function answerImages(node,userNode){
    if(!userNode)return [];
    const nextUser=Array.from(document.querySelectorAll('[data-message-author-role="user"]')).find(candidate=>candidate!==userNode&&!!(userNode.compareDocumentPosition(candidate)&Node.DOCUMENT_POSITION_FOLLOWING));
    const afterUser=img=>!userNode.contains(img)&&!!(userNode.compareDocumentPosition(img)&Node.DOCUMENT_POSITION_FOLLOWING)&&(!nextUser||!!(img.compareDocumentPosition(nextUser)&Node.DOCUMENT_POSITION_FOLLOWING));
    const turn=turnOf(node),local=[];
    if(node)local.push(...node.querySelectorAll('img'));
    if(turn&&turn!==node)local.push(...turn.querySelectorAll('img'));
    // Image-generation cards can be siblings of the assistant message node in the
    // current ChatGPT DOM. Search the current message interval as a fallback, but
    // only accept known OpenAI media URLs there so sidebar/profile images cannot leak in.
    const broad=Array.from((document.querySelector('main')||document).querySelectorAll('img')).filter(img=>afterUser(img)&&generatedImageSource(img.currentSrc||img.src));
    const localSet=new Set(local),seen=new Set();
    return [...local,...broad].filter(img=>{
      const src=img.currentSrc||img.src;
      if(!src||seen.has(src)||!afterUser(img)||!img.complete||img.naturalWidth<128||img.naturalHeight<128)return false;
      if(!localSet.has(img)&&!generatedImageSource(src))return false;
      seen.add(src);return true;
    });
  }
  async function responseImages(nodes){
    const result=[];for(const [index,img] of nodes.slice(0,4).entries()){
      const src=img.currentSrc||img.src;let blob;
      try{const response=await fetch(src,{credentials:'include',cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);blob=await response.blob();}catch{const remote=await message({type:'bridge-read-image',url:src});if(!remote?.ok)throw new Error(remote?.error||'扩展无法读取生成图片');result.push({name:(img.alt||`生成图片-${index+1}`).slice(0,120).replace(/[\\/]/g,'_'),mimeType:remote.mimeType,base64:remote.base64});continue;}
      const type=['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type)?blob.type:'image/png';if(!blob.size||blob.size>6_000_000)throw new Error('生成图片超过 6 MB，无法安全回传');
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取生成图片失败'));reader.readAsDataURL(blob);});
      result.push({name:(img.alt||`生成图片-${index+1}`).slice(0,120).replace(/[\\/]/g,'_'),mimeType:type,base64:dataUrl.slice(dataUrl.indexOf(',')+1)});
    }return result;
  }
  function turnOf(node) {return node?.closest('[data-testid^="conversation-turn-"], article, [data-turn]') || node?.parentElement;}
  function completionAction(node) {
    const turn=turnOf(node);if(!turn)return false;
    return Array.from(turn.querySelectorAll('[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], [data-testid="bad-response-turn-action-button"], button[aria-label="Copy response"], button[aria-label="复制回复"]'))
      .some(el=>visible(el)&&!el.disabled&&!el.closest('pre,code'));
  }
  function pageProgress(node) {
    const region=turnOf(node) || document.querySelector('main') || document;
    const statuses=Array.from(region.querySelectorAll('[role="status"], [data-testid="thinking-status"], [data-testid="web-search-status"]')).filter(visible).map(elementText).join(' ');
    const searching=/searching|browsing|搜索中|正在搜索|正在检索|正在浏览/i.test(statuses);
    const thinking=/thinking|思考中|正在思考/i.test(statuses);
    const busy=!!stopButton()||!!Array.from(region.querySelectorAll('[aria-busy="true"]')).find(visible)||searching||thinking;
    return {searching,busy,detail:searching?'ChatGPT 正在搜索，请保持工作标签页打开':thinking?'ChatGPT 正在思考':busy?'ChatGPT 正在生成':'等待明确的回复完成标记'};
  }
  async function message(value) {
    if(disposed||!chrome.runtime?.id)throw new Error('扩展上下文已失效');
    try { return await chrome.runtime.sendMessage(value); }
    catch(error) {
      if(/context invalidated|Extension context/i.test(error.message || ''))dispose();
      throw error;
    }
  }
  async function emit(job,eventType,values={}) {
    const packet={type:'bridge-event',id:job.task.id,accountId:job.task.accountId,conversationId:job.task.conversationId,documentKey,eventId:crypto.randomUUID(),eventType,...values};
    let backoff=500;
    while(!disposed&&!job.cancelled&&Date.now()<job.deadline){
      try{
        const response=await message(packet);
        if(response?.ok){
          if(response.terminal&&!['done','error','interrupted'].includes(eventType)){
            if(response.state==='cancelled')stopIfOwned(job);job.cancelled=true;throw new Error('任务已结束');
          }return response;
        }
        if(response?.retry===false)throw Object.assign(new Error(response.error || '事件回传失败'),{fatal:true});
      }catch(error){if(error.fatal||disposed||job.cancelled)throw error;}
      await sleep(backoff);backoff=Math.min(5000,backoff*2);
    }
    throw new Error('页面连接已中断或任务超时');
  }
  function fill(el,value) {
    el.focus();
    if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){
      const prototype=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,value);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }else{
      // Select only this editor's contents, never document-wide selectAll.
      const range=document.createRange();range.selectNodeContents(el);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      const inserted=document.execCommand('insertText',false,value);
      if(!inserted){el.textContent=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}
    }
  }
  function attachmentFile(attachment){
    if(!attachment||typeof attachment.base64!=='string'||!/^(image\/(?:png|jpeg|webp|gif))$/.test(attachment.mimeType||''))throw new Error('图片附件格式无效');
    const binary=atob(attachment.base64);if(!binary.length||binary.length>1_500_000)throw new Error('图片附件大小无效');
    const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new File([bytes],String(attachment.name||'图片').slice(0,120),{type:attachment.mimeType});
  }
  async function attachImages(items){
    if(!items?.length)return;
    let input=fileInput();
    if(!input){
      const attach=pick('button[data-testid*="attach" i], button[aria-label*="Attach" i], button[aria-label*="Upload" i], button[aria-label*="添加"], button[aria-label*="上传"]');attach?.click();
      const deadline=Date.now()+3000;while(!input&&Date.now()<deadline){await sleep(100);input=fileInput();}
    }
    if(!input)throw new Error('没有找到 ChatGPT 图片上传入口；请刷新工作页或检查当前模型是否支持图片');
    const transfer=new DataTransfer();for(const item of items)transfer.items.add(attachmentFile(item));
    input.files=transfer.files;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(600);
  }
  async function selectModel(slug){
    if(!slug)return;
    if(!modelPatterns[slug])throw new Error('不支持的模型选择');
    let trigger=modelButton();if(trigger&&modelMatches(trigger,slug))return;
    if(!trigger)throw new Error('没有找到 ChatGPT 模型选择器；请确认当前账号可切换模型');
    trigger.click();let option=null;const menuDeadline=Date.now()+5000;
    while(!option&&Date.now()<menuDeadline){option=Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],[data-radix-collection-item],button')).filter(el=>visible(el)&&el!==trigger).find(el=>modelMatches(el,slug));if(!option)await sleep(100);}
    if(!option)throw new Error('当前 ChatGPT 账号没有提供所选模型：'+slug);
    option.click();const confirmDeadline=Date.now()+5000;
    while(Date.now()<confirmDeadline){await sleep(100);trigger=modelButton();if(trigger&&modelMatches(trigger,slug))return;}
    throw new Error('模型切换没有生效；为避免用错模型，本条消息未发送');
  }
  function stopIfOwned(job) {
    const list=users(),index=core.locateUser(list,job.checkpoint,job.task.message);
    // Never stop a later request that the user sent manually.
    if(index>=0&&index===list.length-1)stopButton()?.click();
  }
  async function execute(job) {
    try {
      const cp=job.checkpoint;
      if(job.expectedUrl&&conversationUrl(location.href)!==job.expectedUrl)throw new Error('工作网页已切换到其他会话，停止采集以免串聊');
      const recovering=job.task.submitted||['submitting','submitted','observing','finished'].includes(cp.phase);
      if(!recovering){
        if(!job.expectedUrl&&(conversationUrl(location.href)||users().length))throw new Error('新会话工作页已含其他对话，禁止接管');
        const el=composer();
        if(!el)throw new Error('没有找到 ChatGPT 输入框。请登录并进入正常聊天页，再检查页面适配器。');
        if(stopButton())throw new Error('ChatGPT 正在处理另一条请求，未发送当前任务');
        if(core.normalize(composerText(el)))throw new Error('工作标签页输入框已有草稿，为避免覆盖未发送本任务，请先处理草稿');
        cp.baselineKeys=users().map(u=>u.key);cp.url=location.href;cp.phase='prepared';
        await selectModel(job.task.model||'');cp.model=job.task.model||'';
        await emit(job,'checkpoint',{checkpoint:cp});
        fill(el,job.task.message);
        await attachImages(job.task.attachments||[]);
        let send=null;const sendDeadline=Date.now()+10_000;
        while(!disposed&&!job.cancelled&&Date.now()<sendDeadline){
          send=sendButton();if(send&&!send.disabled&&send.getAttribute('aria-disabled')!=='true')break;
          await sleep(150);
        }
        if(!send||send.disabled||send.getAttribute('aria-disabled')==='true')throw new Error('发送按钮不可用；请检查登录、模型额度或输入框适配');
        cp.phase='submitting';cp.submittedAt=Date.now();
        // Commit the uncertain-side-effect barrier to local storage AND backend before clicking.
        // A crash here may require manual retry; it must NEVER cause automatic duplicate submission.
        await emit(job,'submitting',{checkpoint:cp});
        if(disposed||job.cancelled)return;
        send.click();cp.phase='submitted';
      }
      let lastText=job.task.text || '',lastMedia='',lastChange=Date.now(),lastPush=0,lastProgress=0,missingSince=0,lastDetail='';
      while(!disposed&&!job.cancelled&&Date.now()<job.deadline){
        const expected=job.expectedUrl||conversationUrl(cp.url);
        if(expected&&conversationUrl(location.href)!==expected)throw new Error('网页导航到了其他会话，已停止采集');
        const list=users(),index=core.locateUser(list,cp,job.task.message);
        if(index<0){
          if(!missingSince)missingSince=Date.now();
          if(Date.now()-missingSince>45_000)throw new Error('无法确认原消息所在位置。为避免重复发送或读错会话，已停止自动操作；请回到原会话核对。');
          await sleep(350);continue;
        }
        missingSince=0;
        if(index!==list.length-1)throw new Error('工作标签页出现另一条用户消息，当前采集已中断，以免混入其他回复');
        if(cp.userKey!==list[index].key||cp.url!==location.href){
          cp.userKey=list[index].key;cp.url=location.href;cp.phase='observing';
          await emit(job,'checkpoint',{checkpoint:cp});
        }
        const nodes=assistantAfter(list[index].node),newest=nodes.at(-1);
        const text=nodes.map(answerText).filter(Boolean).join('\n\n'),media=answerImages(newest,list[index].node),mediaKey=media.map(img=>(img.currentSrc||img.src)+':'+img.naturalWidth+'x'+img.naturalHeight).join('|');
        const responseNode=media.at(-1)||newest,progress=pageProgress(responseNode),now=Date.now();
        if(text!==lastText){lastText=text;lastChange=now;}
        if(mediaKey!==lastMedia){lastMedia=mediaKey;lastChange=now;}
        if(now-lastPush>=500&&text!==job.lastPushedText){
          // Full snapshots replace earlier text. DOM rewrites do not append duplicate paragraphs.
          await emit(job,'snapshot',{text,checkpoint:cp});job.lastPushedText=text;lastPush=now;
        }
        if(progress.detail!==lastDetail||now-lastProgress>12_000){
          await emit(job,'progress',{detail:progress.detail,checkpoint:cp});lastDetail=progress.detail;lastProgress=now;
        }
        if(core.mayComplete({text,hasMedia:media.length>0,busy:progress.busy,searching:progress.searching,completionAction:completionAction(responseNode)||media.length>0,stableMs:now-lastChange})){
          const images=await responseImages(media);cp.phase='finished';await emit(job,'done',{text,images,checkpoint:cp});return;
        }
        const turn=turnOf(newest);
        const error=Array.from(turn?.querySelectorAll('[role="alert"]') || []).filter(visible).map(elementText).join(' ');
        if(/something went wrong|error generating|出错|出了点问题|达到.*限制|usage limit|rate limit/i.test(error))throw new Error('ChatGPT 页面提示错误：'+error.slice(0,250));
        await sleep(250);
      }
      if(!disposed&&!job.cancelled)throw new Error('等待回复超时；部分内容已保留，未自动重新发送');
    }catch(error){
      if(!disposed&&!job.cancelled){
        // A short grace period allows reporting a timeout to the backend, without resending the prompt.
        job.deadline=Math.max(job.deadline,Date.now()+10_000);
        await emit(job,'interrupted',{detail:error.message || String(error),checkpoint:job.checkpoint}).catch(()=>{});
      }
    }finally{if(active===job)active=null;announce();}
  }
  function onMessage(packet,sender,respond) {
    if(disposed)return;
    if(packet?.type==='jsc-ping'){
      respond({ok:true,version:VERSION,documentKey,href:location.href,userCount:users().length,composer:!!composer(),busy:!!stopButton(),hasDraft:!!core.normalize(composerText(composer() || {})),activeTask:active?.task.id || null,detail:composer()?'ChatGPT 页面已连接': 'ChatGPT 输入框未就绪，请登录或进入聊天页面'});return;
    }
    if(packet?.type==='jsc-run'){
      if(packet.documentKey!==documentKey||!packet.task?.accountId||!packet.task?.conversationId||!packet.task?.id||typeof packet.task.message!=='string'||!['','gpt-5-6','gpt-5-6-thinking','gpt-5-6-pro','gpt-6-pro'].includes(packet.task.model||'')){respond({ok:false,error:'无效任务'});return;}
      if(active){respond({ok:active.task.id===packet.task.id,error:active.task.id===packet.task.id?undefined:'页面仍在处理上一条任务'});return;}
      const job={task:packet.task,expectedUrl:conversationUrl(packet.expectedUrl),checkpoint:structuredClone(packet.checkpoint || {}),deadline:packet.task.deadline || Date.now()+900_000,cancelled:false,lastPushedText:packet.task.text || ''};
      active=job;respond({ok:true});execute(job);return;
    }
    if(packet?.type==='jsc-release'){
      if(active?.task.id===packet.id){if(packet.state!=='completed')stopIfOwned(active);active.cancelled=true;}
      respond({ok:true});return;
    }
  }
  async function announce(){
    if(disposed)return;
    try{await message({type:'bridge-hello'});}catch{}
  }
  function dispose(){
    disposed=true;clearInterval(helloTimer);if(active)active.cancelled=true;
    try{chrome.runtime.onMessage.removeListener(onMessage);}catch{}
  }
  globalThis.__JSCBridge={version:VERSION,dispose};
  chrome.runtime.onMessage.addListener(onMessage);
  helloTimer=setInterval(announce,15_000);announce();
})();
