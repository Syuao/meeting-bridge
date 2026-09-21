import test from 'node:test';
import assert from 'node:assert/strict';
import {isQuestion,QuestionGate,cleanTranscript} from '../host/questions.mjs';
test('recognizes spoken interview requests and bilingual questions',()=>{
  for(const q of ['Could you explain the difference between a process and a thread? And give one practical example of when you would use each?', 'So, tell me about a time you handled a difficult stakeholder.', 'We have a million users. How would you design the cache?', 'Walk me through your approach to this problem.', '请介绍一下你的项目经历。','为什么选择这种方案？'])assert.equal(isQuestion(q),true,q);
});
test('does not treat ordinary statements and transcription noise as questions',()=>{
  for(const t of ['Thank you.', '[BLANK_AUDIO]', 'We use Redis for caching and Postgres for storage.', 'I worked on a payments project for two years.','谢谢。'])assert.equal(isQuestion(t),false,t);
});
test('deduplicates ASR repeats without suppressing later follow-up questions',()=>{
  const gate=new QuestionGate();const q='How would you design a cache for one million users?';
  assert.equal(gate.accept(q,0),true);assert.equal(gate.accept(q.toUpperCase(),2000),false);
  assert.equal(gate.accept('How would you invalidate stale entries in that cache?',3000),true);
  assert.equal(gate.accept(q,125000),true);
});
test('removes noise markers and preserves normal text',()=>assert.equal(cleanTranscript('[silence] How does a thread work?'),'How does a thread work?'));
