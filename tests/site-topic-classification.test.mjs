import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {classifySiteTopics,TOPIC_VERSION} from '../site-import/topic-classification.mjs';
import {articleTaxonomy,taxonomyFolder} from '../site-import/taxonomy.mjs';
import {normalizeSiteSource,runId,runPath} from '../site-import/store.mjs';
import {digest,writeJson} from '../subscription-workflow/config.mjs';
import {discoverSite} from '../site-import/discovery.mjs';
import {capturedArticle} from '../site-import/tasks.mjs';

async function fixture(){
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-topics-test-'),settings=normalizeSiteSource({url:'https://topics.example.invalid/',infer_topics:true}),id=runId('topics');
 const texts=['Prices change when supply and demand shift. The article examines market competition.','A compiler translates source programs into instructions. The article explains type checking.'];
 const articles=texts.map((text,index)=>({url:settings.url+'article-'+index,title:index?'Programming languages and compilers':'Prices and market competition',markdown_sha256:digest(text),taxonomy:articleTaxonomy(),taxonomy_evidence:[]}));
 for(const [index,article] of articles.entries())await writeJson(path.join(runPath(root,id),'sources',digest(article.url)+'.json'),{url:article.url,markdown:texts[index],metadata:{taxonomy:articleTaxonomy()}});
 articles.push({url:settings.url+'original',title:'Original source hierarchy',taxonomy:articleTaxonomy({categories:[['Economics']]})});
 return {root,settings,inventory:{complete:true,articles,article_source:{run_id:id}},texts};
}

test('source-grounded topic inference reuses a common folder and preserves original classifications and captures',async()=>{
 const f=await fixture(),original=structuredClone(f.inventory),calls=[];
 const producer=async(kind,input)=>{calls.push(kind);if(kind==='vocabulary')return {new_topics:[{name:'Computing',description:'Programming languages and computer software'}]};return {assignments:input.articles.map((item,index)=>({url:item.url,topic_id:input.topics.find(topic=>topic.name===(index?'Computing':'Economics')).id,reason:'The original passage directly discusses this subject.',evidence:[{field:'body',quote:item.excerpt.split('. ')[0]}]}))};};
 const result=await classifySiteTopics(f.root,f.settings,f.inventory,{producer});
 assert.equal(result.version,TOPIC_VERSION);assert.equal(result.classified,2);assert.deepEqual(result.unresolved,[]);
 assert.equal(taxonomyFolder('Site',f.inventory.articles[0].taxonomy),'Site/分类/Economics');assert.equal(f.inventory.articles[0].taxonomy.primary.inferred,true);
 assert.deepEqual(f.inventory.articles[2],original.articles[2]);
 for(const [index,article] of original.articles.slice(0,2).entries()){const capture=JSON.parse(await fs.readFile(path.join(runPath(f.root,original.article_source.run_id),'sources',digest(article.url)+'.json'),'utf8'));assert.equal(capture.markdown,f.texts[index]);assert.equal(capture.metadata.taxonomy.groups.length,0);}
 await classifySiteTopics(f.root,f.settings,original,{producer});assert.deepEqual(calls,['vocabulary','assign']);
 await assert.rejects(fs.access(path.join(f.root,'阅读区')),error=>error.code==='ENOENT');
});

test('invalid classification evidence is retried from original input and never accepted as a partial reply',async()=>{
 const f=await fixture();let attempts=0;
 const producer=async(kind,input)=>{if(kind==='vocabulary')return {new_topics:[]};attempts++;if(attempts>1)assert(input.validation_feedback.length);
  return {assignments:input.articles.map(item=>({url:item.url,topic_id:input.topics[0].id,reason:'The supplied source provides the classification evidence.',evidence:[{field:'body',quote:'This sentence was fabricated and is absent from the input.'}]}))};};
 await assert.rejects(classifySiteTopics(f.root,f.settings,f.inventory,{producer}),/来源核验/u);assert.equal(attempts,3);assert.equal(f.inventory.articles[0].taxonomy.groups.length,0);
 const recovered=await classifySiteTopics(f.root,f.settings,f.inventory,{producer:async(kind,input)=>({assignments:input.articles.map(item=>({url:item.url,topic_id:null,reason:'The available excerpt is insufficient for a reliable decision.',evidence:[]}))})});
 assert.equal(recovered.classified,0);assert.equal(recovered.unresolved.length,2);
});

test('opt-in discovery passes content topics to individual publications before whole-site verification',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/site-topics-discovery-'),base='https://topic-discovery.example.invalid',settings=normalizeSiteSource({url:base,infer_topics:true});
 const fetchPage=async url=>{const p=new URL(url).pathname,body=p==='/'?'<article><h1><a href="/first/">First</a></h1></article>':p==='/robots.txt'?'':p==='/sitemap.xml'?'<urlset/>':'<title>Market competition</title><article><h1>Market competition</h1><p>'+('Prices change with supply and demand. '.repeat(20))+'</p></article>';return {url,body,sha256:digest(body)};};
 const topicProducer=async(kind,input)=>kind==='vocabulary'?{new_topics:[{name:'Economics',description:'Markets, prices, supply and demand'}]}:{assignments:input.articles.map(item=>({url:item.url,topic_id:input.topics[0].id,reason:'The source discusses market prices and competition.',evidence:[{field:'body',quote:item.excerpt.slice(0,40)}]}))};
 const inventory=await discoverSite(root,settings,runId('topic-discovery'),{fetchPage,topicProducer,planner:async()=>({plan:{include_paths:['/*'],exclude_paths:[],listing:{type:'html',url:base+'/',item_selector:'article h1 a'}},producer:{provider:'fixture'}})});
 assert.equal(inventory.topic_classification.classified,1);
 assert.equal(taxonomyFolder('Site',(await capturedArticle(root,inventory.article_source,inventory.articles[0].url)).metadata.taxonomy),'Site/分类/Economics');
});
