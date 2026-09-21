/** Safe offline Markdown subset. All user/model strings become text nodes; never raw HTML. */
function math(parent,source,display=false){
  const el=document.createElement(display?'div':'span');el.className=display?'math math-block':'math';
  const text=String(source||'').replace(/\\(?:,|;|!)/g,' ').replace(/\\times/g,'×').replace(/\\cdot/g,'·').replace(/\\pm/g,'±').replace(/\\leq/g,'≤').replace(/\\geq/g,'≥').replace(/\\neq/g,'≠').replace(/\\infty/g,'∞').replace(/\\(?:mathrm|text)\{([^{}]*)\}/g,'$1');
  let pos=0,m,re=/([_^])(?:\{([^{}]+)\}|([^\s]))/g;
  while((m=re.exec(text))){el.append(document.createTextNode(text.slice(pos,m.index)));const script=document.createElement(m[1]==='^'?'sup':'sub');script.textContent=m[2]??m[3];el.append(script);pos=re.lastIndex;}el.append(document.createTextNode(text.slice(pos).replace(/[{}]/g,'')));parent.append(el);
}
export function inline(parent,text) {
  const re=/(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|\[([^\]\n]+)\]\(([^\s)]+)\)|(\\\(([^\n]+?)\\\))|(?<!\$)\$([^$\n]+)\$(?!\$)/g;let pos=0,m;
  while((m=re.exec(text))){parent.append(document.createTextNode(text.slice(pos,m.index)));let el;
    if(m[2]){el=document.createElement('strong');el.textContent=m[2];}
    else if(m[4]){el=document.createElement('code');el.textContent=m[4];}
    else if(m[8]||m[9]){math(parent,m[8]||m[9]);pos=re.lastIndex;continue;}
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
    const mathStart=line.match(/^\s*(?:\$\$|\\\[)(.*)$/);if(mathStart){let body=mathStart[1],closed=/(?:\$\$|\\\])\s*$/.test(body);body=body.replace(/(?:\$\$|\\\])\s*$/,'');i++;while(!closed&&i<lines.length){closed=/(?:\$\$|\\\])\s*$/.test(lines[i]);body+='\n'+lines[i++].replace(/(?:\$\$|\\\])\s*$/,'');}math(fragment,body.trim(),true);continue;}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){const el=document.createElement('h'+heading[1].length);inline(el,heading[2]);fragment.append(el);i++;continue;}
    if(/^\s*[-*]\s+/.test(line)){const ul=document.createElement('ul');while(i<lines.length&&/^\s*[-*]\s+/.test(lines[i])){const li=document.createElement('li');inline(li,lines[i++].replace(/^\s*[-*]\s+/,''));ul.append(li);}fragment.append(ul);continue;}
    if(/^\s*\d+[.)]\s+/.test(line)){const ol=document.createElement('ol');while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i])){const li=document.createElement('li');inline(li,lines[i++].replace(/^\s*\d+[.)]\s+/,''));ol.append(li);}fragment.append(ol);continue;}
    if(/^\s*>\s?/.test(line)){const quote=document.createElement('blockquote');while(i<lines.length&&/^\s*>\s?/.test(lines[i])){inline(quote,lines[i++].replace(/^\s*>\s?/,''));if(i<lines.length&&/^\s*>/.test(lines[i]))quote.append(document.createElement('br'));}fragment.append(quote);continue;}
    if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){fragment.append(document.createElement('hr'));i++;continue;}
    const p=document.createElement('p');inline(p,line);i++;while(i<lines.length&&lines[i].trim()&&!/^(?:\s*```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*>\s?|\s*(?:\$\$|\\\[))/.test(lines[i])){p.append(document.createElement('br'));inline(p,lines[i++]);}fragment.append(p);
  }target.replaceChildren(fragment);
}
