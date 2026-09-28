const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

async function createOcr() {
  const folder=path.join(os.tmpdir(),'blogauto-ocr-models-v1');fs.mkdirSync(folder,{recursive:true});
  for(const lang of ['kor','eng']){
    const data=require('@tesseract.js-data/'+lang);
    const target=path.join(folder,lang+'.traineddata.gz');
    if(!fs.existsSync(target))fs.copyFileSync(path.join(data.langPath,lang+'.traineddata.gz'),target);
  }
  return require('tesseract.js').createWorker('eng+kor',1,{langPath:folder,cacheMethod:'none',gzip:true});
}
async function extractPdf(data,progress=()=>{},limits={}) {
  const maxPages=Math.min(80,Math.max(1,limits.maxPages || 80));
  const maxOcrPages=Math.min(20,Math.max(1,limits.maxOcrPages || 20));
  const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(data),useSystemFonts:true,isEvalSupported:false});
  let ocr;const texts=[],notes=[],ocrPages=[];let glyphs=0;
  try {
    const pdf=await task.promise;
    for(let number=1;number<=Math.min(pdf.numPages,maxPages);number++) {
      const page=await pdf.getPage(number),content=await page.getTextContent();
      let body=content.items.map(i=>i.str || '').join(' ').trim();
      const ops=await page.getOperatorList();
      const hasImage=ops.fnArray.some(fn=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(fn));
      if(hasImage || !body) {
        if(ocrPages.length>=maxOcrPages){notes.push(`${number}쪽: 문서당 OCR ${maxOcrPages}쪽 한도로 이미지 내용 미판독`);}
        else {
          progress(`PDF ${number}/${pdf.numPages}쪽 · 한국어 OCR`);
          ocr ||= await createOcr();
          const base=page.getViewport({scale:1});
          const scale=Math.min(2.5,Math.sqrt(12000000/(base.width*base.height)));
          const viewport=page.getViewport({scale});
          const canvas=require('@napi-rs/canvas').createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
          await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
          const result=await ocr.recognize(canvas.toBuffer('image/png'));
          ocrPages.push(number);
          if(result.data.text.trim()){
            body=body?`[텍스트층]\n${body}\n[이미지 포함 페이지 OCR]\n${result.data.text.trim()}`:result.data.text.trim();
            notes.push(`${number}쪽 OCR 신뢰도 ${Math.round(result.data.confidence)}% · 숫자/표/자격조건 오인식 가능`);
          }else notes.push(`${number}쪽 OCR에서 글자를 찾지 못함`);
          canvas.width=1;canvas.height=1;
        }
      }
      glyphs+=body.length;texts.push(`[${number}쪽]\n${body}`);page.cleanup();
    }
    if(!glyphs)throw new Error('PDF의 텍스트 추출 및 OCR 결과가 비어 있습니다.');
    if(pdf.numPages>maxPages)notes.push(`PDF 앞 ${maxPages}쪽만 판독 (전체 ${pdf.numPages}쪽)`);
    return {text:texts.join('\n'),format:'pdf',pdf:true,ocrPages,truncated:pdf.numPages>maxPages || notes.some(n=>n.includes('미판독')),extractionNote:notes.join('; ')};
  }finally{if(ocr)await ocr.terminate();await task.destroy();}
}
function extractHwpx(data) {
  const {unzipSync,strFromU8}=require('fflate');let size=0;
  const files=unzipSync(data,{filter:entry=>{
    if(!/^Contents\/section\d+\.xml$/i.test(entry.name))return false;
    size+=entry.originalSize;if(size>24*1024*1024)throw new Error('HWPX 본문 압축 해제 한도 초과');return true;
  }});
  const sections=Object.keys(files).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(!sections.length)throw new Error('HWPX 본문 section XML이 없습니다.');
  const parser=new(require('fast-xml-parser').XMLParser)({preserveOrder:true,ignoreAttributes:true,trimValues:false,parseTagValue:false});
  const walk=nodes=>nodes.map(node=>Object.entries(node).map(([key,value])=>{
    const name=key.split(':').at(-1);
    if(key==='#text')return String(value);
    if(!Array.isArray(value))return '';
    const body=walk(value);return body+(['p','tr'].includes(name)?'\n':name==='tc'?'\t':'');
  }).join('')).join('');
  const text=sections.map(name=>{const xml=strFromU8(files[name]);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('HWPX 사용자 정의 XML 엔터티는 처리하지 않습니다.');return walk(parser.parse(xml));}).join('\n').trim();
  if(!text)throw new Error('HWPX에서 판독 가능한 본문이 없습니다.');
  return {text,format:'hwpx',extractionNote:'HWPX XML 본문·표 셀 텍스트 추출. 삽입 이미지 내부 글자는 포함하지 않음.'};
}
function extractHwp(data) {
  const hwp=require('@ohah/hwpjs');
  const header=JSON.parse(hwp.fileHeader(data));
  if((header.document_flags || []).some(flag=>/encrypt|password|distribut/i.test(flag)))throw new Error('암호화·배포용 HWP는 판독하지 않습니다. 공개 PDF/HWPX 원문을 사용하세요.');
  const result=hwp.toMarkdown(data,{image:'blob',useHtml:false,includeVersion:false,includePageInfo:true});
  const text=result.markdown.replace(/^# HWP 문서\s*/,'').trim();if(!text)throw new Error('HWP에서 판독 가능한 본문이 없습니다.');
  return {text,format:'hwp',extractionNote:'HWP 본문·표를 Markdown으로 추출. 삽입 이미지 내부 글자는 포함하지 않음.'};
}
async function extractDocument(data,format,progress,limits) {
  if(format==='pdf')return extractPdf(data,progress,limits);
  if(format==='hwpx')return extractHwpx(data);
  if(format==='hwp')return extractHwp(data);
  throw new Error('지원하지 않는 문서 형식');
}
module.exports={extractDocument,createOcr};
