/** Small offline Markdown subset. All user/model strings become text nodes; never raw HTML. */
export function inline(parent,text) {
  const re=/(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|\[([^\]\n]+)\]\(([^\s)]+)\)/g;let pos=0,m;
  while((m=re.exec(text))){parent.append(document.createTextNode(text.slice(pos,m.index)));let el;
    if(m[2]){el=document.createElement('strong');el.textContent=m[2];}
    else if(m[4]){el=document.createElement('code');el.textContent=m[4];}
    else{let u;try{u=new URL(m[6]);}catch{}if(u&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password){el=document.createElement('a');el.href=u.href;el.rel='noopener noreferrer';el.target='_blank';el.textContent=m[5];}else el=document.createTextNode(m[0]);}
    parent.append(el);pos=re.lastIndex;
  }parent.append(document.createTextNode(text.slice(pos)));
}
export function renderMarkdown(target,text) {
  const fragment=document.createDocumentFragment(),lines=String(text||'').split('\n');let i=0;
  while(i<lines.length){const line=lines[i];
    if(/^\s*```/.test(line)){const pre=document.createElement('pre'),code=document.createElement('code'),button=document.createElement('button');let body=[];i++;while(i<lines.length&&!/^\s*```/.test(lines[i]))body.push(lines[i++]);i++;
      code.textContent=body.join('\n');button.type='button';button.className='copy-code';button.textContent='复制代码';button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';}catch{button.textContent='请手动选择复制';}});pre.append(button,code);fragment.append(pre);continue;}
    if(!line.trim()){i++;continue;}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){const el=document.createElement('h'+heading[1].length);inline(el,heading[2]);fragment.append(el);i++;continue;}
    if(/^\s*[-*]\s+/.test(line)){const ul=document.createElement('ul');while(i<lines.length&&/^\s*[-*]\s+/.test(lines[i])){const li=document.createElement('li');inline(li,lines[i++].replace(/^\s*[-*]\s+/,''));ul.append(li);}fragment.append(ul);continue;}
    const p=document.createElement('p');inline(p,line);i++;while(i<lines.length&&lines[i].trim()&&!/^(?:\s*```|#{1,4}\s|\s*[-*]\s)/.test(lines[i])){p.append(document.createElement('br'));inline(p,lines[i++]);}fragment.append(p);
  }target.replaceChildren(fragment);
}
