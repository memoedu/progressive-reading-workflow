export function mountCandidates(doc=globalThis.document,{fetchImpl=globalThis.fetch}={}){
 let state={revision:0,items:[]},busy=false,page=0;
 const byId=id=>doc.getElementById(id),message=byId('candidate-message');
 const element=(tag,text,className)=>{const node=doc.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
 async function request(url,options){const response=await fetchImpl(url,options);const value=await response.json();if(!response.ok)throw Error(value.error||'请求失败');return value;}
 function render(){
  const filter=byId('candidate-filter').value,search=byId('candidate-search').value.trim().toLocaleLowerCase();
  const items=state.items.filter(item=>(filter==='all'||item.status===filter)&&(!search||[item.title,item.author,...item.sources.map(s=>s.heading+' '+s.source_url)].join(' ').toLocaleLowerCase().includes(search))),list=byId('candidate-items');list.replaceChildren();
  const pages=Math.max(1,Math.ceil(items.length/50));page=Math.min(page,pages-1);
  byId('candidate-page').textContent=`第 ${page+1} / ${pages} 页`;byId('candidate-previous').disabled=page===0;byId('candidate-next').disabled=page>=pages-1;
  message.textContent=items.length?`${items.length} 项 · 未导入正文`:'当前没有此类候选。';
  for(const item of items.slice(page*50,(page+1)*50)){
   const card=element('article',null,'section candidate-item'),title=element('h3',item.title),kind=element('p','书籍 · '+(item.status==='dismissed'?'已忽略':'待选择'),'hint');
   const link=element('a','查看书籍来源');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';
   card.append(title,kind);if(item.author)card.append(element('p',item.author));card.append(element('p',item.url,'hint'),element('p',item.reason,'hint'),link);
   const origins=element('ul');for(const source of item.sources){const li=element('li'),a=element('a',source.heading+' · '+new URL(source.source_url).hostname);a.href=source.source_url;a.target='_blank';a.rel='noopener noreferrer';li.append(a);origins.append(li);}card.append(origins);
   const button=element('button',item.status==='dismissed'?'恢复到待选择':'忽略此项','secondary');button.type='button';button.disabled=busy;
   button.addEventListener('click',async()=>{
    if(busy)return;busy=true;button.disabled=true;
    try{state=await request('/api/import-candidates/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,status:item.status==='dismissed'?'pending':'dismissed',revision:state.revision})});busy=false;render();}
    catch(error){message.textContent=error.message;}
    finally{busy=false;button.disabled=false;}
   });card.append(button);list.append(card);
  }
 }
 async function refresh(){try{state=await request('/api/import-candidates');render();}catch(error){message.textContent=error.message;}}
 const reset=()=>{page=0;render();};
 byId('candidate-refresh').addEventListener('click',refresh);byId('candidate-filter').addEventListener('change',reset);byId('candidate-search').addEventListener('input',reset);
 byId('candidate-previous').addEventListener('click',()=>{page--;render();});byId('candidate-next').addEventListener('click',()=>{page++;render();});
 void refresh();return {refresh};
}
if(typeof document!=='undefined')mountCandidates();
