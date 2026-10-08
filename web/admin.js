import {apiRequest} from './shared.js';
import {webWorker} from './web-rpc.js';
const $=id=>document.getElementById(id),BACKEND={backendUrl:location.origin},CONNECTION_KEY='doubao.v12.connection';
const adminRequest=(path,options={})=>apiRequest(BACKEND,path,{...options,credentials:'same-origin'});
function result(text,error=false){$('result').textContent=text;$('result').classList.toggle('error',error);}
async function bindCurrent(response){
  await webWorker('web-pair',{token:response.token,enabled:true,confirmProfile:true,profileLabel:response.account.name});
  const grant=await webWorker('ui-web-session');
  await apiRequest(BACKEND,'/api/web-session/exchange',{method:'POST',body:{code:grant.code},credentials:'same-origin'});
  localStorage.setItem(CONNECTION_KEY,JSON.stringify({backendUrl:location.origin,enabled:true,accountId:response.account.id}));
  result(response.account.name+' 已自动绑定到当前浏览器；没有需要复制的令牌。');
}
async function loadAccounts(){
  try{
    const response=await adminRequest('/api/admin-console/accounts');$('accounts').replaceChildren();
    if(!response.accounts.length){$('accounts').innerHTML='<p class="empty">还没有账号，可以直接在上方创建。</p>';result('本机管理已就绪。');return;}
    for(const account of response.accounts){
      const row=document.createElement('div');row.className='account';const info=document.createElement('div'),name=document.createElement('strong'),note=document.createElement('small');name.textContent=account.name;note.textContent=account.clientId?'已绑定独立配置文件 · '+(account.profileLabel||account.clientId.slice(0,8)):'尚未绑定浏览器';info.append(name,note);
      const actions=document.createElement('div');actions.className='account-actions';const show=document.createElement('button'),hide=document.createElement('button'),bind=document.createElement('button');show.textContent='显示工作浏览器';hide.textContent='隐藏到后台';bind.textContent=account.clientId?'重新绑定当前浏览器':'绑定当前浏览器';bind.className='danger';show.disabled=hide.disabled=!account.clientId;
      show.addEventListener('click',()=>control(account,'ui-show-work-window','已显示工作浏览器。'));hide.addEventListener('click',()=>control(account,'ui-hide-work-window','已隐藏到后台。'));bind.addEventListener('click',async()=>{if(account.clientId&&!confirm('重新绑定 '+account.name+' 到当前浏览器？原浏览器绑定将失效。'))return;try{const response=await adminRequest('/api/admin-console/accounts/'+account.id+'/rotate',{method:'POST',body:{}});await bindCurrent(response);await loadAccounts();}catch(error){result(error.message,true);}});actions.append(show,hide,bind);row.append(info,actions);$('accounts').append(row);
    }
    result('已读取 '+response.accounts.length+' 个账号。');
  }catch(error){result(error.message,true);}
}
async function control(account,operation,success){try{await webWorker(operation,{accountId:account.id});result(account.name+'：'+success);}catch(error){result('请在 '+account.name+' 对应的独立浏览器配置文件中打开本控制台：'+error.message,true);}}
$('refreshAccounts').addEventListener('click',loadAccounts);
$('createAccount').addEventListener('click',async()=>{try{const response=await adminRequest('/api/admin-console/accounts',{method:'POST',body:{name:$('newAccountName').value}});await bindCurrent(response);$('newAccountName').value='';await loadAccounts();}catch(error){result(error.message,true);}});
$('legacyExport').addEventListener('click',async()=>{try{const data=await adminRequest('/api/admin-console/legacy-export'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='GBT-旧版归档.json';a.click();URL.revokeObjectURL(url);}catch(error){result(error.message,true);}});
loadAccounts();
