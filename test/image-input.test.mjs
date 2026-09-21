import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {followerTurnInput,loadLocalImages,verifiedInlineImages,MAX_IMAGE_BYTES} from '../src/image-input.mjs';
const id='00000000-0000-4000-8000-000000000001';
const png=Buffer.from('89504e470d0a1a0a01020304','hex');
const image=bytes=>({mimeType:'image/png',data:bytes.toString('base64'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),detail:null});
const request=(items,attachments=[])=>({method:'thread-follower-start-turn',version:2,params:{conversationId:id,turnStart:{request:{threadId:id,input:[{type:'text',text:'사진 확인',text_elements:[]},...items]},context:{attachments}}}});
test('official local image context is accepted and uploaded as bytes, never as a laptop path',async()=>{
  const local='C:\\Users\\tester\\image.png';
  const input=followerTurnInput(request([{type:'localImage',path:local}],[{fsPath:local,path:local,label:'image.png'}]),id);
  let closed=false,pos=0;
  const images=await loadLocalImages(input.localImages,{open:async()=>({stat:async()=>({isFile:()=>true,size:png.length,mtimeMs:1}),read:async(b,o,n)=>{const count=Math.min(n,png.length-pos);png.copy(b,o,pos,pos+count);pos+=count;return{bytesRead:count};},close:async()=>{closed=true}})});
  assert.equal(closed,true);assert.equal(input.text,'사진 확인');
  assert.deepEqual(verifiedInlineImages(images),[{type:'image',url:'data:image/png;base64,'+png.toString('base64'),detail:null}]);
});
test('clipboard inline images work; foreign paths, ordinary attachments and HTTP URLs are rejected',async()=>{
  const parsed=followerTurnInput(request([{type:'image',url:'data:image/png;base64,'+png.toString('base64')}]),id);
  assert.deepEqual(await loadLocalImages(parsed.localImages),[image(png)]);
  for(const r of [request([{type:'localImage',path:'relative.png'}]),request([{type:'image',url:'https://example.com/image.png'}]),request([],[{fsPath:'C:\\secret.txt'}])])
    assert.throws(()=>followerTurnInput(r,id));
  assert.throws(()=>followerTurnInput(request([]),'other'));
});
test('tampered content, MIME mismatch and aggregate size limits are enforced on GPU',()=>{
  const valid=image(png);assert.throws(()=>verifiedInlineImages([{...valid,sha256:'0'.repeat(64)}]));
  assert.throws(()=>verifiedInlineImages([{...valid,mimeType:'image/jpeg'}]));
  const big=Buffer.alloc(MAX_IMAGE_BYTES);png.copy(big);
  assert.equal(verifiedInlineImages([image(big)]).length,1);
  assert.throws(()=>verifiedInlineImages([image(big),valid]),/8MB/);
});
