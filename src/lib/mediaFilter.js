function isVideoUrl(value) {
  try {
    const url=new URL(value);
    const extensions=/\.(?:mp4|m4v|mov|avi|wmv|webm|mkv|mpeg|mpg|flv|m3u8|ts)(?:$|[?#])/i;
    if(extensions.test(decodeURIComponent(url.pathname)))return true;
    for(const [key,val] of url.searchParams){
      if(/^(file_ext|ext|extension|format)$/i.test(key) && /^(mp4|m4v|mov|avi|wmv|webm|mkv|mpeg|mpg|flv|m3u8|ts)$/i.test(val.replace(/^\./,'')))return true;
      if(extensions.test(val))return true;
    }
    return false;
  }catch{return false;}
}
module.exports={isVideoUrl};
