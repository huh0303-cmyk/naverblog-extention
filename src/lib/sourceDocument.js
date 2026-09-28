const http=require('node:http'),https=require('node:https');
async function fetchDocument(url,redirects=0) {
  if(require('./mediaFilter').isVideoUrl(url))throw Object.assign(new Error('동영상 첨부는 원문 분석 대상에서 제외합니다.'),{code:'VIDEO_EXCLUDED'});
  if(redirects>5)throw new Error('원문 리디렉션 한도 초과');
  return new Promise((resolve,reject)=>{
    const request=(url.startsWith('http:')?http:https).get(url,{timeout:15000,headers:{'user-agent':'Mozilla/5.0','accept-language':'ko,en;q=0.8'}},response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();fetchDocument(new URL(response.headers.location,url).href,redirects+1).then(resolve,reject);return;}
      if(response.statusCode!==200){response.resume();reject(new Error(`원문 HTTP ${response.statusCode}`));return;}
      if(/^video\//i.test(response.headers['content-type'] || '') || /\.(mp4|m4v|mov|avi|wmv|webm|mkv|mpeg|mpg|flv|m3u8)(?:["';\s]|$)/i.test(response.headers['content-disposition'] || '')){
        response.destroy();reject(Object.assign(new Error('동영상 첨부는 원문 분석 대상에서 제외합니다.'),{code:'VIDEO_EXCLUDED'}));return;
      }
      const chunks=[];let length=0;
      response.on('error',reject);response.on('data',chunk=>{length+=chunk.length;if(length>48*1024*1024){response.destroy(new Error('개별 원문 다운로드 48MB 제한 (토큰 한도와 별개)'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({data:Buffer.concat(chunks),url,type:String(response.headers['content-type'] || '')}));
    });request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('원문 요청 시간 초과')));
  });
}
function lawBodyUrl(html,url) {
  const base=new URL(url);
  if(!/(^|\.)law\.go\.kr$/.test(base.hostname))return '';
  const frame=String(html).match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i);
  if(frame){const target=new URL(frame[1].replace(/&amp;/g,'&'),base);if(target.origin===base.origin && /\/lsInfoP\.do$/i.test(target.pathname))return target.href;}
  if(/\/lsInfoP\.do$/i.test(base.pathname) && /^\d+$/.test(base.searchParams.get('lsiSeq') || '')){
    base.pathname=base.pathname.replace(/lsInfoP\.do$/i,'lsInfoR.do');return base.href;
  }
  return '';
}
async function readSourceDocument(url,options={}) {
  let doc=await fetchDocument(url);
  for(let depth=0;depth<2;depth++){
    const bodyUrl=lawBodyUrl(doc.data.toString('utf8'),doc.url);
    if(!bodyUrl)break;
    doc=await fetchDocument(bodyUrl);
  }
  const magic=doc.data.subarray(0,8).toString('hex');
  const format=doc.data.subarray(0,5).toString()==='%PDF-'?'pdf':magic==='d0cf11e0a1b11ae1'?'hwp':doc.data.subarray(0,2).toString()==='PK'?'hwpx':null;
  if(format){
    const result=await require('./documentProcess').extractInProcess(doc.data,format,options.onProgress,{maxPages:options.maxPages,maxOcrPages:options.maxOcrPages});
    return {...result,url:doc.url};
  }
  if(/hwp|pdf|octet-stream|msword/.test(doc.type))throw new Error('첨부파일의 문서 형식을 확인할 수 없습니다. 암호·손상 여부 또는 원문 링크를 확인하세요.');
  return {url:doc.url,html:doc.data.toString('utf8'),pdf:false};
}
module.exports={readSourceDocument,lawBodyUrl};
