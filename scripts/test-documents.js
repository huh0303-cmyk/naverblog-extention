// Local OCR and upstream HWP/HWPX fixtures. No model calls or publication.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {readSourceDocument}=require('../src/lib/sourceDocument');
const {fetchCandidateContent}=require('../src/lib/search')._private;
const root=path.resolve(__dirname,'../.test-runtime/document-fixtures');fs.mkdirSync(root,{recursive:true});
function scanPdf(){
  const canvas=createCanvas(1400,800),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1400,800);ctx.fillStyle='black';ctx.font='bold 52px "Malgun Gothic", sans-serif';
  ['소상공인 지원 안내','신청 기간 2026년 9월 21일','지원 대상 사업자 확인','신청 금액 1000000원','Application deadline 2026-09-21'].forEach((s,i)=>ctx.fillText(s,70,110+i*120));
  const jpg=canvas.toBuffer('image/jpeg');
  const drawing='q 560 0 0 320 0 0 cm /Im0 Do Q';
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 560 320] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),jpg,Buffer.from('\nendstream')]),Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`)];
  const parts=[Buffer.from('%PDF-1.4\n')],offsets=[];let length=parts[0].length;
  objects.forEach((object,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;});
  parts.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));return Buffer.concat(parts);
}
async function main(){
  fs.writeFileSync(path.join(root,'scan.pdf'),scanPdf());
  for(const name of ['example.hwp','example.hwpx'])if(!fs.existsSync(path.join(root,name))){
    const response=await fetch('https://raw.githubusercontent.com/ohah/hwpjs/main/legacy/rust/crates/hwp-core/tests/fixtures/'+name);
    assert.ok(response.ok);fs.writeFileSync(path.join(root,name),Buffer.from(await response.arrayBuffer()));
  }
  const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').searchParams.get('name');if(!['scan.pdf','example.hwp','example.hwpx'].includes(name)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/octet-stream'});res.end(fs.readFileSync(path.join(root,name)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/download?name=`;const results=[];
  try {
    for(const name of ['scan.pdf','example.hwp','example.hwpx']){
      const r=await readSourceDocument(base+name,{onProgress:message=>console.log(message)});
      if(name==='scan.pdf'){assert.ok(r.ocrPages.length);assert.match(r.text,/소상공인/);assert.match(r.text,/2026/);assert.match(r.text,/1000000/);}
      else{assert.match(r.text,/삼강오륜/);assert.match(r.text,/붕우유신/);}
      results.push({name,format:r.format,text:r.text,note:r.extractionNote});console.log(name+' PASS · '+r.text.length+' chars');
    }
    const evidence=await fetchCandidateContent({url:base+'example.hwp',title:'HWP fixture'},{searchQueries:['삼강오륜']});assert.match(evidence.excerpt,/삼강오륜/);
    fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../artifacts/document-validation.json'),JSON.stringify(results,null,2));
  }finally{await new Promise(r=>server.close(r));}
}
main().then(()=>{if(process.versions.electron)require('electron').app.exit(0);},error=>{console.error(error);if(process.versions.electron)require('electron').app.exit(1);else process.exitCode=1;});
