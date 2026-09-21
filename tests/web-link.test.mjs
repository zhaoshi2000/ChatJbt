import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../extension/web-link.js',import.meta.url),'utf8');
function harness(pathname='/web/'){
  const sent=[],responses=[],handlers={};
  const location={origin:'http://127.0.0.1:48643',pathname};
  const window={addEventListener:(kind,fn)=>handlers[kind]=fn,postMessage:(m,origin)=>responses.push({m,origin})};window.top=window;
  const document={documentElement:{dataset:{}}};
  const chrome={runtime:{sendMessage:async m=>{sent.push(m);return {ok:true,ready:true};}}};
  vm.runInNewContext(source,{window,location,document,chrome,Set,Error});
  const send=(data,extra={})=>handlers.message?.({source:window,origin:location.origin,data,...extra});
  return {window,document,sent,responses,send};
}
test('web connector is invisible and adds no document UI',()=>{
  const h=harness();assert.equal(h.document.documentElement.dataset.doubaoLink,'1.2.1');
  assert.equal(Object.keys(h.document).length,1);
});
test('content connector ignores messages from other frames or origins',async()=>{
  const h=harness();const packet={channel:'doubao.web.request',id:'request-1',operation:'ui-open-bridge'};
  await h.send(packet,{origin:'https://www.msn.com'});await h.send(packet,{source:{}});assert.equal(h.sent.length,0);
});
test('content connector forwards only the allowed fixed fields',async()=>{
  const h=harness();await h.send({channel:'doubao.web.request',id:'request-1',operation:'web-pair',token:'b'.repeat(43),enabled:false,backendUrl:'http://attacker.test',arbitrary:'ignored'});
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].backendUrl,undefined);assert.equal(h.sent[0].arbitrary,undefined);
  assert.equal(h.responses[0].origin,'http://127.0.0.1:48643');assert.equal(h.responses[0].m.id,'request-1');
});
test('download command forwards only scoped task and file identifiers',async()=>{
  const h=harness();await h.send({channel:'doubao.web.request',id:'request-download',operation:'ui-download-file',accountId:'account-aaaaaaaa',conversationId:'conversation-1111',taskId:'task-00000001',fileName:'forum.zip',url:'https://attacker.test'});
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].taskId,'task-00000001');assert.equal(h.sent[0].fileName,'forum.zip');assert.equal(h.sent[0].url,undefined);
});
test('content connector refuses generic extension commands',async()=>{
  const h=harness();await h.send({channel:'doubao.web.request',id:'request-1',operation:'ui-save-settings'});
  assert.equal(h.sent.length,0);assert.equal(h.responses[0].m.result.ok,false);
});
test('content connector does not activate on arbitrary loopback paths',()=>{
  const h=harness('/some-other-app');assert.equal(h.document.documentElement.dataset.doubaoLink,undefined);
});
