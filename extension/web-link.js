/* Injected only into loopback pages, never a visible UI. Background additionally
 * checks exact configured port, top frame and path for EVERY request. */
(() => {
  if (window !== window.top || window.__doubaoLocalLink) return;
  if (!['/web/', '/web/app.html', '/', '/app.html'].includes(location.pathname)) return;
  window.__doubaoLocalLink = true;
  const allowed = new Set(['ui-status','web-pair','ui-open-bridge','ui-prepare-bridge','ui-repair','ui-unbind','ui-wake','ui-download-file']);
  const inflight = new Set();
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m = event.data;
    if (m?.channel !== 'doubao.web.request' || typeof m.id !== 'string' || m.id.length > 100) return;
    if (inflight.has(m.id) || inflight.size >= 32) return;
    inflight.add(m.id);
    let result;
    try {
      if (!allowed.has(m.operation)) throw new Error('网页无权执行此扩展操作');
      result = await chrome.runtime.sendMessage({type:'doubao-web', operation:m.operation,
        token:typeof m.token==='string'?m.token.slice(0,100):'', enabled:m.enabled!==false,
        accountId:typeof m.accountId==='string'?m.accountId.slice(0,100):'',
        conversationId:typeof m.conversationId==='string'?m.conversationId.slice(0,100):'',
        taskId:typeof m.taskId==='string'?m.taskId.slice(0,100):'', fileName:typeof m.fileName==='string'?m.fileName.slice(0,160):'',
        confirmProfile:m.confirmProfile===true, profileLabel:typeof m.profileLabel==='string'?m.profileLabel.slice(0,80):''});
    } catch(error) {
      result={ok:false,error:'后台桥接不可用，请重新加载 GBT 扩展并刷新本页。'+(error.message || '')};
    } finally { inflight.delete(m.id); }
    window.postMessage({channel:'doubao.web.response',id:m.id,result}, location.origin);
  });
  document.documentElement.dataset.doubaoLink='1.2.1';
})();
