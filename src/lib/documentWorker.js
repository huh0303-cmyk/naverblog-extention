const {extractDocument}=require('./documentExtract');
process.once('message',async({data,format,limits})=>{
  try{const result=await extractDocument(Buffer.from(data),format,message=>process.send?.({progress:message}),limits);process.send({result},()=>process.exit(0));}
  catch(error){process.send({error:error.message},()=>process.exit(1));}
});
