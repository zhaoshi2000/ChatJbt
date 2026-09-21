/* Pure recovery/completion policy. Loaded before content.js; also exercised by Node tests. */
(() => {
  const normalize = text => String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
  const sameMessage = (left,right) => {
    const a=normalize(left).replace(/\s+/g,' '),b=normalize(right).replace(/\s+/g,' ');
    if(a===b)return true;
    return a.length>500&&b.length>500&&a.slice(0,120)===b.slice(0,120)&&a.slice(-120)===b.slice(-120);
  };
  const hash = text => { let n=2166136261; for (const ch of normalize(text)) n = Math.imul(n ^ ch.codePointAt(0),16777619); return (n>>>0).toString(16); };
  const ownsUnsentDraft = (draft, task, checkpoint={}) => {
    const phase=checkpoint.phase || '';
    return !task?.submitted && !['submitting','submitted','observing','finished'].includes(phase) && !!normalize(draft) && normalize(draft)===normalize(task?.message);
  };
  function mayComplete({text, hasMedia=false, busy, searching, completionAction, stableMs, settleMs = 8000}) {
    return (!!normalize(text)||hasMedia) && !busy && !searching && !!completionAction && stableMs >= settleMs;
  }
  function responseBusy({stop=false,searching=false,thinking=false,ariaBusy=false,mediaReady=false}) {
    return !!stop||!!searching||!!thinking||(!!ariaBusy&&!mediaReady);
  }
  function locateUser(users, checkpoint, message, allowNewest=false) {
    if (checkpoint.userKey) {
      const exact = users.findIndex(u => u.key === checkpoint.userKey && sameMessage(u.text,message));
      if (exact >= 0) return exact;
      // A stable server message id must not silently fall back to an unrelated duplicate prompt.
      if (checkpoint.userKey.startsWith('id:')) return -1;
    }
    const baseline = new Set(checkpoint.baselineKeys || []);
    for (let i=users.length-1;i>=0;i--) {
      if (!baseline.has(users[i].key) && sameMessage(users[i].text,message)) return i;
    }
    if(allowNewest&&users.length&&!baseline.has(users.at(-1).key))return users.length-1;
    return -1;
  }
  globalThis.JSCBridgeCore = Object.freeze({normalize,hash,ownsUnsentDraft,mayComplete,responseBusy,locateUser});
})();
