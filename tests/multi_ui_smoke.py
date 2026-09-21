"""Actual frontend/content scripts with offline browser transport/storage adapters.
Java HTTP routing is real; Chromium network policy and extension installation are NOT bypassed.
These are controlled pages, NOT logged-in ChatGPT or real browser profiles.
"""
from pathlib import Path
import base64,json,os,time,uuid,re
from urllib.parse import urlparse
from multi_integration import Backend,ROOT
from playwright.sync_api import sync_playwright

def main():
    b=Backend('browser');out=Path(os.environ.get('TEST_ARTIFACTS',ROOT/'test-artifacts'));out.mkdir(parents=True,exist_ok=True)
    results=[];errors=[];stores={};page_stores={};adapter={'ready':True,'loseAck':False};active={};event_seq={}
    a=b.account('账号 A · 工作');z=b.account('账号 B · 个人');b.register(a);b.register(z)
    ac=b.conv(a,'产品开发计划');ac2=b.conv(a,'技术文档整理');zc=b.conv(z,'旅行与生活灵感')
    origin=f'http://127.0.0.1:{b.port}'
    def passed(text):results.append(text);print('PASS:',text,flush=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        context=browser.new_context(viewport={'width':1440,'height':940})
        def until(predicate,page,timeout=20):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                if value:=predicate():return value
                page.wait_for_timeout(80)
            raise AssertionError('timed out: '+page.locator('body').inner_text()[-2500:])
        def api(url,opts=None):
            opts=opts or {};path=urlparse(url).path;method=opts.get('method','GET');body=json.loads(opts['body']) if opts.get('body') else None
            auth=opts.get('headers',{}).get('Authorization','').removeprefix('Bearer ')
            code,value=b.call(method,path,body,token=auth or False)
            if method=='POST' and path=='/api/tasks' and adapter['loseAck']:
                adapter['loseAck']=False;raise RuntimeError('test lost ACK after actual backend commit')
            return {'status':code,'body':value}
        def ui(account=None,conversation='',page_id=None):
            page_id=page_id or str(uuid.uuid4());store=stores.setdefault(account['id'] if account else 'unpaired',{})
            if account:store.setdefault('doubao.v12.connection',json.dumps({'token':account['token'],'enabled':True}))
            session=page_stores.setdefault(page_id,{})
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.expose_function('__api',api)
            page.expose_function('__saveLocal',lambda k,v:store.pop(k,None) if v is None else store.update({k:v}))
            page.expose_function('__saveSession',lambda k,v:session.pop(k,None) if v is None else session.update({k:v}))
            def runtime(op,extra):
                if op=='ui-status':return {'ok':True,'paired':True,'settings':{'accountId':account['id'] if account else ''},'status':{'ready':adapter['ready'],'backend':'online','detail':'受控测试桥接 · 不连接真实账号'}}
                if op=='ui-prepare-bridge' and not adapter['ready']:return {'ok':False,'error':'本会话工作页未就绪，消息未入队'}
                return {'ok':True,'ready':adapter['ready']}
            page.expose_function('__runtime',runtime)
            html=(ROOT/'web/app.html').read_text().replace('<script type="module" src="app.js"></script>','').replace('<link rel="stylesheet" href="app.css">','<style>'+(ROOT/'web/app.css').read_text()+'</style>')
            icon='data:image/svg+xml;base64,'+base64.b64encode((ROOT/'web/icon.svg').read_bytes()).decode();html=html.replace('src="icon.svg"','src="'+icon+'"')
            page.set_content(html)
            page.add_script_tag(content='window.__store='+json.dumps(store)+';window.__session='+json.dumps(session)+';window.__loc=new URL('+json.dumps(origin+'/web/'+('?c='+conversation if conversation else ''))+');'+r'''
            if(!crypto.randomUUID)crypto.randomUUID=()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
            window.__localStorage={getItem:k=>__store[k]??null,setItem:(k,v)=>{__store[k]=v;__saveLocal(k,v);},removeItem:k=>{delete __store[k];__saveLocal(k,null);}};
            window.__sessionStorage={getItem:k=>__session[k]??null,setItem:(k,v)=>{__session[k]=v;__saveSession(k,v);},removeItem:k=>{delete __session[k];__saveSession(k,null);}};
            window.__history={replaceState:(a,b,url)=>{__loc=new URL(url,__loc.origin);}};
            async function webWorker(op,extra={}){const r=await __runtime(op,extra);if(!r.ok)throw new Error(r.error);return r;}
            window.fetch=async(url,opts={})=>{
              if(url.endsWith('/events')){let closed=false;return new Response(new ReadableStream({async pull(c){
                if(closed)return;if(opts.signal?.aborted){closed=true;c.close();return;}
                const r=await __api(url.slice(0,-7),{headers:opts.headers});if(closed)return;
                if(r.status!==200){closed=true;c.error(new Error('snapshot failed'));return;}
                c.enqueue(new TextEncoder().encode('id: '+r.body.version+'\nevent: snapshot\ndata: '+JSON.stringify(r.body)+'\n\n'));
                if(['completed','cancelled','interrupted','error'].includes(r.body.state)){closed=true;c.close();return;}
                await new Promise(r=>setTimeout(r,120));
              },cancel(){closed=true;}}),{status:200,headers:{'Content-Type':'text/event-stream'}});}
              const r=await __api(url,opts);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});
            };''')
            shared=(ROOT/'web/shared.js').read_text().replace('export ','');render=(ROOT/'web/render.js').read_text().replace('export ','')
            app=re.sub(r'^import .*\n','',(ROOT/'web/app.js').read_text(),flags=re.M).replace('location.origin','__loc.origin').replace('location.href','__loc.href').replace('history.replaceState','__history.replaceState').replace('localStorage','__localStorage').replace('sessionStorage','__sessionStorage')
            page.add_script_tag(content=shared+'\n'+render+'\n'+app)
            until(lambda:page.locator('#accountName').inner_text()==('未连接工作区' if not account else ('账号 A · 工作' if account['id']==a['id'] else '账号 B · 个人')),page)
            if conversation:until(lambda:page.locator('#conversationTitle').inner_text()!='新对话',page)
            return page
        def tasks(account):return b.call('GET','/api/tasks',token=account['token'])[1]['tasks']
        def finish(account,conv,text):
            _,r=b.poll(account,conv);t=r['task'];assert t is not None
            code,r=b.event(account,t,1,'done',text=text);assert code==200,(code,r);return t
        def event(packet):
            if packet['type']=='bridge-hello':return {'ok':True,'bound':True}
            account,t=active[packet['id']];old=event_seq.setdefault(t['id'],{'seq':0,'ids':{}})
            if packet['eventId'] in old['ids']:return old['ids'][packet['eventId']]
            code,r=b.event(account,t,old['seq']+1,packet['eventType'],**{k:v for k,v in packet.items() if k in ['text','checkpoint','detail']})
            result={'ok':code==200,**r,'retry':code>=500}
            if code==200:old['seq']=r['lastSeq'];old['ids'][packet['eventId']]=result
            return result
        def content(account,t):
            active[t['id']]=(account,t);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.expose_function('__bridgeEvent',event)
            html=(ROOT/'tests/chatgpt-fixture.html').read_text();html=re.sub(r"window.fixture=JSON.parse\(sessionStorage.*?;",'window.fixture={count:0,message:"",phase:"idle",text:"",stopCount:0};',html)
            html=html.replace("sessionStorage.setItem('fixture',JSON.stringify(fixture));",'')
            page.set_content(html);page.add_script_tag(content=r'''
            window.__upstream='https://chatgpt.com/';window.__listeners=[];
            if(!crypto.randomUUID)crypto.randomUUID=()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
            window.chrome={runtime:{id:'offline-fixture',sendMessage:async p=>__bridgeEvent(p),onMessage:{addListener:f=>__listeners.push(f),removeListener:f=>{__listeners=__listeners.filter(x=>x!==f);}}}};
            window.deliver=p=>new Promise(resolve=>{for(const f of __listeners)f(p,{},resolve);});''')
            page.add_script_tag(content=(ROOT/'extension/bridge-core.js').read_text());page.add_script_tag(content=(ROOT/'extension/content.js').read_text().replace('location.href','__upstream'))
            info=page.evaluate("deliver({type:'jsc-ping'})")
            response=page.evaluate("p=>deliver(p)",{'type':'jsc-run','documentKey':info['documentKey'],'task':t,'checkpoint':t.get('checkpoint',{}),'expectedUrl':''});assert response['ok']
            return page
        try:
            home=ui(a);home.screenshot(path=str(out/'multi-account-home.png'));passed('actual UI initializes with scoped account and independent-history sidebar')
            home.click('#accountCard');assert home.locator('#token').input_value()==a['token'];assert home.locator('#copyCurrentToken').is_enabled();assert home.locator('#quickSetup').is_hidden();home.click('[data-close=settingsDialog]');passed('connected chat page exposes a direct copy action for its account token')
            u1=ui(a,ac['id'],'window1');u2=ui(a,ac2['id'],'window2');uz=ui(z,zc['id'],'windowB')
            u1.fill('#input','只属于网页一的草稿');u2.fill('#input','只属于网页二的草稿');u1.evaluate('select("")');u1.evaluate('id=>select(id)',ac['id']);assert u1.locator('#input').input_value()=='只属于网页一的草稿';assert u2.locator('#input').input_value()=='只属于网页二的草稿';assert u2.locator('#conversationTitle').inner_text()=='技术文档整理'
            passed('same-account pages keep independent conversation selection and session drafts')
            assert '旅行与生活灵感' not in u1.locator('#history').inner_text();assert '产品开发计划' not in uz.locator('#history').inner_text();passed('different-account UIs show only their own histories')
            adapter['ready']=False;u1.click('#send');until(lambda:'未入队' in u1.locator('#banner').inner_text(),u1);assert not tasks(a);assert u1.locator('#input').input_value()=='只属于网页一的草稿';adapter['ready']=True;passed('unready per-conversation page preserves draft and prevents task creation')
            u1.fill('#input','账号 A 的开发需求');u2.fill('#input','账号 A 的独立技术整理');uz.fill('#input','账号 B 的私人计划');u1.click('#send');u2.click('#send');uz.click('#send')
            until(lambda:len(tasks(a))==2 and len(tasks(z))==1,u1)
            for acc,conv,text in [(a,ac,'这是工作会话的独立回复。'),(a,ac2,'这是技术会话的独立回复。'),(z,zc,'这是个人账号的独立回复。')]:finish(acc,conv,text)
            until(lambda:'独立回复' in u1.locator('#messages').inner_text(),u1);until(lambda:'技术会话' in u2.locator('#messages').inner_text(),u2);until(lambda:'个人账号' in uz.locator('#messages').inner_text(),uz)
            assert '个人账号' not in u1.locator('#messages').inner_text();assert '工作会话' not in uz.locator('#messages').inner_text();passed('three simultaneous pages receive correctly routed snapshots from real Java backend')
            mirror=ui(a,ac['id']);assert mirror.locator('#messages').inner_text()==u1.locator('#messages').inner_text();passed('same conversation can be viewed in two pages without creating extra tasks')
            u1.fill('#input','刷新仍在这个会话的草稿');u1.close();u1=ui(a,ac['id'],'window1');assert u1.locator('#input').input_value()=='刷新仍在这个会话的草稿';passed('page reconstruction restores URL-selected conversation and its own saved draft')
            adapter['loseAck']=True;u1.fill('#input','提交后丢失确认的消息');u1.click('#send');until(lambda:u1.locator('#send').inner_text()=='重试确认',u1);count=len(tasks(a));u1.click('#send');until(lambda:u1.locator('#send').inner_text()=='发送 ↑',u1);assert len(tasks(a))==count;finish(a,ac,'只处理一次');passed('lost HTTP acknowledgement retries the same request ID, not a new message')
            u1.evaluate("renderMarkdown(document.querySelector('#messages'), '<img src=x onerror=alert(1)> [bad](javascript:alert(1)) **安全加粗**\\n```html\\n<script>alert(1)</script>\\n```')")
            assert u1.locator('#messages script').count()==0;assert u1.locator('#messages img').count()==0;assert u1.locator('#messages a').count()==0;assert u1.locator('#messages strong').inner_text()=='安全加粗';passed('Markdown renderer treats raw HTML and unsafe URLs as inert text')
            home.set_viewport_size({'width':390,'height':844});home.wait_for_timeout(150);assert home.evaluate('document.documentElement.scrollWidth<=innerWidth+1');home.screenshot(path=str(out/'multi-account-mobile.png'));passed('mobile 390px viewport has no horizontal overflow')
            home.set_viewport_size({'width':1440,'height':940});home.click('#openAdmin');home.fill('#adminToken',b.token);home.fill('#newAccountName','测试账号 C');home.click('#createAccount');until(lambda:not home.locator('#credentialBox').is_hidden(),home);assert len(home.locator('#createdToken').input_value())>=40;home.click('[data-close=adminDialog]');until(lambda:home.locator('#adminToken').input_value()=='',home);assert home.locator('#createdToken').input_value()=='';assert b.token not in json.dumps(stores);passed('admin UI creates scoped credentials, clears sensitive dialog fields, never persists master token')
            # Exercise the actual content adapter in two controlled ChatGPT-like DOMs.
            cc=b.conv(a,'受控搜索测试');dd=b.conv(z,'受控并行测试');b.create(a,cc,'搜索并汇总 A');b.create(z,dd,'并行处理 B');ta=b.poll(a,cc)[1]['task'];tz=b.poll(z,dd)[1]['task'];pa=content(a,ta);pz=content(z,tz)
            until(lambda:pa.evaluate('fixture.count')==1,pa);until(lambda:pz.evaluate('fixture.count')==1,pz)
            for pg,tid in [(pa,ta['id']),(pz,tz['id'])]:pg.evaluate("id=>{__upstream='https://chatgpt.com/c/'+id;fixture.phase='searching';fixture.text='搜索阶段临时文字';render();}",tid)
            pa.wait_for_timeout(8000);assert b.call('GET','/api/tasks/'+ta['id'],token=a['token'])[1]['state']=='running';assert b.call('GET','/api/tasks/'+tz['id'],token=z['token'])[1]['state']=='running'
            passed('two actual DOM adapters remain running during a long search pause')
            pa.evaluate("fixture.phase='complete';fixture.text='A 搜索后的最终结果';render();");pz.evaluate("fixture.phase='complete';fixture.text='B 并行处理最终结果';render();")
            until(lambda:b.call('GET','/api/tasks/'+ta['id'],token=a['token'])[1]['state']=='completed',pa,25);until(lambda:b.call('GET','/api/tasks/'+tz['id'],token=z['token'])[1]['state']=='completed',pz,25)
            assert b.call('GET','/api/tasks/'+ta['id'],token=a['token'])[1]['text']=='A 搜索后的最终结果';assert b.call('GET','/api/tasks/'+tz['id'],token=z['token'])[1]['text']=='B 并行处理最终结果';assert pa.evaluate('fixture.count')==pz.evaluate('fixture.count')==1
            passed('actual adapters bind different upstream URLs, replace rewritten text, and finish without cross-account replies')
            u1.evaluate('refresh(true)');u1.wait_for_timeout(250);u1.screenshot(path=str(out/'multi-account-thread.png'))
            assert not errors,errors;passed('no unhandled page JavaScript errors across controlled scenes')
            (out/'ui-results.json').write_text(json.dumps({'passed':results,'unhandledErrors':errors,'scope':'Offline browser adapters; real Java HTTP; no actual profile/extension install or ChatGPT login.'},ensure_ascii=False,indent=2))
        finally:
            browser.close();b.cleanup()
    print(f'{len(results)} UI / DOM scenarios passed')
if __name__=='__main__':main()
