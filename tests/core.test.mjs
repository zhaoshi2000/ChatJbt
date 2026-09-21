import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {VERSION,BACKEND_VERSION,browserQueueHint,normalizeBaseUrl,parseSse,taskMarkdown,TERMINAL} from '../extension/shared.js';
import {conversationUrl,stableConversationUrl,pageAtTarget} from '../extension/lane-core.js';
import '../extension/bridge-core.js';
const core=globalThis.JSCBridgeCore;

test('chat input sends on Enter and conversation deletion confirms in place',()=>{
  const app=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(app,/e\.key==='Enter'&&!e\.shiftKey/);
  assert.match(app,/confirmHistoryDelete/);
  assert.doesNotMatch(app,/confirm\(['"]删除/);
});

test('generated file control downloads through authenticated local storage without page navigation',()=>{
  const app=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
  assert.match(app,/button\.className='generated-file'/);
  assert.match(app,/fetch\(config\.backendUrl\+'\/api\/tasks\/'/);
  assert.match(app,/a\.download=file\.name\|\|'生成文件'/);
  assert.doesNotMatch(app,/window\.open\([^\n]*\/files\//);
  assert.match(app,/webWorker\('ui-download-file'/);
});

test('normalizes IPv4 loopback and localhost without IPv6 ambiguity',()=>{
  assert.equal(normalizeBaseUrl(' http://localhost:48627/ '),'http://127.0.0.1:48627');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:65535'),'http://127.0.0.1:65535');
});
test('rejects non-loopback hosts, credentials, paths, query and unsafe port',()=>{
  for(const url of ['https://127.0.0.1:48627','http://example.com:48627','http://127.0.0.1.evil.test:48627','http://user:pass@127.0.0.1:48627','http://127.0.0.1:48627/api','http://127.0.0.1:48627/?token=x','http://127.0.0.1:48627/#x','http://127.0.0.1','http://[::1]:48627'])assert.throws(()=>normalizeBaseUrl(url));
});
test('a short silent period without stop button is NOT completion',()=>{
  assert.equal(core.mayComplete({text:'preliminary',busy:false,searching:false,completionAction:false,stableMs:100000}),false);
  assert.equal(core.mayComplete({text:'preliminary',busy:false,searching:false,completionAction:true,stableMs:1401}),false);
});
test('searching and busy states prevent premature completion',()=>{
  assert.equal(core.mayComplete({text:'text',busy:false,searching:true,completionAction:true,stableMs:30000}),false);
  assert.equal(core.mayComplete({text:'text',busy:true,searching:false,completionAction:true,stableMs:30000}),false);
});
test('completion requires nonempty stable text and a turn completion action',()=>{
  assert.equal(core.mayComplete({text:'最终答案',busy:false,searching:false,completionAction:true,stableMs:8000}),true);
  assert.equal(core.mayComplete({text:'   ',busy:false,searching:false,completionAction:true,stableMs:30000}),false);
  assert.equal(core.mayComplete({text:'',hasMedia:true,busy:false,searching:false,completionAction:true,stableMs:8000}),true);
});
test('a loaded generated image overrides only stale aria-busy state',()=>{
  assert.equal(core.responseBusy({ariaBusy:true,mediaReady:true}),false);
  assert.equal(core.responseBusy({ariaBusy:true,mediaReady:false}),true);
  assert.equal(core.responseBusy({stop:true,ariaBusy:true,mediaReady:true}),true);
  assert.equal(core.responseBusy({thinking:true,mediaReady:true}),true);
  assert.equal(core.responseBusy({searching:true,mediaReady:true}),true);
});
test('recovery identifies repeated prompts by stable message id',()=>{
  const users=[{key:'id:old',text:'重复问题'},{key:'id:new',text:'重复问题'}];
  assert.equal(core.locateUser(users,{baselineKeys:['id:old']},'重复问题'),1);
  assert.equal(core.locateUser(users,{userKey:'id:old'},'重复问题'),0);
});
test('missing stable id refuses to attach to a different duplicate prompt',()=>{
  assert.equal(core.locateUser([{key:'id:new',text:'same'}],{userKey:'id:missing',baselineKeys:[]},'same'),-1);
});
test('normalization and fingerprints are stable across NBSP and line endings',()=>{
  assert.equal(core.hash('你好\u00a0世界\r\n测试'),core.hash('你好 世界\n测试'));
});
test('accepts current ChatGPT WEB-prefixed conversation ids without widening hosts',()=>{
  assert.equal(conversationUrl('https://chatgpt.com/c/WEB:c87d90fd-2a2f-42f9-98d7-a6c1d686643a'),'https://chatgpt.com/c/WEB:c87d90fd-2a2f-42f9-98d7-a6c1d686643a');
  assert.equal(conversationUrl('https://example.com/c/WEB:c87d90fd-2a2f-42f9-98d7-a6c1d686643a'),'');
});
test('does not persist ChatGPT provisional WEB conversation addresses',()=>{
  assert.equal(stableConversationUrl('https://chatgpt.com/c/WEB:c87d90fd-2a2f-42f9-98d7-a6c1d686643a'),'');
  assert.equal(stableConversationUrl('https://chatgpt.com/c/6ab0efe7-3730-83ec-a6f9-c22c98a8a62d'),'https://chatgpt.com/c/6ab0efe7-3730-83ec-a6f9-c22c98a8a62d');
});
test('waits for the requested ChatGPT navigation target before binding the page',()=>{
  const target='https://chatgpt.com/c/WEB:c87d90fd-2a2f-42f9-98d7-a6c1d686643a';
  assert.equal(pageAtTarget('https://chatgpt.com/',target),false);
  assert.equal(pageAtTarget(target,target),true);
  assert.equal(pageAtTarget('https://chatgpt.com/c/other','https://chatgpt.com/'),false);
  assert.equal(pageAtTarget('https://chatgpt.com/','https://chatgpt.com/'),true);
});
async function parseChunks(text,chunkSize){
  const bytes=new TextEncoder().encode(text);let i=0;
  const stream=new ReadableStream({pull(c){if(i>=bytes.length){c.close();return;}c.enqueue(bytes.slice(i,i+chunkSize));i+=chunkSize;}});
  const out=[];for await(const e of parseSse(stream))out.push(e);return out;
}
test('SSE parser handles UTF-8 split at every byte, CRLF, comments and event ids',async()=>{
  const out=await parseChunks(': ping\r\nid: 3\r\nevent: snapshot\r\ndata: {"text":"你好 🌲"}\r\n\r\n',1);
  assert.deepEqual(out,[{event:'snapshot',id:'3',data:'{"text":"你好 🌲"}'}]);
});
test('SSE parser combines multiline data and ignores unknown fields',async()=>{
  const out=await parseChunks('retry: 1000\nevent: snapshot\ndata: {\ndata: "x": 1}\n\n',3);
  assert.equal(out.length,1);assert.deepEqual(JSON.parse(out[0].data),{x:1});
});
test('truncated EOF frame is not interpreted as successful completion',async()=>{
  const out=await parseChunks('data: {"state":"completed"}',4);assert.equal(out.length,0);
});
test('Markdown export preserves literal output rather than executing HTML',()=>{
  const md=taskMarkdown({created:0,state:'completed',provider:'mock',message:'<script>x</script>',text:'```js\n1+1\n```'});
  assert.match(md,/<script>x<\/script>/);assert.match(md,/```js/);assert.equal(TERMINAL.has('interrupted'),true);
});

test('web and background bridge require the same v1.2.0 backend',()=>{
 assert.equal(VERSION,'1.2.0');assert.equal(BACKEND_VERSION,'1.2.0');
});
test('queue hint distinguishes local connection, page readiness, pause, busy, draft and prior task',()=>{
 assert.match(browserQueueHint(),/本地后端未连接/);
 assert.match(browserQueueHint({backendOnline:true}),/尚未交给 ChatGPT/);
 assert.match(browserQueueHint({backendOnline:true,paused:true}),/暂停/);
 assert.match(browserQueueHint({backendOnline:true,ready:true,busy:true}),/其他消息/);
 assert.match(browserQueueHint({backendOnline:true,ready:true,hasDraft:true}),/草稿/);
 assert.match(browserQueueHint({backendOnline:true,ready:true,activeTask:'t'}),/上一条/);
 assert.match(browserQueueHint({backendOnline:true,ready:true}),/领取本地任务/);
});
