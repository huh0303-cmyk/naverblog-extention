// Account identity survives a blog URL rename. Meaning is judged by Research.
function accountHistory(history,{accountId,blogId}) {
  return history.filter(entry=>entry.account_id && accountId ? entry.account_id===accountId : String(entry.blog_id || '')===blogId);
}
function publishedTopics(history) {
  const compact=(value,max)=>String(value || '').replace(/\s+/g,' ').trim().slice(0,max);
  const seen=new Set();
  return history.filter(e=>e.title && ['success','generated'].includes(e.status)).reverse()
    .sort((a,b)=>Date.parse(b.create_at)-Date.parse(a.create_at))
    .filter(e=>{const key=compact(e.title,300);if(seen.has(key))return false;seen.add(key);return true;})
    .reverse().map(e=>({
      id:e.id,title:compact(e.title,120),category:compact(e.category,50),
      ...(e.topic_thesis?{topicThesis:compact(e.topic_thesis,100)}:{}),...(e.reader_question?{readerQuestion:compact(e.reader_question,80)}:{})
    }));
}
module.exports={accountHistory,publishedTopics};
