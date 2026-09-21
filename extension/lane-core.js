/** Pure routing guards shared by the worker tests. Never infer an account from a tab title. */
export function chatUrl(raw) {
  try { const u=new URL(raw);return u.protocol==='https:'&&['chatgpt.com','chat.openai.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port; } catch{return false;}
}
export function conversationUrl(raw) {
  if(!chatUrl(raw))return '';
  const u=new URL(raw);
  return /^\/(?:g\/[A-Za-z0-9_-]+\/)?c\/(?:WEB:)?[A-Za-z0-9_-]+$/.test(u.pathname)?'https://chatgpt.com'+u.pathname:'';
}
export function stableConversationUrl(raw) {
  const url=conversationUrl(raw);
  return url&&!/\/c\/WEB:/.test(url)?url:'';
}
export function pageAtTarget(raw,target) {
  if(!target)return true;
  const wanted=conversationUrl(target);if(wanted)return conversationUrl(raw)===wanted;
  try{const actual=new URL(raw),goal=new URL(target);return chatUrl(actual.href)&&chatUrl(goal.href)&&actual.hostname===goal.hostname&&actual.pathname==='/'&&goal.pathname==='/';}catch{return false;}
}
export function validId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(value);}
export function assertTask(task, accountId, conversationId) {
  if(!task||task.accountId!==accountId||task.conversationId!==conversationId||!validId(task.id))throw new Error('任务账号或会话不匹配，已拒绝执行');
}
export function assertPacket(packet, sender, lane) {
  if(!lane?.active||sender.frameId!==0||sender.tab?.id!==lane.bridge?.tabId||!chatUrl(sender.url)||packet.documentKey!==lane.bridge.documentKey||packet.id!==lane.active.task.id||packet.accountId!==lane.accountId||packet.conversationId!==lane.conversationId)
    throw new Error('任务、账号、会话或页面文档不匹配，拒绝回传');
}
export function planTaskIds(tasks, activeIds, capacity) {
  // Already-running local lanes have reserved capacity. Queue ordering is stable.
  const result=[...activeIds];
  for(const t of [...tasks].reverse())if(!['completed','error','cancelled','interrupted'].includes(t.state)&&!result.includes(t.conversationId)&&result.length<capacity)result.push(t.conversationId);
  return result;
}
