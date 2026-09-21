import {extractQuestions,sentences,QuestionGate} from './questions.mjs';
// Consume completed sentences immediately. Later speech and ASR previews cannot
// hold an already finished question hostage while somebody answers it.
export class QuestionStream {
  constructor(){this.tail='';this.turn=0;this.gate=new QuestionGate();}
  push(text,{final=true,now=Date.now()}={}) {
    this.tail=[this.tail,text].filter(Boolean).join(' ');
    const parts=sentences(this.tail);let ready=parts;
    this.tail='';
    if(!final&&parts.length&&!/[.!?。！？]$/.test(parts.at(-1)))this.tail=parts.pop();
    const questions=extractQuestions(ready.join(' ')).filter(q=>this.gate.accept(q,now,this.turn));
    if(final){this.tail='';this.turn++;}
    // Keep memory bounded; the unabridged content remains in transcript history.
    if(this.tail.length>6000)this.tail=this.tail.slice(-6000);
    return questions;
  }
}
