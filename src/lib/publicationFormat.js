// Mechanical publication formatting only. Agents retain factual/style decisions.
function cleanSourceUrl(value) {
  const original=String(value || '');
  try {
    const url=new URL(original);
    if(!['http:','https:'].includes(url.protocol))return original;
    let changed=false;
    for(const key of [...url.searchParams.keys()]) {
      if(/^utm_|^(?:fbclid|gclid|dclid|msclkid)$/i.test(key)) {
        url.searchParams.delete(key);changed=true;
      }
    }
    return changed ? url.toString() : original;
  } catch { return original; }
}
function cleanPublicationUrls(writer) {
  if(!writer || typeof writer!=='object')return writer;
  return {...writer,
    article:typeof writer.article==='string' ? omitBlogReferences(writer.article,writer.citations).replace(/https?:\/\/[^\s<>"\[\]]+/g,match=>{
      const suffix=match.match(/[).,;!?]+$/)?.[0] || '';
      return cleanSourceUrl(suffix ? match.slice(0,-suffix.length) : match)+suffix;
    }) : writer.article,
    ...(Array.isArray(writer.citations)?{citations:writer.citations.map(c=>({...c,url:cleanSourceUrl(c.url)}))}:{})
  };
}
function isBlogCitation(citation) {
  if(citation?.sourceKind==='blog')return true;
  try{const host=new URL(citation?.url).hostname.toLowerCase();return /(^|\.)(blog\.naver\.com|tistory\.com|blogspot\.com|wordpress\.com|velog\.io|brunch\.co\.kr)$/.test(host);}catch{return false;}
}
function omitBlogReferences(article,citations=[]) {
  const parts=referenceParts(article);
  if(parts.count!==1)return article;
  const hidden=new Set((citations || []).filter(isBlogCitation).map(c=>cleanSourceUrl(c.url)));
  const entries=parts.references.trim().split(/(?=^참고\s*\d+\s*[:：])/m).filter(s=>s.trim());
  const kept=entries.filter(entry=>{
    const urls=entry.match(/https?:\/\/[^\s<>"\[\]]+/g) || [];
    return !urls.some(url=>hidden.has(cleanSourceUrl(url)) || isBlogCitation({url}));
  });
  if(kept.length===entries.length)return article;
  return parts.body.trimEnd()+(kept.length?'\n\n[SECTION - 참고자료]\n'+kept.map((s,i)=>s.trim().replace(/^참고\s*\d+\s*[:：]/,'참고 '+(i+1)+':')).join('\n\n'):'');
}
function referenceParts(article) {
  const text=String(article || '');
  const headings=[...text.matchAll(/^\[SECTION\s*-\s*참고자료\]\s*$/gm)];
  const heading=headings[0];
  return {body:heading?text.slice(0,heading.index):text,
    references:heading?text.slice(heading.index+heading[0].length):'',count:headings.length};
}
module.exports={cleanSourceUrl,cleanPublicationUrls,referenceParts,isBlogCitation};
