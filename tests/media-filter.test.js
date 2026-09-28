const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {isVideoUrl}=require('../src/lib/mediaFilter');
const {readSourceDocument}=require('../src/lib/sourceDocument');
test('video links excluded, PDF and HWP retained',()=>{
  for(const url of ['https://x/a.mp4','https://x/download?file_ext=MP4','https://x/download?filename=a.webm'])assert.equal(isVideoUrl(url),true);
  for(const url of ['https://x/a.pdf','https://x/download?file_ext=hwp','https://x/article'])assert.equal(isVideoUrl(url),false);
});
test('known video rejected before network; unknown video rejected at headers',async()=>{
  await assert.rejects(readSourceDocument('http://127.0.0.1:1/a.mp4'),{code:'VIDEO_EXCLUDED'});
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/mp4'});res.end('video');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await assert.rejects(readSourceDocument(`http://127.0.0.1:${server.address().port}/download`),{code:'VIDEO_EXCLUDED'});}
  finally{await new Promise(r=>server.close(r));}
});
