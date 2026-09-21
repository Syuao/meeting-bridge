export function cleanTranscript(text) {
  return String(text).replace(/\[(?:blank_audio|silence|music|applause|noise)[^\]]*\]/gi, '').replace(/\((?:music|applause|silence|noise)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
}
export function questionKey(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const segmenter = new Intl.Segmenter('en', {granularity:'sentence'});
export function sentences(text) {
  return [...segmenter.segment(cleanTranscript(text))].map(x=>x.segment.trim()).filter(Boolean);
}
function questionSentence(text) {
  const t=cleanTranscript(text).replace(/^(?:(?:so|and|or|then|now|okay|ok|well|also|but|you know|i mean)[,\s]+)*/i,'').replace(/^(?:那么|那|然后|所以|嗯|呃)[，,\s]*/,'');
  if(!t || /^(?:thank(?:s| you)[!. ]*|you[.! ]*|bye[.! ]*|谢谢[。！ ]*)$/i.test(t))return false;
  // Reported questions inside an answer are not direct requests to the listener.
  if(/^(?:the (?:question|issue|problem) (?:was|is)|i (?:asked|wondered|explained|think|believe)|we (?:asked|explained|discussed)|我(?:解释|认为|觉得|当时问|想说明)|我们(?:讨论|解释|认为))/i.test(t))return false;
  if(/^(?:what|why|how|when|where|which|who|whose|could (?:you|we)|can (?:you|we)|would (?:you|it)|will you|do (?:you|we)|did (?:you|it)|have you|are (?:you|there)|is (?:there|it|that)|does (?:it|that)|tell (?:me|us)|walk (?:me|us) through|explain|describe|compare|give (?:me|us)|design|implement|write (?:a|an|the)|elaborate|expand on)\b/i.test(t))return true;
  if(/^(?:i(?:'d| would) (?:like|love) (?:you to|to (?:know|hear|understand))|i(?:'m| am) (?:curious|interested)|i (?:was|am) wondering|could (?:we|i) hear)\b/i.test(t))return true;
  if(/^(?:什么|为什么|怎么|如何|是否|能否|请问|请(?:介绍|解释|描述)|举个例子|谈谈|介绍一下|解释一下|具体呢|然后呢|还有呢|比如呢)/.test(t))return true;
  if(/^(?:你|您|这个|这种|这项|在.{0,15})(?:.{0,30})(?:什么|为什么|怎么|如何|是否|能否|吗|呢|介绍|解释|谈谈|觉得)/.test(t))return true;
  if(/^(?:我想(?:了解|知道|问)|我很好奇|想请你|方便.{0,8}(?:介绍|解释))/.test(t))return true;
  return /[?？]$/.test(t);
}
export function extractQuestions(text) {
  const found=[];let context=[];
  for(const sentence of sentences(text)) {
    if(/^(?:suppose|imagine|consider|let'?s say|given|we (?:have|need)|you (?:have|need|are given)|假设|假如)/i.test(sentence)&&!/[?？]/.test(sentence)){
      context.push(sentence);context=context.slice(-2);continue;
    }
    if(questionSentence(sentence))found.push([...context,sentence].join(' '));
    context=[];
  }
  return found;
}
export const isQuestion=text=>extractQuestions(text).length>0;
export class QuestionGate {
  constructor() { this.recent = []; }
  accept(text, now = Date.now(), scope = null) {
    const key = questionKey(text);
    if (!isQuestion(text)) return false;
    this.recent = this.recent.filter(x => now - x.at < 120000);
    const words = new Set(key.split(' '));
    if (this.recent.some(x => {
      // A real repeated question in a new speech turn must not be suppressed.
      if(scope!==null && x.scope!==scope)return false;
      if (x.key === key) return true;
      const old = new Set(x.key.split(' '));
      const common = [...words].filter(w => old.has(w)).length;
      return words.size > 6 && old.size > 6 && common / new Set([...words, ...old]).size > 0.92;
    })) return false;
    this.recent.push({key, at: now, scope}); return true;
  }
}
