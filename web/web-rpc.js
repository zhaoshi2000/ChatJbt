/** Local webpage -> isolated loopback content script -> background worker.
 * No extension id guessing, no generic fetch proxy and no retrieval of saved tokens. */
export async function webWorker(operation, extra={}) {
  for (let i=0;i<30&&!document.documentElement.dataset.doubaoLink;i++)
    await new Promise(resolve=>setTimeout(resolve,100));
  if (!document.documentElement.dataset.doubaoLink)
    throw new Error('未检测到“逗包 · 多账号后台桥接”。请加载本包 extension 文件夹，然后刷新本页；不需要打开侧边栏。');
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    // Opening a cold/discarded ChatGPT tab can take substantially longer than
    // an ordinary extension RPC. Keep the original single click alive while
    // the background waits for the composer instead of making the user click twice.
    const slow=new Set(['ui-open-bridge','ui-prepare-bridge','ui-repair']).has(operation);
    const timer=setTimeout(()=>{cleanup();reject(new Error('扩展响应超时，请检查扩展权限、版本和后端端口，然后重试。'));},slow?70000:20000);
    function cleanup(){clearTimeout(timer);window.removeEventListener('message',receive);}
    function receive(event){
      if(event.source!==window||event.origin!==location.origin)return;
      const m=event.data;
      if(m?.channel!=='doubao.web.response'||m.id!==id)return;
      cleanup();
      if(!m.result?.ok)reject(new Error(m.result?.error || '后台桥接未响应'));
      else resolve(m.result);
    }
    window.addEventListener('message',receive);
    window.postMessage({channel:'doubao.web.request',id,operation,...extra},location.origin);
  });
}
