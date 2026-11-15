export function mountCandidates(doc=globalThis.document,{fetchImpl=globalThis.fetch}={}){
 let state={revision:0,items:[],total:0,page:0,pages:1},busy=false,page=0,sequence=0,searchTimer;
 const drafts=new Map(),byId=id=>doc.getElementById(id),message=byId('candidate-message');
 const element=(tag,text,className)=>{const node=doc.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
 async function request(url,options){const response=await fetchImpl(url,options);const value=await response.json();if(!response.ok)throw Error(value.error||'请求失败');return value;}
 function render(){
  const list=byId('candidate-items');list.replaceChildren();page=state.page||0;
  byId('candidate-page').textContent=`第 ${page+1} / ${state.pages||1} 页`;byId('candidate-previous').disabled=page===0;byId('candidate-next').disabled=page>=(state.pages||1)-1;
  message.textContent=state.total?`${state.total} 项 · 未导入正文`:'当前没有此类候选。';
  for(const item of state.items){
   const card=element('article',null,'section candidate-item'),title=element('h3',item.title),kind=element('p','书籍 · '+(item.status==='dismissed'?'已忽略':'待选择'),'hint');
   const link=element('a','查看书籍来源');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';
   card.append(title,kind);if(item.author)card.append(element('p',item.author));card.append(element('p',item.url,'hint'),link);
   for(const [key,label] of [['description','网站介绍'],['recommendation','网站书评与推荐说明']])if(item[key]){const details=element('details'),summary=element('summary',label),text=element('p',item[key],'candidate-note');details.append(summary,text);card.append(details);}
   const origins=element('ul');for(const source of item.sources){const li=element('li'),a=element('a',source.heading+' · '+new URL(source.source_url).hostname);a.href=source.source_url;a.target='_blank';a.rel='noopener noreferrer';li.append(a);origins.append(li);}card.append(origins);
   const label=element('label','导入理由'),reason=element('textarea');reason.id='reason-'+item.id;reason.rows=3;reason.maxLength=6000;reason.value=drafts.get(item.id)??item.import_reason??'';reason.placeholder='为什么想导入？打算解决什么问题？';label.htmlFor=reason.id;
   const actions=element('div',null,'actions'),save=element('button','保存导入理由','candidate-action'),toggle=element('button',item.status==='dismissed'?'恢复到待选择':'忽略此项','secondary candidate-action'),feedback=element('p','','hint');feedback.setAttribute('role','status');save.type=toggle.type='button';save.disabled=toggle.disabled=busy;
   reason.addEventListener('input',()=>{drafts.set(item.id,reason.value);feedback.textContent='导入理由尚未保存。';});
   async function update(patch){
    if(busy)return;busy=true;save.disabled=toggle.disabled=true;feedback.textContent='正在保存…';
    try{await request('/api/import-candidates/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,revision:state.revision,...patch})});if('import_reason' in patch)drafts.delete(item.id);await refresh();message.textContent='已保存。'+message.textContent;}
    catch(error){feedback.textContent=error.message;}
    finally{busy=false;for(const button of doc.querySelectorAll('.candidate-action'))button.disabled=false;}
   }
   save.addEventListener('click',()=>update({import_reason:reason.value}));toggle.addEventListener('click',()=>update({status:item.status==='dismissed'?'pending':'dismissed'}));
   actions.append(save,toggle);card.append(label,reason,feedback,actions);list.append(card);
  }
 }
 async function refresh(){const token=++sequence;try{const query=new URLSearchParams({status:byId('candidate-filter').value,q:byId('candidate-search').value.trim(),page:String(page)});const value=await request('/api/import-candidates?'+query);if(token===sequence){state=value;render();}}catch(error){if(token===sequence)message.textContent=error.message;}}
 const reset=()=>{page=0;void refresh();};
 byId('candidate-refresh').addEventListener('click',refresh);byId('candidate-filter').addEventListener('change',reset);byId('candidate-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(reset,250);});
 byId('candidate-previous').addEventListener('click',()=>{page--;void refresh();});byId('candidate-next').addEventListener('click',()=>{page++;void refresh();});
 void refresh();return {refresh};
}
if(typeof document!=='undefined')mountCandidates();
