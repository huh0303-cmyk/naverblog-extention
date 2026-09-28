// Explicit manual smoke test: opens the user's installed Chrome, never publishes.
if(!process.env.BLOGAUTO_TEST_BLOG_ID)throw new Error('Set BLOGAUTO_TEST_BLOG_ID to the blog ID to test.');
process.env.BLOGAUTO_AUTOSTART='0';process.env.BLOGAUTO_SKIP_CODEX_USAGE_REFRESH='1';
const {app}=require('electron');
app.on('web-contents-created',(_event,contents)=>contents.once('did-finish-load',async()=>{
 try{
  await new Promise(resolve=>setTimeout(resolve,600));
  await contents.executeJavaScript(`(async()=>{
   document.querySelector('#startupNotice').hidden=true;
   await window.blogAuto.prepareExtension();
   const store=await window.blogAuto.getConnections();
   const account=store.accounts.find(a=>a.blogId===${JSON.stringify(process.env.BLOGAUTO_TEST_BLOG_ID)});
   await window.blogAuto.openAccountChrome(account.id);
   await connectAccount(account);
  })()`);
 }catch(error){console.error(error);}
}));
require('./dev-app');
