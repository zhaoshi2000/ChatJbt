import {DEFAULT_URL} from './shared.js';
const $=id=>document.getElementById(id);
async function rpc(type,extra={}){const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error||'后台未响应');return r;}
$('form').addEventListener('submit',async e=>{e.preventDefault();try{const r=await rpc('ui-save-settings',{settings:{backendUrl:$('backendUrl').value,token:$('token').value,enabled:$('enabled').checked,confirmProfile:$('confirmProfile').checked}});$('token').value='';$('status').textContent='已绑定账号：'+r.account.name+'。请到独立逗包网页新建会话。';}catch(error){$('status').textContent=error.message;}});
$('open').addEventListener('click',()=>rpc('ui-open-workspace').catch(e=>$('status').textContent=e.message));
rpc('ui-status').then(r=>{$('backendUrl').value=r.settings?.backendUrl||DEFAULT_URL;$('enabled').checked=r.settings?.enabled!==false;$('status').textContent=r.settings?.accountName?'当前配置文件绑定：'+r.settings.accountName:'首次使用：打开逗包网页 → 账号管理 → 创建账号工作区';}).catch(e=>$('status').textContent=e.message);
