import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptRows} from '../extension/transcript.js';
test('cloud previews and confirmed sentences share one continuous paragraph without duplicates',()=>{
 const row={id:'cloud-1',piece:'cloud-1',text:'Why Redis? Fast reads.',final:false};
 const state={transcripts:[row],partial:{piece:'cloud-1',text:'Why Redis?'}};
 assert.deepEqual(transcriptRows(state),[row]);
 row.final=true;state.partial=null;assert.equal(transcriptRows(state).length,1);
});
test('local live speech is visible before its final transcription without changing saved history',()=>{
 const state={transcripts:[{id:'old',text:'Earlier text.',at:1}],partial:{piece:0,text:'New question?'},startedAt:200};
 const rows=transcriptRows(state);assert.equal(rows.length,2);assert.equal(rows[1].final,false);assert.equal(rows[1].temporary,true);assert.equal(state.transcripts.length,1);
 assert.equal(transcriptRows(state)[1].id,rows[1].id);
});
test('Tencent OCR preview does not repeat the text already in the transcript',()=>{
 const state={transcripts:[{id:'caption',text:'New question?'}],partial:{piece:'tencent-text',text:'OCR visible excerpt'}};
 assert.equal(transcriptRows(state).length,1);
});
