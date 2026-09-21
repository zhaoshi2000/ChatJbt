"""Real Java HTTP/SSE integration tests. Python stdlib only; no upstream network use."""
from __future__ import annotations
import contextlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[1]
TERMINAL={'completed','error','interrupted','cancelled'}

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]

class Backend:
    def __init__(self, provider='mock', extra=None):
        self.tmp=tempfile.TemporaryDirectory(prefix='jsc-test-');self.data=Path(self.tmp.name)
        self.port=free_port();self.provider=provider;self.extra=extra or {};self.process=None;self.log=None;self.start()
    def start(self):
        env={**os.environ,'PORT':str(self.port),'PROVIDER':self.provider,'DATA_DIR':str(self.data),'TASK_TIMEOUT_SECONDS':'60',**self.extra}
        self.log=open(self.data/'test-backend.log','ab',buffering=0)
        self.process=subprocess.Popen(['java','-jar',str(ROOT/'out/backend.jar')],cwd=ROOT,env=env,stdout=self.log,stderr=self.log)
        until=time.monotonic()+12
        while time.monotonic()<until:
            if self.process.poll() is not None: raise RuntimeError((self.data/'test-backend.log').read_text(encoding='utf-8'))
            try:
                if self.call('GET','/health',auth=False)[0]==200:
                    self.token=(self.data/'local-token.txt').read_text(encoding='utf-8').strip();return
            except (OSError,http.client.HTTPException):pass
            time.sleep(.05)
        raise TimeoutError('backend startup')
    def call(self,method,path,body=None,auth=True,headers=None,raw=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=25)
        h={'Authorization':'Bearer '+getattr(self,'token','')} if auth else {}
        if body is not None:h['Content-Type']='application/json';raw=json.dumps(body,ensure_ascii=False).encode()
        h.update(headers or {})
        try:
            c.request(method,path,body=raw,headers=h);r=c.getresponse();payload=r.read();
            return r.status,json.loads(payload) if payload else None,dict(r.getheaders())
        finally:c.close()
    def create(self,message='测试消息',request_id=None):
        status,data,_=self.call('POST','/api/tasks',{'requestId':request_id or str(uuid.uuid4()),'message':message})
        if status!=202:raise AssertionError((status,data))
        return data
    def task(self,id):return self.call('GET',f'/api/tasks/{id}')[1]
    def wait(self,id,condition=None,timeout=15):
        predicate=condition or (lambda t:t['state'] in TERMINAL);until=time.monotonic()+timeout
        while time.monotonic()<until:
            data=self.task(id)
            if predicate(data):return data
            time.sleep(.05)
        raise AssertionError(('timeout',self.task(id)))
    def kill(self):
        if self.process and self.process.poll() is None:self.process.kill();self.process.wait(timeout=5)
        if self.log:self.log.close();self.log=None
    def close(self):self.kill();self.tmp.cleanup()
    def event(self,task,seq,type,**kw):
        return self.call('POST','/api/browser/event',{'id':task['id'],'lease':task['lease'],'seq':seq,'type':type,**kw})

class IntegrationTests(unittest.TestCase):
    def backend(self,*args,**kw):
        b=Backend(*args,**kw);self.addCleanup(b.close);return b
    def test_security_health_auth_origin_and_host(self):
        b=self.backend();self.assertEqual(b.call('GET','/health',auth=False)[1]['version'],'1.1.0')
        self.assertEqual(b.call('GET','/api/tasks',auth=False)[0],401)
        self.assertEqual(b.call('GET','/api/tasks',headers={'Authorization':'Bearer wrong'})[0],401)
        self.assertEqual(b.call('POST','/admin/shutdown',{},auth=False,headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(b.call('GET','/health',headers={'Host':'attacker.example'})[0],403)
        self.assertEqual(b.call('GET','/api/tasks',headers={'Origin':'null'})[0],403)
        code,_,headers=b.call('OPTIONS','/api/tasks',auth=False,headers={'Origin':'chrome-extension://'+'a'*32,'Access-Control-Request-Method':'POST'})
        self.assertEqual(code,204);self.assertEqual(headers.get('Access-control-allow-origin'),'chrome-extension://'+'a'*32)
    def test_idempotency_and_validation(self):
        b=self.backend();rid=str(uuid.uuid4());first=b.create('同一个请求 🌲',rid);second=b.create('同一个请求 🌲',rid)
        self.assertEqual(first['id'],second['id'])
        self.assertEqual(b.call('POST','/api/tasks',{'requestId':rid,'message':'不同'})[0],409)
        self.assertEqual(b.call('POST','/api/tasks',{'requestId':'short','message':'hi'})[0],400)
        self.assertEqual(b.call('POST','/api/tasks',{'requestId':str(uuid.uuid4()),'message':''})[0],400)
        self.assertEqual(b.call('POST','/api/tasks',raw=b'{"x":1,"x":2}',headers={'Content-Type':'application/json'})[0],400)
        self.assertEqual(b.call('POST','/api/tasks',raw=b'a'*4_500_001,headers={'Content-Type':'application/json'})[0],413)
    def test_sse_disconnect_does_not_cancel_and_reconnect_gets_snapshot(self):
        b=self.backend();task=b.create('断线恢复 "中文" 🌲');id=task['id']
        c=http.client.HTTPConnection('127.0.0.1',b.port,timeout=5)
        c.request('GET',f'/api/tasks/{id}/events',headers={'Authorization':'Bearer '+b.token})
        r=c.getresponse();self.assertEqual(r.status,200);first=r.readline();self.assertTrue(first.startswith(b'id: '));r.close();c.close()
        final=b.wait(id);self.assertEqual(final['state'],'completed');self.assertIn('断线恢复 "中文" 🌲',final['text'])
        c=http.client.HTTPConnection('127.0.0.1',b.port,timeout=5);c.request('GET',f'/api/tasks/{id}/events',headers={'Authorization':'Bearer '+b.token,'Last-Event-ID':'0'})
        payload=c.getresponse().read().decode();c.close();self.assertIn('event: snapshot',payload)
        snapshot=json.loads(next(line[6:] for line in payload.splitlines() if line.startswith('data: ')))
        self.assertEqual(snapshot['text'],final['text']);self.assertEqual(snapshot['state'],'completed')
    def test_cancel_is_terminal_and_history_deletion_skips_running(self):
        b=self.backend('browser');one=b.create('cancel');two=b.create('keep')
        b.call('POST',f"/api/tasks/{one['id']}/cancel",{});self.assertEqual(b.task(one['id'])['state'],'cancelled')
        code,result,_=b.call('DELETE','/api/history');self.assertEqual(result['deleted'],1)
        self.assertEqual(b.task(two['id'])['state'],'queued')
        self.assertEqual(b.call('DELETE',f"/api/tasks/{two['id']}")[0],409)
    def test_mock_restart_preserves_partial_without_automatic_resubmit(self):
        b=self.backend();task=b.create('很长的消息 '*100)
        before=b.wait(task['id'],lambda t:len(t['text'])>30)
        b.kill();b.start();after=b.task(task['id'])
        self.assertEqual(after['state'],'interrupted');self.assertTrue(after['text']);self.assertLessEqual(len(after['text']),len(before['text'])+20)
        time.sleep(.15);self.assertEqual(b.task(task['id'])['state'],'interrupted')
    def test_browser_lease_order_snapshots_and_duplicate_ack(self):
        b=self.backend('browser');one=b.create('browser');two=b.create('second')
        task=b.call('POST','/api/browser/poll',{'clientId':'bridge-client-one','waitSeconds':0})[1]['task']
        self.assertEqual(task['id'],one['id'])
        self.assertIsNone(b.call('POST','/api/browser/poll',{'clientId':'bridge-client-two','waitSeconds':0})[1]['task'])
        self.assertEqual(b.event(task,1,'submitting',checkpoint={'phase':'submitting','baselineKeys':['id:old']})[0],200)
        self.assertEqual(b.event(task,2,'snapshot',text='初稿')[0],200)
        self.assertEqual(b.event(task,2,'snapshot',text='不会追加')[1]['duplicate'],True)
        self.assertEqual(b.event(task,4,'snapshot',text='跳序')[0],409)
        self.assertEqual(b.event({**task,'lease':'wrong'},3,'done')[0],409)
        self.assertEqual(b.event(task,3,'snapshot',text='重写后的最终稿')[0],200)
        self.assertEqual(b.task(task['id'])['text'],'重写后的最终稿')
        self.assertEqual(b.event(task,4,'progress',detail='正在搜索')[0],200);self.assertEqual(b.task(task['id'])['state'],'running')
        self.assertEqual(b.event(task,5,'done',text='重写后的最终稿')[0],200)
        next_task=b.call('POST','/api/browser/poll',{'clientId':'bridge-client-one','waitSeconds':0})[1]['task'];self.assertEqual(next_task['id'],two['id'])
    def test_browser_backend_restart_resumes_same_lease_and_checkpoint(self):
        b=self.backend('browser');one=b.create('保持原消息')
        task=b.call('POST','/api/browser/poll',{'clientId':'persistent-bridge','waitSeconds':0})[1]['task']
        b.event(task,1,'submitting',checkpoint={'phase':'submitting','baselineKeys':[]})
        b.event(task,2,'snapshot',text='部分回答',checkpoint={'phase':'observing','userKey':'id:u1','url':'https://chatgpt.com/c/demo'})
        b.kill();b.start();restored=b.call('POST','/api/browser/poll',{'clientId':'persistent-bridge','waitSeconds':0})[1]['task']
        self.assertEqual(restored['id'],task['id']);self.assertEqual(restored['lease'],task['lease']);self.assertEqual(restored['lastSeq'],2)
        self.assertTrue(restored['submitted']);self.assertEqual(restored['checkpoint']['userKey'],'id:u1')
        self.assertEqual(b.event(restored,2,'snapshot',text='部分回答')[1]['duplicate'],True)
        self.assertEqual(b.event(restored,3,'done',text='恢复后的完整回复')[0],200)
    def test_mock_completion_persisted_after_restart(self):
        b=self.backend();one=b.create('persist');final=b.wait(one['id']);b.kill();b.start();self.assertEqual(b.task(one['id'])['text'],final['text'])
    def test_static_ui_and_json_not_legacy_unauthed_chat(self):
        b=self.backend();c=http.client.HTTPConnection('127.0.0.1',b.port);c.request('GET','/web/');r=c.getresponse();self.assertEqual(r.status,200);self.assertIn(b'Content-Security-Policy'.lower(),str(r.getheaders()).lower().encode());self.assertIn('逗包',r.read().decode());c.close()
        # Public UI routes stay local, CSP-protected, and contain the new RPC module.
        for path in ['/web/app.js','/web/web-rpc.js','/web/shared.js','/web/app.css']:
            c=http.client.HTTPConnection('127.0.0.1',b.port);c.request('GET',path);r=c.getresponse();self.assertEqual(r.status,200);self.assertTrue(r.read());c.close()
        c=http.client.HTTPConnection('127.0.0.1',b.port);c.request('GET','/');r=c.getresponse();self.assertEqual(r.status,302);self.assertEqual(r.getheader('Location'),'/web/');r.read();c.close()
        c=http.client.HTTPConnection('127.0.0.1',b.port);c.request('GET','/web/',headers={'Host':f'localhost:{b.port}'});r=c.getresponse();self.assertEqual(r.status,302);self.assertEqual(r.getheader('Location'),f'http://127.0.0.1:{b.port}/web/');r.read();c.close()
        self.assertEqual(b.call('POST','/api/chat',{},auth=False)[0],401)
        self.assertEqual(b.call('GET','/../config/application.properties')[0],404)

class FakeResponses(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        message=body['input']
        events=[{'type':'response.output_text.delta','item_id':'m1','content_index':0,'delta':'你好 🌲'}]
        if message=='incomplete':events.append({'type':'response.incomplete'})
        elif message!='disconnect':events.append({'type':'response.completed','response':{'output':[{'type':'message','content':[{'type':'output_text','text':'最终回答 🌲'}]}]}})
        payload=''.join('event: '+e['type']+'\r\ndata: '+json.dumps(e,ensure_ascii=False)+'\r\n\r\n' for e in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(payload)));self.end_headers()
        for i in range(0,len(payload),7):self.wfile.write(payload[i:i+7]);self.wfile.flush()

class UpstreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),FakeResponses);cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close()
    def backend(self):
        b=Backend('openai',{'OPENAI_API_KEY':'test-key-not-real','OPENAI_MODEL':'fake-test-model','OPENAI_BASE_URL':f'http://127.0.0.1:{self.server.server_port}/v1'});self.addCleanup(b.close);return b
    def test_final_response_replaces_incremental_text(self):
        b=self.backend();one=b.create('complete');result=b.wait(one['id']);self.assertEqual(result['state'],'completed');self.assertEqual(result['text'],'最终回答 🌲')
    def test_eof_before_completed_is_error(self):
        b=self.backend();one=b.create('disconnect');result=b.wait(one['id']);self.assertEqual(result['state'],'error');self.assertEqual(result['text'],'你好 🌲')
    def test_incomplete_event_is_error(self):
        b=self.backend();one=b.create('incomplete');self.assertEqual(b.wait(one['id'])['state'],'error')

if __name__=='__main__':unittest.main(verbosity=2)
