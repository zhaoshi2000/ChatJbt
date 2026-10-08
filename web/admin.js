import {apiRequest} from './shared.js';
import {webWorker} from './web-rpc.js';
const $=id=>document.getElementById(id),config=()=>({backendUrl:location.origin,token:$('adminToken').value.trim()});
function result(text,error=false){$('result').textContent=text;$('result').classList.toggle('error',error);}
async function copy(text){await navigator.clipboard.writeText(text);result('账号令牌已复制。');}
async function loadAccounts(){
  try{
    const response=await apiRequest(config(),'/api/accounts');$('accounts').replaceChildren();
    if(!response.accounts.length){$('accounts').innerHTML='<p class="empty">还没有账号。</p>';return;}
    for(const account of response.accounts){
      const row=document.createElement('div');row.className='account';const info=document.createElement('div'),name=document.createElement('strong'),note=document.createElement('small');name.textContent=account.name;note.textContent=account.clientId?'已绑定独立配置文件 · '+(account.profileLabel||account.clientId.slice(0,8)):'尚未绑定浏览器';info.append(name,note);
      const actions=document.createElement('div');actions.className='account-actions';const show=document.createElement('button'),hide=document.createElement('button'),rotate=document.createElement('button');show.textContent='显示工作浏览器';hide.textContent='隐藏到后台';rotate.textContent='重置令牌与绑定';rotate.className='danger';show.disabled=hide.disabled=!account.clientId;
      show.addEventListener('click',()=>control(account,'ui-show-work-window','已显示工作浏览器。'));hide.addEventListener('click',()=>control(account,'ui-hide-work-window','已隐藏到后台。'));rotate.addEventListener('click',async()=>{if(!confirm('重置 '+account.name+' 的令牌和浏览器绑定？'))return;try{showCredential(await apiRequest(config(),'/api/accounts/'+account.id+'/rotate',{method:'POST',body:{}}));await loadAccounts();}catch(error){result(error.message,true);}});actions.append(show,hide,rotate);row.append(info,actions);$('accounts').append(row);
    }
    result('已读取 '+response.accounts.length+' 个账号。');
  }catch(error){result(error.message,true);}
}
async function control(account,operation,success){try{await webWorker(operation,{accountId:account.id});result(account.name+'：'+success);}catch(error){result('请在 '+account.name+' 对应的独立浏览器配置文件中打开本控制台：'+error.message,true);}}
function showCredential(response){$('credentialTitle').textContent=response.account.name+' · 专属令牌';$('createdToken').value=response.token;$('credential').hidden=false;result('账号令牌只显示一次，请立即保存。');}
$('loadAccounts').addEventListener('click',loadAccounts);$('refreshAccounts').addEventListener('click',loadAccounts);
$('createAccount').addEventListener('click',async()=>{try{showCredential(await apiRequest(config(),'/api/accounts',{method:'POST',body:{name:$('newAccountName').value}}));$('newAccountName').value='';await loadAccounts();}catch(error){result(error.message,true);}});
$('copyToken').addEventListener('click',()=>copy($('createdToken').value));
$('legacyExport').addEventListener('click',async()=>{try{const data=await apiRequest(config(),'/api/legacy-export'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='GBT-旧版归档.json';a.click();URL.revokeObjectURL(url);}catch(error){result(error.message,true);}});
window.addEventListener('pagehide',()=>{$('adminToken').value='';$('createdToken').value='';});
