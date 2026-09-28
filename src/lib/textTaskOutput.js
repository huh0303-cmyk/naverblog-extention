// Text stages need one final JSON response, not model-driven filesystem work.
const isTextStage=agent=>['research','writer','humanizer','main'].includes(agent);
function responsePrompt(prompt){
  return String(prompt)
    .replace(/^Output JSON file:.*$/gm,'Return the result as a JSON object in your final response.')
    .replace(/Print BLOGAUTO_RESULT_READY only when the JSON file has been saved\./g,'')
    .replace(/Print BLOGAUTO_RESULT_READY after saving the file\./g,'')
    .replace(/Save the JSON file, then print BLOGAUTO_RESULT_READY\./g,'')
    +'\nThe application saves your final JSON automatically. Return JSON only, without Markdown fences or a completion marker. All inputs are supplied above: do not use tools, browse, inspect files, write files, or delegate. Assess and compose directly in this response.';
}
module.exports={isTextStage,responsePrompt};
