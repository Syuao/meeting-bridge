// Keep only transcript text, even when a drag crosses timestamps and action buttons.
export function selectedTranscript(selection,elements){
  if(!selection?.rangeCount||selection.isCollapsed)return '';
  const source=selection.getRangeAt(0),parts=[];
  for(const element of elements){
    if(!source.intersectsNode(element))continue;
    const clipped=element.ownerDocument.createRange();clipped.selectNodeContents(element);
    if(element.contains(source.startContainer))clipped.setStart(source.startContainer,source.startOffset);
    if(element.contains(source.endContainer))clipped.setEnd(source.endContainer,source.endOffset);
    const text=clipped.toString().trim();if(text)parts.push(text);
  }
  return parts.join('\n\n');
}
