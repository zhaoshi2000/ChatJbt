/* Pure recovery/completion policy. Loaded before content.js; also exercised by Node tests. */
(() => {
  const normalize = text => String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
  const hash = text => { let n=2166136261; for (const ch of normalize(text)) n = Math.imul(n ^ ch.codePointAt(0),16777619); return (n>>>0).toString(16); };
  function mayComplete({text, hasMedia=false, busy, searching, completionAction, stableMs, settleMs = 8000}) {
    return (!!normalize(text)||hasMedia) && !busy && !searching && !!completionAction && stableMs >= settleMs;
  }
  function locateUser(users, checkpoint, message) {
    if (checkpoint.userKey) {
      const exact = users.findIndex(u => u.key === checkpoint.userKey && normalize(u.text) === normalize(message));
      if (exact >= 0) return exact;
      // A stable server message id must not silently fall back to an unrelated duplicate prompt.
      if (checkpoint.userKey.startsWith('id:')) return -1;
    }
    const baseline = new Set(checkpoint.baselineKeys || []);
    for (let i=users.length-1;i>=0;i--) {
      if (!baseline.has(users[i].key) && normalize(users[i].text) === normalize(message)) return i;
    }
    return -1;
  }
  globalThis.JSCBridgeCore = Object.freeze({normalize,hash,mayComplete,locateUser});
})();
