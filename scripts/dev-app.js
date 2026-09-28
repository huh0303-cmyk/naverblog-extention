// Development state stays in this checkout; packaged releases use OS app data.
const path=require('node:path');
process.env.BLOGAUTO_RUNTIME_ROOT ||= path.resolve(__dirname,'../runtime');
process.env.BLOGAUTO_USER_DATA ||= path.join(process.env.BLOGAUTO_RUNTIME_ROOT,'app-data');
if(process.env.BLOGAUTO_TEST_BLOG_ID){
 const {writeAccountStore,readAccountStore}=require('../src/lib/accountStore');
 const blogId=process.env.BLOGAUTO_TEST_BLOG_ID;const store=readAccountStore(process.env.BLOGAUTO_RUNTIME_ROOT,{});
 if(!store.accounts.some(a=>a.blogId===blogId)){store.accounts.push({id:`manual-test-${blogId}`,label:blogId,blogId,categories:[]});store.selectedAccountId=`manual-test-${blogId}`;writeAccountStore(process.env.BLOGAUTO_RUNTIME_ROOT,store);}
}
if(process.env.BLOGAUTO_TISTORY_E2E==='1')require('./manual-tistory-test');
if(process.env.BLOGAUTO_RESUME_E2E==='1')require('./manual-resume-test');
require('../src/main');
