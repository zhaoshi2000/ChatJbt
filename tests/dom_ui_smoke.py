"""Offline Chromium DOM/UI tests + real local Java backend.
Browser policies in the execution environment disallow loading extensions and URL navigation.
This harness uses set_content and injected runtime/fetch adapters, NOT a real MV3 lifecycle.
"""
from pathlib import Path
import base64,json,os,tempfile,time
from integration import Backend,ROOT
from playwright.sync_api import sync_playwright

results=[]
def passed(name):results.append(name);print('PASS:',name,flush=True)
def main():
    b=Backend('browser',extra={'TASK_TIMEOUT_SECONDS':'180'})
    output=Path(os.environ.get('TEST_ARTIFACTS',str(ROOT/'test-artifacts')));output.mkdir(parents=True,exist_ok=True)
    active={};events={};seq=0;adapter={'ready':True,'losePostAck':False}
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        context=browser.new_context(viewport={'width':1360,'height':900});errors=[];saved_storage={}
        context.add_init_script("if(!crypto.randomUUID)crypto.randomUUID=()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));")
        def api(url,options=None):
            from urllib.parse import urlparse
            opts=options or {};method=opts.get('method','GET');body=opts.get('body');body=json.loads(body) if body else None
            code,data,headers=b.call(method,urlparse(url).path,body,auth=False,headers=opts.get('headers',{}))
            if method=='POST' and urlparse(url).path=='/api/tasks' and adapter['losePostAck']:
                adapter['losePostAck']=False;raise RuntimeError('simulated connection loss AFTER task creation')
            return {'status':code,'body':data,'headers':headers}
        def event(packet):
            nonlocal seq
            if packet['type']=='bridge-hello':return {'ok':True,'bound':True}
            if packet['eventId'] in events:return events[packet['eventId']]
            code,result,_=b.event(active,seq+1,packet['eventType'],**{k:v for k,v in packet.items() if k in ['text','checkpoint','detail']})
            if code==200:
                seq=result.get('lastSeq',seq+1);result={'ok':True,**result};events[packet['eventId']]=result
            else:result={'ok':False,'retry':code>=500,'error':result.get('error')}
            return result
        def until(predicate,page,timeout=25):
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                val=predicate()
                if val:return val
                page.wait_for_timeout(100)
            raise AssertionError('condition timed out; '+str(page.evaluate('document.querySelector("#banner")?.textContent || document.body.innerText').__str__()))
        def make_chat(state=None):
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            html=(ROOT/'tests/chatgpt-fixture.html').read_text(encoding='utf-8')
            start="window.fixture=JSON.parse(sessionStorage.getItem('fixture')||'{\"count\":0,\"message\":\"\",\"phase\":\"idle\",\"text\":\"\",\"stopCount\":0}');"
            html=html.replace(start,'window.fixture='+json.dumps(state or {'count':0,'message':'','phase':'idle','text':'','stopCount':0},ensure_ascii=False)+';')
            html=html.replace("sessionStorage.setItem('fixture',JSON.stringify(fixture));",'/* state is supplied by the offline reload harness */')
            page.set_content(html);page.expose_function('__bridgeEvent',event)
            page.add_script_tag(content="""window.__listeners=[];window.chrome={runtime:{id:'offline-fixture',sendMessage:async p=>__bridgeEvent(p),onMessage:{addListener:f=>__listeners.push(f),removeListener:f=>{__listeners=__listeners.filter(x=>x!==f);}}}};window.deliver=p=>new Promise(resolve=>{for(const f of __listeners)f(p,{},resolve);});""")
            page.add_script_tag(content=(ROOT/'extension/bridge-core.js').read_text(encoding='utf-8'));page.add_script_tag(content=(ROOT/'extension/content.js').read_text(encoding='utf-8'));return page
        def make_ui():
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.expose_function('__api',api)
            page.expose_function('__save',lambda k,v:saved_storage.update({k:json.loads(v)}))
            def runtime(packet):
                if packet['type']=='web-pair':return {'ok':True}
                if packet['type']=='ui-prepare-bridge':return {'ok':True,'ready':True,'detail':'controlled DOM fixture ready'} if adapter['ready'] else {'ok':False,'error':'网页未接入，消息尚未入队，草稿已保留。'}
                if packet['type'] in ['ui-open-bridge','ui-bind-current','ui-repair']:return {'ok':True,'ready':adapter['ready'],'detail':'controlled page connection'}
                if packet['type']=='ui-status':return {'ok':True,'settings':saved_storage.get('settings'),'bridge':{'tabId':1,'url':'offline DOM fixture (not a real account)'},'status':{'ready':adapter['ready'],'backend':'online','detail':'网页桥接 · 受控测试页面' if adapter['ready'] else '网页未接入，请接入工作标签页','paused':False},'active':bool(active and b.task(active['id'])['state']=='running')}
                return {'ok':True}
            page.expose_function('__runtime',runtime)
            html=(ROOT/'web/app.html').read_text(encoding='utf-8').replace('<script type="module" src="app.js"></script>','').replace('<link rel="icon" href="icon.svg"><link rel="stylesheet" href="app.css">','<style>'+(ROOT/'web/app.css').read_text(encoding='utf-8')+'</style>')
            icon='data:image/svg+xml;base64,'+base64.b64encode((ROOT/'web/icon.svg').read_bytes()).decode()
            html=html.replace('src="icon.svg"','src="'+icon+'"');page.set_content(html)
            config={'settings':{'backendUrl':f'http://127.0.0.1:{b.port}','token':b.token,'enabled':True},**saved_storage}
            page.add_script_tag(content='window.__storage='+json.dumps(config,ensure_ascii=False)+';'+r'''
              window.__localStorage={getItem:k=>JSON.stringify(__storage[k.slice(4)]??null),setItem:(k,v)=>{__storage[k.slice(4)]=JSON.parse(v);__save(k.slice(4),v);}};
              async function webWorker(type,extra={}){const r=await __runtime({type,...extra});if(!r?.ok)throw new Error(r?.error||'offline transport failed');return r;}
              window.fetch=async(url,opts={})=>{
                if(url.endsWith('/events')){
                  let closed=false;const stream=new ReadableStream({async pull(c){
                    if(closed)return;
                    if(opts.signal?.aborted){closed=true;c.close();return;}
                    const r=await __api(url.slice(0,-7),{method:'GET',headers:opts.headers});
                    if(r.status!==200){closed=true;c.error(new Error('snapshot fetch failed'));return;}
                    c.enqueue(new TextEncoder().encode('id: '+r.body.version+'\nevent: snapshot\ndata: '+JSON.stringify(r.body)+'\n\n'));
                    if(['completed','error','interrupted','cancelled'].includes(r.body.state)){closed=true;c.close();return;}
                    await new Promise(r=>setTimeout(r,250));
                  },cancel(){closed=true;}});
                  return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream'}});
                }
                const r=await __api(url,opts);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});
              };
            ''')
            shared=(ROOT/'web/shared.js').read_text(encoding='utf-8').replace('export ','')
            app=(ROOT/'web/app.js').read_text(encoding='utf-8');app='\n'.join(app.split('\n')[2:]);app=app.replace('location.origin',json.dumps(f'http://127.0.0.1:{b.port}')).replace('localStorage','__localStorage')
            # The production modules are evaluated unchanged except ESM import/export linkage.
            page.add_script_tag(content=shared+'\n'+app);page.wait_for_function("document.querySelector('#connection').textContent.includes('后端在线')");return page
        try:
            ui=make_ui();ui.screenshot(path=str(output/'welcome.png'));passed('web UI initializes with authenticated Java backend using explicit offline origin/storage/fetch and extension-message adapters')
            adapter['ready']=False;ui.fill('#input','11');ui.click('#send')
            until(lambda:'未入队' in ui.locator('#banner').inner_text(),ui)
            assert b.call('GET','/api/tasks')[1]['tasks']==[]
            assert ui.locator('#input').input_value()=='11'
            assert not ui.evaluate('__storage.uiState.pendingSend')
            ui.evaluate('refresh()');assert '未入队' in ui.locator('#banner').inner_text()
            passed('unready page blocks POST /api/tasks, preserves draft, and keeps the reason after a refresh')
            adapter['ready']=True
            ui.fill('#input','请检查搜索等待、断线恢复和回复重绘，最后给出结果。')
            ui.evaluate('Promise.all([submitMessage(),submitMessage()])')
            task=until(lambda:next(iter(b.call('GET','/api/tasks')[1]['tasks']),None),ui)
            assert len(b.call('GET','/api/tasks')[1]['tasks'])==1
            passed('simultaneous Send calls only create one backend task after a successful preflight')
            ui.wait_for_selector('#queueNotice:not([hidden])');ui.click('#resumeQueue')
            assert len(b.call('GET','/api/tasks')[1]['tasks'])==1
            assert b.task(task['id'])['state']=='queued'
            passed('connect-and-continue on an existing queued task creates no duplicate task')
            adapter['ready']=False;ui.evaluate('refresh()')
            ui.set_viewport_size({'width':400,'height':800});ui.wait_for_timeout(250)
            assert '尚未交给 ChatGPT' in ui.locator('#queueReason').inner_text()
            dims=ui.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,send:document.querySelector("#send").getBoundingClientRect().toJSON()})')
            assert dims['scroll']<=dims['width'] and dims['send']['bottom']<=800
            ui.screenshot(path=str(output/'queue-unbound.png'),full_page=True)
            adapter['ready']=True;ui.set_viewport_size({'width':1360,'height':900})
            passed('unbound queued task has an actionable reason at 400px mobile width without overflow')
            active=b.call('POST','/api/browser/poll',{'clientId':'offline-dom-bridge','waitSeconds':0})[1]['task'];seq=active['lastSeq']
            chat=make_chat();chat.evaluate('(task)=>deliver({type:"jsc-run",task,checkpoint:task.checkpoint})',active)
            until(lambda:chat.evaluate('fixture.count')==1,chat);until(lambda:b.task(task['id'])['text'],chat)
            chat.wait_for_timeout(2500);assert b.task(task['id'])['state']=='running'
            passed('real content script does not complete during a search pause with no Stop button')
            ui.evaluate('window.dispatchEvent(new Event("pagehide"))');ui.wait_for_timeout(400);ui.close();chat.wait_for_timeout(200);assert b.task(task['id'])['state']=='running'
            passed('closing the observer UI leaves the real Java task running')
            state=chat.evaluate('fixture');chat.evaluate('__JSCBridge.dispose()');chat.wait_for_timeout(400);chat.close();chat=make_chat(state)
            restored=b.call('POST','/api/browser/poll',{'clientId':'offline-dom-bridge','waitSeconds':0})[1]['task']
            chat.evaluate('(task)=>deliver({type:"jsc-run",task,checkpoint:task.checkpoint})',restored)
            chat.wait_for_timeout(1800);assert chat.evaluate('fixture.count')==1
            passed('a fresh document with the original user-message ID resumes without sending again')
            b.kill();chat.wait_for_timeout(700);b.start()
            final_text='恢复测试完成。\n\n搜索等待期间，任务没有提前结束；重新连接后，当前回复以完整快照更新。\n\n```java\nSystem.out.println("Stream Chat 已恢复");\n```\n\n安全检查：<img src=x onerror=alert(1)> 仅作为文字显示。'
            chat.evaluate('(text)=>setFixture("complete",text)',final_text)
            final=until(lambda:(t if (t:=b.task(task['id']))['state']=='completed' else None),chat,35)
            assert final['text']==final_text,(repr(final['text']),repr(final_text));assert chat.evaluate('fixture.count')==1
            passed('backend restart and a complete assistant DOM replacement preserve exactly the final snapshot')
            ui=make_ui();ui.wait_for_selector('#taskContent:not([hidden])')
            until(lambda:ui.locator('#taskState').inner_text()=='已完成',ui)
            assert ui.locator('#answer img').count()==0;assert '<img src=x onerror=alert(1)>' in ui.locator('#answer').inner_text()
            assert ui.locator('#answer code').inner_text().strip()=='System.out.println("Stream Chat 已恢复");'
            passed('reopening restores task history, code blocks, and inert HTML text')
            ui.evaluate('document.querySelector("#conversation").scrollTop=0');ui.screenshot(path=str(output/'desktop.png'),full_page=True)
            for width in (400,320):
                ui.set_viewport_size({'width':width,'height':800});ui.wait_for_timeout(200)
                dims=ui.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,send:document.querySelector("#send").getBoundingClientRect().toJSON()})')
                assert dims['scroll']<=dims['width'],dims;assert dims['send']['bottom']<=800,dims
                if width==400:ui.screenshot(path=str(output/'mobile.png'),full_page=True)
            passed('1360 px desktop and 400/320 px mobile layouts avoid horizontal overflow and keep Send visible')
            ui.set_viewport_size({'width':1360,'height':900});ui.click('#newTask');ui.wait_for_timeout(200);ui.screenshot(path=str(output/'welcome-desktop.png'),full_page=True)
            ui.set_viewport_size({'width':400,'height':800});ui.screenshot(path=str(output/'welcome-sidepanel.png'),full_page=True)
            ui.click('#settingsButton');ui.wait_for_selector('#settingsDialog[open]');ui.click('#refreshDiagnostics');ui.wait_for_timeout(300)
            diag=ui.locator('#diagnosticJson').inner_text();assert b.token not in diag;assert final_text not in diag;ui.click('#closeSettings')
            passed('diagnostics contain neither local pairing token nor complete conversation text')
            ui.fill('#input','这条任务用于检查取消。');ui.click('#send')
            new=until(lambda:next((t for t in b.call('GET','/api/tasks')[1]['tasks'] if t['id']!=task['id']),None),ui)
            active=b.call('POST','/api/browser/poll',{'clientId':'offline-dom-bridge','waitSeconds':0})[1]['task'];seq=active['lastSeq']
            chat.evaluate('(task)=>deliver({type:"jsc-run",task,checkpoint:task.checkpoint})',active)
            until(lambda:chat.evaluate('fixture.count')==2,chat);chat.evaluate('setFixture("generating","可以取消的部分回复")')
            until(lambda:b.task(new['id'])['text']=='可以取消的部分回复',chat)
            ui.wait_for_selector('#cancelTask:not([hidden])');ui.click('#cancelTask');until(lambda:b.task(new['id'])['state']=='cancelled',ui)
            chat.evaluate('(id)=>deliver({type:"jsc-release",id,state:"cancelled"})',new['id']);assert chat.evaluate('fixture.stopCount')==1
            passed('UI cancellation reaches Java and the content adapter stops the owned turn')
            before_count=len(b.call('GET','/api/tasks')[1]['tasks'])
            adapter['losePostAck']=True;adapter['ready']=True
            ui.fill('#input','模拟后端已收下任务但应答丢失');ui.click('#send')
            until(lambda:bool(ui.evaluate('__storage.uiState.pendingSend')),ui)
            until(lambda:'发送状态不确定' in ui.locator('#banner').inner_text(),ui)
            rid=ui.evaluate('__storage.uiState.pendingSend.requestId')
            assert len(b.call('GET','/api/tasks')[1]['tasks'])==before_count+1
            adapter['ready']=False;ui.click('#send')
            until(lambda:not ui.evaluate('__storage.uiState.pendingSend'),ui)
            assert len(b.call('GET','/api/tasks')[1]['tasks'])==before_count+1
            last=next(t for t in b.call('GET','/api/tasks')[1]['tasks'] if t['message']=='模拟后端已收下任务但应答丢失')
            assert b.task(last['id'])['requestId']==rid
            passed('uncertain POST retries the same requestId even when the page is now unavailable; no duplicate task')
            assert not errors,errors;passed('no uncaught page JavaScript errors in the covered flows')
            (output/'dom-ui-results.json').write_text(json.dumps({'environment':'Offline Chromium document + runtime/fetch test adapters + real Java backend; not actual extension installation or live ChatGPT','count':len(results),'passed':results},ensure_ascii=False,indent=2),encoding='utf-8')
        finally:context.close();browser.close();b.close()
if __name__=='__main__':main()
