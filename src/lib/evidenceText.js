function canonicalUrl(value) {
  try {
    const url=new URL(value);url.hash='';
    for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid|from|trackingCode)$/i.test(key))url.searchParams.delete(key);
    if(/^(m\.)?blog\.naver\.com$/.test(url.hostname)){
      url.hostname='blog.naver.com';
      if(url.searchParams.get('blogId') && url.searchParams.get('logNo'))return `https://blog.naver.com/${url.searchParams.get('blogId')}/${url.searchParams.get('logNo')}`;
    }
    url.searchParams.sort();return url.toString();
  }catch{return String(value || '');}
}
function navigationOnly(value) {
  try {
    const u=new URL(value);
    return /^(dict|ko.dict|en.dict)\.naver\.com$/.test(u.hostname) || /(^|\.)creativecommons\.org$/.test(u.hostname)
      || (/^(m\.)?blog\.naver\.com$/.test(u.hostname) && /^\/[^/]+\/?$/.test(u.pathname) && !u.searchParams.get('logNo'))
      || (/\.tistory\.com$/.test(u.hostname) && u.pathname==='/');
  }catch{return true;}
}
// Retrieval windows only; the agent decides whether text supports any claim.
function evidenceExcerpt(text,query='',limit=3000,anchors=[]) {
  const located=locatedExcerpt(text,anchors,limit);if(located)return located;
  text=String(text || '').replace(/\s+/g,' ').trim();if(text.length<=limit)return text;
  const terms=[...new Set(String(query).match(/[가-힣A-Za-z0-9]{2,}/g)||[])].slice(0,50);
  const chunks=[];for(let start=0;start<text.length;start+=600){const part=text.slice(start,start+900);chunks.push({start,end:Math.min(text.length,start+900),score:terms.reduce((n,t)=>n+Number(part.toLowerCase().includes(t.toLowerCase())),0)});}
  const chosen=[{start:0,end:500}],ordered=chunks.sort((a,b)=>b.score-a.score||a.start-b.start);
  let used=500;for(const c of ordered){if(!c.score || chosen.some(p=>c.start<p.end && c.end>p.start))continue;if(used+c.end-c.start+20>limit)continue;chosen.push(c);used+=c.end-c.start+20;}
  return chosen.sort((a,b)=>a.start-b.start).map(c=>text.slice(c.start,c.end)).join('\n[중간 생략]\n');
}
// Literal positions chosen by the agent, independent of topic or document genre.
// Missing/ambiguous positions never count as located evidence.
function locatedExcerpt(value,anchors,limit=3000){
  if(!Array.isArray(anchors)||!anchors.length||anchors.length>6)return null;
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim(),text=normalize(value),ranges=[];
  for(const anchor of anchors){
    const startText=normalize(anchor?.start),endText=normalize(anchor?.end);
    if(!startText)return null;
    const start=text.indexOf(startText);
    if(start<0||text.indexOf(startText,start+1)>=0)return null;
    const end=endText?text.indexOf(endText,start+startText.length):Math.min(text.length,start+1200);
    if(end<0)return null;
    ranges.push({start,end});
  }
  const distinct=[...new Map(ranges.map(r=>[r.start+':'+r.end,r])).values()].sort((a,b)=>a.start-b.start);
  const separator='\n[중간 생략]\n',note='\n[부분 발췌: 앞뒤 조건과 생략 범위는 원문에 있을 수 있음]';
  let remaining=limit-note.length-separator.length*(distinct.length-1);
  if(remaining<distinct.length)return null;
  return distinct.map((r,i)=>{const size=Math.min(r.end-r.start,Math.floor(remaining/(distinct.length-i)));remaining-=size;return text.slice(r.start,r.start+size);}).join(separator)+note;
}
async function cachedEvidence(request,context){
  if(!request?.sourceUrl || !context?.documents)return [];
  for(const value of context.documents.values()){
    let source;try{source=await value;}catch{continue;}
    if(!source?.fullText || canonicalUrl(source.url)!==canonicalUrl(request.sourceUrl))continue;
    const excerpt=locatedExcerpt(source.fullText,request.anchors);if(!excerpt)return [];
    const {fullText,...metadata}=source;
    return [{...metadata,excerpt,extractionNote:[source.extractionNote,'에이전트가 지정한 문서·위치의 부분 발췌입니다. 위치 일치는 신뢰성·주장의 입증을 의미하지 않습니다.'].filter(Boolean).join(' ')}];
  }
  return [];
}
module.exports={canonicalUrl,navigationOnly,evidenceExcerpt,locatedExcerpt,cachedEvidence};
