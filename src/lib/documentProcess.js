const {fork}=require('node:child_process');const path=require('node:path');
let active=0;const queue=[];
async function extractInProcess(data,format,progress=()=>{},limits={}) {
  if(active>=2)await new Promise(resolve=>queue.push(resolve));else active++;
  try{return await new Promise((resolve,reject)=>{
    const child=fork(path.join(__dirname,'documentWorker.js'),[],{execPath:process.execPath,execArgv:[],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});
    let done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('문서 판독 180초 제한 초과. 다른 원문을 확보해야 합니다.')),180000);
    child.on('message',message=>{if(message.progress)progress(message.progress);else if(message.error)finish(new Error(message.error));else if(message.result)finish(null,message.result);});
    child.on('error',finish);child.on('exit',code=>{if(!done)finish(new Error(`문서 판독 프로세스 종료 (${code})`));});
    child.send({data,format,limits});
  });}finally{const next=queue.shift();if(next)next();else active--;}
}
module.exports={extractInProcess};
