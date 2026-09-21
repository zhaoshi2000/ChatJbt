export const VERSION = '1.2.1';
// Shared web/extension protocol version; all components ship together.
export const BACKEND_VERSION = '1.2.1';
export const DEFAULT_URL = 'http://127.0.0.1:48643';
export const TERMINAL = new Set(['completed', 'error', 'cancelled', 'interrupted']);
export const stateLabel = state => ({queued:'排队中',running:'处理中',completed:'已完成',error:'失败',cancelled:'已取消',interrupted:'已中断'}[state] || state);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function normalizeBaseUrl(value = DEFAULT_URL) {
  let u;
  try { u = new URL(value.trim()); } catch { throw new Error('后端地址格式不正确，例如 http://127.0.0.1:48643'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    throw new Error('本地版仅允许 http://127.0.0.1:端口 或 http://localhost:端口，不允许远程主机、路径或附加参数');
  }
  const port = Number(u.port || 80);
  if (port < 1024 || port > 65535) throw new Error('端口需在 1024–65535 之间');
  // The backend deliberately listens on IPv4 loopback, not localhost's possible IPv6 address.
  return `http://127.0.0.1:${port}`;
}
export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
export async function apiRequest(settings, path, {method = 'GET', body, signal, timeout = 7000} = {}) {
  const base = normalizeBaseUrl(settings.backendUrl || DEFAULT_URL);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  const timer = timeout ? setTimeout(() => controller.abort(new Error('连接超时')), timeout) : null;
  try {
    const headers = {Accept: 'application/json'};
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: controller.signal, credentials: 'omit', redirect: 'error'});
    let data;
    try { data = await response.json(); } catch { throw new ApiError('后端返回了无法识别的数据，请确认端口属于本项目 v1 后端', response.status); }
    if (!response.ok) throw new ApiError(data.error || `后端 HTTP ${response.status}`, response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    throw new ApiError(`无法连接 ${base}。请先运行 start-backend.bat，检查端口和后端日志；浏览器还可能阻止本地网络访问。${controller.signal.aborted ? '（连接超时）' : ''}`);
  } finally {
    if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
/** Streaming UTF-8 / CRLF aware SSE parser. Ignores comments and unknown fields. */
export async function* parseSse(body, onActivity = () => {}) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [], event = '', id = '';
  const consume = line => {
    if (line === '') {
      const result = data.length ? {event: event || 'message', id, data: data.join('\n')} : null;
      data = []; event = ''; return result;
    }
    if (line[0] === ':') return null;
    const index = line.indexOf(':'), field = index < 0 ? line : line.slice(0,index);
    let value = index < 0 ? '' : line.slice(index+1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
    if (field === 'id' && !value.includes('\0')) id = value;
    return null;
  };
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (value?.length) onActivity();
      buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
      if (buffer.length > 5_000_000) throw new Error('SSE 缓冲区过大');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,index).replace(/\r$/, ''); buffer = buffer.slice(index+1);
        const result = consume(line); if (result) yield result;
      }
      if (done) break;
    }
    // Do not interpret an unterminated/truncated final SSE frame as a successful response.
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export function formatDuration(ms) { const seconds = Math.max(0, Math.floor(ms/1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`; }
export function taskMarkdown(task) { return `# GBT\n\n时间：${new Date(task.created).toLocaleString()}\n状态：${stateLabel(task.state)}\n模式：${task.provider}\n\n## 你\n\n${task.message}\n\n## 回复\n\n${task.text || '（暂无正文）'}\n\n---\n${task.detail || ''}\n`; }

/** Explain why a browser task is queued without implying the model is rate limited. */
export function browserQueueHint({backendOnline = false, ready = false, paused = false, busy = false, hasDraft = false, activeTask = null, detail = ''} = {}) {
  if (!backendOnline) return '本地后端未连接；请先检查后端与配对令牌。';
  if (paused) return '后台接单已暂停。请在连接设置中开启“允许后台接收新任务”。';
  if (!ready) return '本地任务尚未交给 ChatGPT。' + (detail || '请点击“接入网页并继续”，绑定并检查工作标签页。');
  if (activeTask) return '工作标签页正在处理上一条本地任务；本任务等待上一条结束。';
  if (hasDraft) return '工作标签页输入框有未发送草稿；请先处理草稿，扩展不会覆盖它。';
  if (busy) return 'ChatGPT 网页正在处理其他消息；请等待网页空闲。';
  return '网页已接入，等待扩展领取本地任务。长时间无变化时点击“接入网页并继续”。';
}
