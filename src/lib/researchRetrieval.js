const {collectSearchResults,createRetrievalContext}=require('./search');
const {canonicalUrl,cachedEvidence}=require('./evidenceText');
// The agent selects claims/queries. Core only enforces scope, budgets and deduplication.
async function retrieveResearch(options,log=()=>{},dependencies={}) {
  const context=dependencies.context || createRetrievalContext();
  const fetchSources=dependencies.collect || collectSearchResults;
  const discovery=[...new Set((options.searchQueries || []).map(q=>String(q).trim()).filter(Boolean))].slice(0,4);
  const verification=options.trustBlogAsSource===true?[]:[...new Set((options.verificationQueries || []).map(q=>String(q).trim()).filter(Boolean))].slice(0,2);
  let base=[]; // Reserve the shared budget for essential verification first.
  // A source-less blog is still usable discovery material. Verification is targeted
  // at requested claims, not a second general exploration or a domain-based verdict.
  let checked=[];
  if(verification.length){
    log('공식 원문 검증: '+verification.join(' / ')+' · 주제 탐색 탭은 '+options.searchChannel+' 유지');
    const missing=[],reusedRequests=new Map();
    for(const query of verification){
      const request=(options.evidenceRequests || []).find(r=>r?.query===query);
      const reused=await cachedEvidence(request,context);
      if(reused.length){const key=canonicalUrl(reused[0].url);const group=reusedRequests.get(key)||{sourceUrl:request.sourceUrl,anchors:[],queries:[]};group.anchors.push(...request.anchors);group.queries.push(query);reusedRequests.set(key,group);}
      else missing.push(query);
    }
    for(const request of reusedRequests.values()){
      request.anchors=[...new Map(request.anchors.map(a=>[JSON.stringify(a),a])).values()];
      const reused=await cachedEvidence(request,context);
      if(reused.length){checked.push(...reused);log('확보한 원문의 지정 위치 재사용: '+request.queries.join(' / '));}
      else missing.push(...request.queries);
    }
    if(missing.length)checked.push(...await fetchSources({...options,searchChannel:'web',searchNeed:'strict',retrievalStage:'verification',maxStageDocuments:16,maxCandidates:10,searchQueries:missing},log,{...dependencies,context}));
  }
  if(discovery.length)base=await fetchSources({...options,retrievalStage:'discovery',maxStageDocuments:8,maxCandidates:6,searchQueries:discovery},log,{...dependencies,context});
  // A failed guessed site restriction is a retrieval problem, not grounds for
  // another paid planning call. One bounded host-free retry per job is allowed.
  if(verification.length && !checked.length && !context.verificationRescueUsed){
    const restricted=verification.find(q=>/site:/i.test(q));
    const retry=restricted?.replace(/site:[a-z0-9.-]+/gi,'').replace(/\bOR\b/g,'').replace(/\s+/g,' ').trim();
    if(retry){context.verificationRescueUsed=true;log('지정 기관 검색에서 원문을 찾지 못해 동일 주제의 기관 제한만 한 번 해제합니다.');checked=await fetchSources({...options,searchChannel:'web',searchNeed:'strict',retrievalStage:'verification',maxStageDocuments:8,maxCandidates:6,searchQueries:[retry]},log,{...dependencies,context});}
  }
  const seen=new Set();
  return [...checked,...base].filter(s=>{const key=canonicalUrl(s.url);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,20);
}
module.exports={retrieveResearch};
