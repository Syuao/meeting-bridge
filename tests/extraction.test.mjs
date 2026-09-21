import test from 'node:test';
import assert from 'node:assert/strict';
import {extractQuestions} from '../host/questions.mjs';
import {QuestionStream} from '../host/question-stream.mjs';
import {CaptionTracker,parseCaptionLines} from '../host/captions.mjs';
import {validateQuestions,SemanticExtractor} from '../host/semantic.mjs';
const lines=(...values)=>values.map(text=>({text}));
const q=(text,ids=['s1'],complete=true)=>({source_ids:ids,quotes:[text],kind:'question',complete});

test('separates an explicit question from the following answer in one transcript',()=>{
  assert.deepEqual(extractQuestions('Why did you choose Redis? We chose Redis because it supports fast lookups.'),['Why did you choose Redis?']);
  assert.deepEqual(extractQuestions('Why? How so? 为什么？'),['Why?','How so?','为什么？']);
  assert.deepEqual(extractQuestions('I asked the customer what their goal was. We then redesigned the agreement.'),[]);
});
test('finished question emits during uninterrupted speech, incomplete question waits only for its continuation',()=>{
  const stream=new QuestionStream();
  assert.deepEqual(stream.push('How would you design a cache? I would start',{final:false}),['How would you design a cache?']);
  assert.deepEqual(stream.push('with the requirements. Then I would add metrics.',{final:true}),[]);
  assert.deepEqual(stream.push('Could you explain the',{final:false}),[]);
  assert.deepEqual(stream.push('failure handling? We use retries.',{final:false}),['Could you explain the failure handling?']);
});
test('Tencent text parser follows timestamps and retains bilingual content',()=>{
  const rows=parseCaptionLines(lines('实时转写','请输入关键词','KoiWei 07:00:22','Why did you choose Redis?','为什么选择 Redis？','KoiWei 07:00:30','We needed fast reads.'));
  assert.equal(rows.length,2);assert.equal(rows[0].key,'07:00:22');
  assert.equal(rows[0].text,'Why did you choose Redis?\n为什么选择 Redis？');
});
test('initial history is backfill; a growing current paragraph updates the same record',()=>{
  const tracker=new CaptionTracker();
  const initial=tracker.ingest(lines('KoiWei 07:00:22','How would you'),100);
  assert.equal(initial.changed.length,0);assert.equal(initial.events[0].backfill,true);
  const growth=tracker.ingest(lines('KoiWei 07:00:22','How would you design a cache?'),200);
  assert.equal(growth.changed.length,1);assert.equal(growth.events[0].id,initial.events[0].id);
  assert.equal(tracker.ingest(lines('KoiWei 07:00:22','How would you design a cache?'),300).events.length,0);
  assert.equal(tracker.ingest(lines('KoiWei 07:00:22','How would you'),400).events.length,0);
  assert.equal(tracker.rows.get('07:00:22').text,'How would you design a cache?');
});
test('scrolling or OCR revisions to old paragraphs do not re-trigger question extraction',()=>{
  const tracker=new CaptionTracker();
  tracker.ingest(lines('KoiWei 07:00:22','An old question?','KoiWei 07:00:30','Current answer.'));
  const older=tracker.ingest(lines('KoiWei 07:00:22','An old question ?'));
  assert.equal(older.changed.length,0);assert.equal(older.events[0].backfill,true);
  const next=tracker.ingest(lines('KoiWei 07:00:35','Why?'));
  assert.equal(next.changed.length,1);
});
test('model output must quote current source text, be complete, and not duplicate a request',()=>{
  const segments=[{id:'s1',text:'Why Redis? Because it is fast. How did you measure latency?'}];
  const result={questions:[q('Why Redis?'),q('Why Redis?'),q('Why PostgreSQL?'),q('Because it is fast.', ['unknown']),q('How did you measure latency?',['s1'],false)]};
  assert.deepEqual(validateQuestions(result,segments,['s1']).map(x=>x.text),['Why Redis?']);
  assert.equal(validateQuestions(result,segments,[]).length,0);
  assert.equal(validateQuestions({questions:[q('Why Redis?')]},segments,['s1'],[{text:'Why Redis?',source_ids:['s1']}]).length,0);
});
test('existing complete questions stay ignored when their initial paragraph later grows',()=>{
  const initial=[{id:'s1',text:'Why Redis? Because it is fast.'}];
  const segments=[{id:'s1',text:'Why Redis? Because it is fast. How did you measure latency?'}];
  const result={questions:[q('Why Redis?'),q('How did you measure latency?')]};
  assert.deepEqual(validateQuestions(result,segments,['s1'],[],initial).map(x=>x.text),['How did you measure latency?']);
});
test('missing credentials leave transcription usable and keep pending API context bounded',()=>{
  const status=[];const extractor=new SemanticExtractor('/nonexistent/meetingbridge-test',()=>assert.fail('must not call API'),(...args)=>status.push(args));
  extractor.feed([{id:'initial',text:'Why Redis?'}],[]);
  assert.equal(extractor.initial.size,1);assert.equal(extractor.changed.size,0);
  for(let i=0;i<40;i++){const segment={id:`s${i}`,text:'How did it work?'};extractor.feed([segment],[segment]);}
  assert.equal(extractor.changed.size,1);assert.equal(extractor.timer,null);assert.equal(extractor.busy,false);
  assert.equal(status.at(-1)[0],'unconfigured');extractor.stop();
});
