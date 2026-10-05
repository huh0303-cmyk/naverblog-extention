const {referenceParts}=require('./publicationFormat');
const MIN_ARTICLE_CHARACTERS=1800;
const MAX_ARTICLE_CHARACTERS=3000;
function articleCharacterCount(article) {
  const body=referenceParts(article).body
    .replace(/^\[SECTION\s*-\s*(.+?)\]\s*$/gm,'$1')
    .replace(/\[IMAGE INSERT[^\]]*\]/g,'')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g,'$1')
    .replace(/\s/gu,'');
  return [...body].length;
}
function articleLengthIssue(writer) {
  const count=articleCharacterCount(writer?.article);
  if(count>=MIN_ARTICLE_CHARACTERS && count<=MAX_ARTICLE_CHARACTERS)return '';
  return `본문 분량은 공백 제외 ${MIN_ARTICLE_CHARACTERS}~${MAX_ARTICLE_CHARACTERS}자여야 합니다. 현재 ${count}자입니다. 제목·참고자료·이미지 표식·링크 주소는 제외하고 소제목과 링크 표시 문구는 포함합니다. ${count<MIN_ARTICLE_CHARACTERS?'기존 근거 안에서 조건·이유·비교·절차를 구체적으로 설명하여 보완하세요. 사실을 창작하거나 같은 내용을 반복하지 마세요.':'핵심 사실·조건·예외는 보존하고 반복과 군더더기를 줄이세요.'}`;
}
const articleLengthInstruction=`본문은 반드시 공백 제외 ${MIN_ARTICLE_CHARACTERS}~${MAX_ARTICLE_CHARACTERS}자로 작성한다. 제목·참고자료·이미지 표식·링크 주소는 제외하고 소제목과 링크 표시 문구는 포함한다. 분량은 필수 조건이다. 근거가 있는 조건·이유·비교·절차를 충분히 설명하되 반복·허구로 분량을 채우지 않는다. 앱이 실제 글자수를 검증한다.`;
module.exports={articleCharacterCount,articleLengthIssue,articleLengthInstruction};
