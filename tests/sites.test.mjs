import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/sites.js';
const Sites=globalThis.MeetingBridgeSites;
test('conversation identity includes origin, path, query and hash',()=>{
  assert.notEqual(Sites.key('https://chat.deepseek.com/'),Sites.key('https://chatgpt.com/'));
  assert.notEqual(Sites.key('https://qianwen.com/?sessionId=a'),Sites.key('https://qianwen.com/?sessionId=b'));
  assert.notEqual(Sites.key('https://qianwen.com/#/chat/a'),Sites.key('https://qianwen.com/#/chat/b'));
  assert.equal(Sites.key('https://qianwen.com/?sessionId=a&utm_source=test'),Sites.key('https://qianwen.com/?sessionId=a'));
  for(const url of ['https://chat.deepseek.com.evil.example/','http://chat.deepseek.com/','https://evil.example/'])assert.equal(Sites.site(url),null);
});
test('only the first same-site conversation created from a bound new-chat page is adopted',()=>{
  for(const [from,to] of [['https://chatgpt.com/','https://chatgpt.com/c/abc'],['https://chat.deepseek.com/','https://chat.deepseek.com/a/chat/s/abc'],['https://qianwen.com/','https://qianwen.com/?sessionId=abc'],['https://chat.qwen.ai/','https://chat.qwen.ai/c/abc']])assert.equal(Sites.adopt(from,to),true);
  for(const [from,to] of [['https://chatgpt.com/','https://chat.deepseek.com/a/chat/s/abc'],['https://chatgpt.com/c/old','https://chatgpt.com/c/new'],['https://qianwen.com/','https://qianwen.com/login'],['https://qianwen.com/?sessionId=old','https://qianwen.com/?sessionId=new']])assert.equal(Sites.adopt(from,to),false);
});
