const test=require('node:test'),assert=require('node:assert/strict');
const {articlePlan}=require('../extension/article-plan');
test('legacy trailing images move below their own heading without losing any text',()=>{
 const plan=articlePlan('도입\n[SECTION - 첫째]\n첫 본문\n[IMAGE INSERT - 1]\n추가 본문\n[SECTION - 둘째]\n둘째 본문\n[IMAGE INSERT - 2]\n[SECTION - 참고자료]\n출처 주소');
 assert.deepEqual(plan.map(b=>b.type),['paragraph','section','image','paragraph','paragraph','section','image','paragraph','section','paragraph']);
 assert.deepEqual(plan.filter(b=>b.type==='paragraph').map(b=>b.text),['도입','첫 본문','추가 본문','둘째 본문','출처 주소']);
 assert.ok(plan.filter(b=>b.type==='section').every(b=>b.style==='quotation_line'));
});
test('correct placement is unchanged; multiple images and sections without images are preserved',()=>{
 const plan=articlePlan('[SECTION - 제목]\n[IMAGE INSERT - 1]\n[IMAGE INSERT - 2]\n본문\n[SECTION - 마지막]\n마지막 본문');
 assert.deepEqual(plan.map(b=>b.type),['section','image','image','paragraph','section','paragraph']);
 assert.deepEqual(plan.filter(b=>b.type==='image').map(b=>b.sequence),[1,2]);
});
