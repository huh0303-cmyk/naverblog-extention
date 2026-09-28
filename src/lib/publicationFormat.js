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
    article:typeof writer.article==='string' ? writer.article.replace(/https?:\/\/[^\s<>"\[\]]+/g,match=>{
      const suffix=match.match(/[).,;!?]+$/)?.[0] || '';
      return cleanSourceUrl(suffix ? match.slice(0,-suffix.length) : match)+suffix;
    }) : writer.article,
    ...(Array.isArray(writer.citations)?{citations:writer.citations.map(c=>({...c,url:cleanSourceUrl(c.url)}))}:{})
  };
}
function referenceParts(article) {
  const text=String(article || '');
  const headings=[...text.matchAll(/^\[SECTION\s*-\s*참고자료\]\s*$/gm)];
  const heading=headings[0];
  return {body:heading?text.slice(0,heading.index):text,
    references:heading?text.slice(heading.index+heading[0].length):'',count:headings.length};
}
module.exports={cleanSourceUrl,cleanPublicationUrls,referenceParts};
