"""Real Java HTTP integration; simulated bridge clients, NOT real ChatGPT accounts."""
import concurrent.futures as cf
import http.client,json,os,pathlib,socket,subprocess,tempfile,time,unittest,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Backend:
    def __init__(self,provider='browser',extra=None,data=None):
        self.tmp=tempfile.TemporaryDirectory(prefix='doubao-multi-');self.data=pathlib.Path(data or self.tmp.name)/'data';self.data.mkdir(exist_ok=True)
        with socket.socket() as s:s.bind(('127.0.0.1',0));self.port=s.getsockname()[1]
        self.provider=provider;self.extra=extra or {};self.proc=None;self.start()
    def start(self):
        env={**os.environ,'PORT':str(self.port),'DATA_DIR':str(self.data),'PROVIDER':self.provider,'TASK_TIMEOUT_SECONDS':'180','BRIDGE_CONCURRENT':'3',**self.extra}
        self.log=open(pathlib.Path(self.tmp.name)/'backend.log','a',encoding='utf-8')
        self.proc=subprocess.Popen([os.environ.get('JAVA_BIN','java'),'-jar',os.environ.get('BACKEND_JAR',str(ROOT/'out/backend.jar'))],cwd=ROOT,env=env,stdout=self.log,stderr=subprocess.STDOUT)
        for _ in range(150):
            if self.proc.poll() is not None:raise RuntimeError(pathlib.Path(self.log.name).read_text())
            try:
                if self.call('GET','/health',token=False)[0]==200:break
            except OSError:pass
            time.sleep(.05)
        else:raise RuntimeError('startup timed out')
        self.token=(self.data/'local-token.txt').read_text().strip()
    def call(self,method,path,body=None,token=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=8);h={'Accept':'application/json'}
        if token is not False:h['Authorization']='Bearer '+(token or getattr(self,'token',''))
        wire=None
        if body is not None:wire=json.dumps(body,ensure_ascii=False).encode();h['Content-Type']='application/json'
        h.update(headers or {});c.request(method,path,body=wire,headers=h);r=c.getresponse();raw=r.read();code=r.status;c.close()
        try:value=json.loads(raw)
        except:value=raw.decode(errors='replace')
        return code,value
    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        self.log.close()
    def cleanup(self):self.close();self.tmp.cleanup()
    def account(self,name):
        code,r=self.call('POST','/api/accounts',{'name':name});assert code==201,(code,r);return {'id':r['account']['id'],'token':r['token'],'clientId':str(uuid.uuid4())}
    def conv(self,a,name='测试会话',id=None):
        code,r=self.call('POST','/api/conversations',{'id':id or str(uuid.uuid4()),'title':name},a['token']);assert code==201,(code,r);return r
    def create(self,a,c,text='hello',request=None):return self.call('POST','/api/tasks',{'conversationId':c['id'],'requestId':request or str(uuid.uuid4()),'message':text},a['token'])
    def register(self,a):return self.call('POST','/api/bridge/register',{'clientId':a['clientId'],'confirmProfile':True,'profileLabel':'fixture'},a['token'])
    def poll(self,a,c):return self.call('POST','/api/browser/poll',{'clientId':a['clientId'],'conversationId':c['id'],'waitSeconds':0},a['token'])
    def event(self,a,t,seq,type='snapshot',**extra):return self.call('POST','/api/browser/event',{'clientId':a['clientId'],'conversationId':t['conversationId'],'id':t['id'],'lease':t['lease'],'seq':seq,'type':type,**extra},a['token'])
class BootstrapTests(unittest.TestCase):
    def test_first_account_can_be_created_only_once_from_local_chat_page(self):
        b=Backend()
        try:
            self.assertEqual(b.call('POST','/api/bootstrap-account',{'name':'我的账号'},token=False)[0],403)
            origin={'Origin':f'http://127.0.0.1:{b.port}'}
            code,r=b.call('POST','/api/bootstrap-account',{'name':'我的账号'},token=False,headers=origin)
            self.assertEqual(code,201);self.assertGreaterEqual(len(r['token']),40)
            me=b.call('GET','/api/me',token=r['token'])[1];self.assertEqual(me['role'],'account');self.assertEqual(me['account']['name'],'我的账号')
            self.assertEqual(b.call('POST','/api/bootstrap-account',{'name':'第二个账号'},token=False,headers=origin)[0],409)
        finally:b.cleanup()
class IsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.b=Backend()
    @classmethod
    def tearDownClass(cls):cls.b.cleanup()
    def setUp(self):
        self.a=self.b.account('A-'+str(uuid.uuid4())[:8]);self.z=self.b.account('B-'+str(uuid.uuid4())[:8]);self.c=self.b.conv(self.a);self.d=self.b.conv(self.z)
        self.b.register(self.a);self.b.register(self.z)
    def test_01_scope_all_read_write_stream_and_history(self):
        b=self.b;a=self.a;z=self.z
        code,t=b.create(a,self.c,'A private');self.assertEqual(code,202);tid=t['id']
        for method,path,body in [('GET','/api/tasks/'+tid,None),('POST','/api/tasks/'+tid+'/cancel',{}),('DELETE','/api/tasks/'+tid,None),('GET','/api/tasks/'+tid+'/events',None),('GET','/api/conversations/'+self.c['id'],None),('GET','/api/conversations/'+self.c['id']+'/tasks',None),('POST','/api/conversations/'+self.c['id'],{'title':'wrong'}),('DELETE','/api/conversations/'+self.c['id'],None)]:
            with self.subTest(method=method,path=path):self.assertEqual(b.call(method,path,body,z['token'])[0],404)
        self.assertEqual(b.create(z,self.c)[0],404)
        self.assertEqual(b.poll(z,self.c)[0],404)
        self.assertEqual(b.call('GET','/api/tasks',token=z['token'])[1]['tasks'],[])
        self.assertEqual(len(b.call('GET','/api/accounts',token=z['token'])[1]['accounts']),1)
        self.assertEqual(b.call('DELETE','/api/history',token=z['token'])[0],200)
        self.assertEqual(b.call('GET','/api/tasks/'+tid,token=a['token'])[0],200)
        self.assertEqual(b.call('POST','/admin/shutdown',{},z['token'])[0],403)
        self.assertEqual(b.call('POST','/api/accounts',{'name':'wrong'},z['token'])[0],403)
    def test_02_account_A_offline_does_not_block_B(self):
        b=self.b;b.create(self.a,self.c,'unclaimed A');_,t=b.create(self.z,self.d,'B reply')
        code,r=b.poll(self.z,self.d);self.assertEqual(code,200);self.assertEqual(r['task']['id'],t['id']);self.assertEqual(r['task']['accountId'],self.z['id'])
        self.assertEqual(b.event(self.z,r['task'],1,'done',text='B only')[0],200)
    def test_03_per_conversation_concurrency_and_idempotency(self):
        b=self.b;a=self.a;c=self.c;c2=b.conv(a,'second');rid=str(uuid.uuid4());_,t=b.create(a,c,'m1',rid)
        self.assertEqual(b.create(a,c,'m1',rid)[1]['id'],t['id']);self.assertEqual(b.create(a,c,'changed',rid)[0],409)
        self.assertEqual(b.create(a,c,'different request')[0],409)
        self.assertEqual(b.create(a,c2,'m2',rid)[0],202) # scope includes conversation
        _,one=b.poll(a,c);_,two=b.poll(a,c2);self.assertIsNotNone(one['task']);self.assertIsNotNone(two['task']);self.assertNotEqual(one['task']['lease'],two['task']['lease'])
    def test_04_duplicate_tabs_race_only_one_create(self):
        def create(_):return self.b.create(self.a,self.c)
        with cf.ThreadPoolExecutor(max_workers=8) as pool:codes=[r[0] for r in pool.map(create,range(8))]
        self.assertEqual(codes.count(202),1);self.assertEqual(codes.count(409),7)
    def test_05_profile_binding_fences(self):
        b=self.b;a=self.a;z=self.z
        self.assertEqual(b.call('POST','/api/bridge/register',{'clientId':a['clientId'],'confirmProfile':True},z['token'])[0],409)
        self.assertEqual(b.call('POST','/api/bridge/register',{'clientId':str(uuid.uuid4()),'confirmProfile':True},a['token'])[0],409)
        self.assertEqual(b.call('POST','/api/bridge/heartbeat',{'clientId':z['clientId'],'ready':True},a['token'])[0],403)
        self.assertEqual(b.call('POST','/api/bridge/register',{'clientId':a['clientId'],'confirmProfile':True})[0],403)
    def test_06_lease_seq_and_upstream_url_guards(self):
        b=self.b;a=self.a;b.create(a,self.c);_,r=b.poll(a,self.c);t=r['task'];url='https://chatgpt.com/c/'+str(uuid.uuid4())
        self.assertEqual(b.event(self.z,t,1,text='foreign')[0],404)
        self.assertEqual(b.event(a,t,1,conversationId=self.d['id'],text='wrong')[0],409)
        self.assertEqual(b.event(a,{**t,'lease':'wrong'},1,text='bad')[0],409)
        self.assertEqual(b.event(a,t,2,'checkpoint',checkpoint={'url':url})[0],409)
        self.assertEqual(b.call('GET','/api/conversations/'+self.c['id'],token=a['token'])[1]['upstreamUrl'],'')
        self.assertEqual(b.event(a,t,1,'submitting',checkpoint={'url':'https://chatgpt.com/'})[0],200)
        self.assertEqual(b.event(a,t,2,'snapshot',text='text once',checkpoint={'url':url})[0],200)
        self.assertTrue(b.event(a,t,2,'snapshot',text='different duplicate')[1]['duplicate'])
        self.assertEqual(b.call('GET','/api/tasks/'+t['id'],token=a['token'])[1]['text'],'text once')
        self.assertEqual(b.event(a,t,3,'snapshot',text='wrong context',checkpoint={'url':'https://chatgpt.com/c/another'})[0],409)
        self.assertEqual(b.event(a,t,3,'done',text='final A',checkpoint={'url':url})[0],200)
        self.assertEqual(b.call('GET','/api/conversations/'+self.c['id'],token=a['token'])[1]['upstreamUrl'],url)
        self.assertEqual(b.event(a,t,4,'snapshot',text='late',checkpoint={'url':'https://chatgpt.com/c/not-this'})[0],200)
        self.assertEqual(b.call('GET','/api/tasks/'+t['id'],token=a['token'])[1]['text'],'final A')
        self.assertEqual(b.create(a,self.c,'follow up')[0],202)
    def test_07_conversation_url_cannot_be_shared_by_two_sessions(self):
        b=self.b;a=self.a;c2=b.conv(a);url='https://chatgpt.com/c/'+str(uuid.uuid4());b.create(a,self.c);b.create(a,c2)
        _,r1=b.poll(a,self.c);_,r2=b.poll(a,c2)
        self.assertEqual(b.event(a,r1['task'],1,'checkpoint',checkpoint={'url':url})[0],200)
        self.assertEqual(b.event(a,r2['task'],1,'checkpoint',checkpoint={'url':url})[0],409)
    def test_08_parallel_cap_only_affects_one_account(self):
        b=self.b;a=self.a;convs=[self.c]+[b.conv(a) for _ in range(3)]
        for c in convs:b.create(a,c)
        for c in convs[:3]:self.assertIsNotNone(b.poll(a,c)[1]['task'])
        self.assertIsNone(b.poll(a,convs[3])[1]['task'])
        b.create(self.z,self.d);self.assertIsNotNone(b.poll(self.z,self.d)[1]['task'])
    def test_09_rotate_preserves_history_and_revokes_token(self):
        b=self.b;a=self.a;_,t=b.create(a,self.c)
        self.assertEqual(b.call('POST','/api/accounts/'+a['id']+'/rotate',{})[0],409)
        b.call('POST','/api/tasks/'+t['id']+'/cancel',{},a['token'])
        code,r=b.call('POST','/api/accounts/'+a['id']+'/rotate',{});self.assertEqual(code,200)
        self.assertEqual(b.call('GET','/api/tasks',token=a['token'])[0],401)
        self.assertEqual(b.call('GET','/api/tasks/'+t['id'],token=r['token'])[0],200)
        self.assertEqual(r['account']['clientId'],'')
        disk=(b.data/'workspaces.json').read_text();self.assertNotIn(r['token'],disk)
    def test_10_deletion_and_diagnostics_isolated(self):
        b=self.b;_,ta=b.create(self.a,self.c);_,tb=b.create(self.z,self.d)
        self.assertEqual(b.call('DELETE','/api/conversations/'+self.c['id'],token=self.a['token'])[0],409)
        for a,t in [(self.a,ta),(self.z,tb)]:b.call('POST','/api/tasks/'+t['id']+'/cancel',{},a['token']);b.call('POST','/api/bridge/heartbeat',{'clientId':a['clientId'],'ready':True},a['token'])
        r=b.call('GET','/api/diagnostics',token=self.a['token'])[1];self.assertTrue(all(v['accountId']==self.a['id'] for v in r['bridges']));self.assertNotIn(self.z['token'],json.dumps(r))
        self.assertEqual(b.call('DELETE','/api/conversations/'+self.c['id'],token=self.a['token'])[0],200)
        self.assertEqual(b.call('GET','/api/tasks/'+tb['id'],token=self.z['token'])[0],200)
    def test_11_http_security_and_bundle(self):
        b=self.b;self.assertEqual(b.call('GET','/api/tasks',token=False)[0],401)
        self.assertEqual(b.call('GET','/health',headers={'Host':'evil.example:'+str(b.port)})[0],403)
        self.assertEqual(b.call('GET','/health',headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(b.call('GET','/web/../../data/local-token.txt',token=False)[0],404)
        self.assertEqual(b.call('GET','/web/',token=False)[0],200)
        self.assertEqual(b.call('GET','/web/render.js',token=False)[0],200)
        self.assertEqual(b.call('GET','/health',token=False)[1]['version'],'1.2.0')
    def test_12_restart_recovers_scoped_lease_and_outbox_ACK(self):
        b=self.b;a=self.a;b.create(a,self.c);_,r=b.poll(a,self.c);t=r['task'];url='https://chatgpt.com/c/'+str(uuid.uuid4())
        b.event(a,t,1,'submitting',checkpoint={'url':url});b.event(a,t,2,'snapshot',text='before restart',checkpoint={'url':url})
        b.close();b.start();code,r=b.poll(a,self.c);self.assertEqual(code,200);self.assertEqual(r['task']['lease'],t['lease']);self.assertEqual(r['task']['lastSeq'],2)
        self.assertEqual(r['task']['text'],'before restart');self.assertEqual(r['task']['accountId'],a['id'])
        self.assertTrue(b.event(a,t,2,text='ACK replay')[1]['duplicate'])
        self.assertEqual(b.event(a,t,3,'done',text='complete')[0],200)
    def test_13_unknown_submission_no_silent_new_thread(self):
        b=self.b;a=self.a;_,r=b.create(a,self.c);_,p=b.poll(a,self.c);b.event(a,p['task'],1,'submitting',checkpoint={'url':'https://chatgpt.com/'})
        b.call('POST','/api/tasks/'+r['id']+'/cancel',{},a['token']);self.assertEqual(b.create(a,self.c,'next')[0],409)
    def test_14_two_stream_subscribers_receive_same_snapshot(self):
        b=self.b;a=self.a;_,created=b.create(a,self.c);_,delivery=b.poll(a,self.c);t=delivery['task']
        b.event(a,t,1,'done',text='both windows see this')
        def stream(_):
            code,text=b.call('GET','/api/tasks/'+t['id']+'/events',token=a['token']);return code,text
        with cf.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(stream,range(2)))
        for code,text in results:self.assertEqual(code,200);self.assertIn('both windows see this',text);self.assertIn(a['id'],text)
        self.assertEqual(results[0][1],results[1][1])
    def test_15_image_attachment_is_scoped_persisted_and_delivered(self):
        image={'name':'测试.png','mimeType':'image/png','base64':'iVBORw0KGgo='}
        code,t=self.b.call('POST','/api/tasks',{'conversationId':self.c['id'],'requestId':str(uuid.uuid4()),'message':'看看这张图','attachments':[image]},self.a['token'])
        self.assertEqual(code,202);self.assertEqual(t['attachments'],[image])
        code,poll=self.b.poll(self.a,self.c);self.assertEqual(code,200);self.assertEqual(poll['task']['attachments'],[image])
        self.assertEqual(self.b.call('GET','/api/tasks/'+t['id'],token=self.z['token'])[0],404)
        generated={**image,'name':'生成图片.png'};self.assertEqual(self.b.event(self.a,poll['task'],1,'done',text='',images=[generated])[0],200)
        self.assertEqual(self.b.call('GET','/api/tasks/'+t['id'],token=self.a['token'])[1]['images'],[generated])
        bad={**image,'mimeType':'text/html'}
        self.assertEqual(self.b.call('POST','/api/tasks',{'conversationId':self.c['id'],'requestId':str(uuid.uuid4()),'message':'bad','attachments':[bad]},self.a['token'])[0],400)
        for selected in ['gpt-5-6','gpt-5-6-thinking-standard','gpt-5-6-thinking-extended','gpt-5-6-thinking-max','gpt-6-pro']:
            code,model_task=self.b.call('POST','/api/tasks',{'conversationId':self.c['id'],'requestId':str(uuid.uuid4()),'message':'指定模型','model':selected},self.a['token'])
            self.assertEqual(code,202);self.assertEqual(model_task['model'],selected);self.b.call('POST','/api/tasks/'+model_task['id']+'/cancel',{},self.a['token'])
        self.assertEqual(self.b.call('POST','/api/tasks',{'conversationId':self.c['id'],'requestId':str(uuid.uuid4()),'message':'bad model','model':'unknown-model'},self.a['token'])[0],400)
class MigrationTests(unittest.TestCase):
    def test_legacy_is_read_only_not_assigned_to_new_accounts(self):
        with tempfile.TemporaryDirectory() as d:
            data=pathlib.Path(d)/'data';(data/'tasks').mkdir(parents=True);id=str(uuid.uuid4())
            (data/'tasks'/f'{id}.json').write_text(json.dumps({'id':id,'message':'old private text','provider':'browser','state':'running','submitted':True,'created':1,'lease':'old lease'}))
            b=Backend(data=d)
            try:
                a=b.account('new user');self.assertEqual(b.call('GET','/api/tasks',token=a['token'])[1]['tasks'],[])
                self.assertEqual(b.call('GET','/api/legacy-export',token=a['token'])[0],403)
                old=b.call('GET','/api/legacy-export')[1]['tasks'][0];self.assertEqual(old['state'],'interrupted');self.assertEqual(old['message'],'old private text');self.assertNotIn('lease',old)
                self.assertTrue((data/'tasks'/f'{id}.json').exists())
            finally:b.cleanup()
if __name__=='__main__':unittest.main(verbosity=2)
