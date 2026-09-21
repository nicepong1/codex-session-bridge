import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DETAILS = new Set([null, 'auto', 'low', 'high', 'original']);

function fail(message = '이미지 첨부를 전송할 수 없습니다') { throw new Error(message); }

function detectedMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function followerTurnInput(request, threadId) {
  if (request?.method !== 'thread-follower-start-turn' || request.version !== 2 ||
      request.params?.conversationId !== threadId || request.params?.turnStart?.request?.threadId !== threadId)
    fail('선택한 GPU 작업의 새 입력만 전송할 수 있습니다');
  return turnImageInput(request.params.turnStart.request.input,request.params.turnStart.context);
}

export function turnImageInput(input, context = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_IMAGE_COUNT + 1) fail();
  const texts = input.filter(item => item?.type === 'text');
  const images = input.filter(item => ['localImage','image'].includes(item?.type));
  if (texts.length !== 1 || texts.length + images.length !== input.length || typeof texts[0].text !== 'string' ||
      !texts[0].text.trim() || texts[0].text.length > 16000 || (texts[0].text_elements?.length ?? 0)) fail();
  if (images.length > MAX_IMAGE_COUNT) fail('한 번에 이미지 4개까지 전송할 수 있습니다');
  const localImages = images.map(item => {
    if (item.type === 'image') {
      if (typeof item.url !== 'string' || item.url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 80 || !DETAILS.has(item.detail ?? null)) fail();
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,/.exec(item.url);
      if (!match) fail('원격 이미지 주소 대신 이미지 파일을 첨부해 주세요');
      const data = item.url.slice(match[0].length), bytes = Buffer.from(data,'base64');
      const image = {mimeType:match[1],data,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),detail:item.detail??null};
      verifiedInlineImages([image]);
      return {inline:image};
    }
    if (typeof item.path !== 'string' || item.path.length > 4096 || /[\x00-\x1f]/.test(item.path) ||
        !path.win32.isAbsolute(item.path) || !DETAILS.has(item.detail ?? null)) fail();
    return {path: path.win32.normalize(item.path), detail: item.detail ?? null};
  });
  context ??= {};
  const paths = new Set(localImages.filter(i=>i.path).map(i=>i.path.toLowerCase()));
  if ((context.commentAttachments?.length ?? 0) || !Array.isArray(context.attachments ?? []) ||
      (context.attachments??[]).some(a=>typeof a?.fsPath!=='string'||!paths.has(path.win32.normalize(a.fsPath).toLowerCase())))
    fail('현재는 일반 파일 첨부를 전송할 수 없습니다');
  return {text: texts[0].text, localImages};
}

export async function loadLocalImages(localImages, {open = fs.promises.open} = {}) {
  if (!Array.isArray(localImages) || localImages.length > MAX_IMAGE_COUNT) fail();
  const result = []; let total = 0;
  for (const image of localImages) {
    if (image.inline) {
      verifiedInlineImages([image.inline]); total += image.inline.size;
      if (total > MAX_IMAGE_BYTES) fail('첨부 이미지 전체 크기는 8MB 이하여야 합니다');
      result.push(image.inline); continue;
    }
    let handle;
    try {
      handle = await open(image.path, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_IMAGE_BYTES || total + before.size > MAX_IMAGE_BYTES) fail('첨부 이미지 전체 크기는 8MB 이하여야 합니다');
      // Cap allocation even if a file grows after stat().
      const buffer = Buffer.alloc(before.size + 1); let used = 0;
      while (used < buffer.length) {
        const {bytesRead} = await handle.read(buffer,used,buffer.length-used,null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const bytes = buffer.subarray(0,used);
      const after = await handle.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('첨부 이미지가 전송 중 변경되었습니다');
      const mimeType = detectedMime(bytes); if (!mimeType) fail('PNG, JPEG, GIF, WebP 이미지만 전송할 수 있습니다');
      total += bytes.length;
      result.push({mimeType, data: bytes.toString('base64'), size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), detail: image.detail});
    } catch (error) {
      if (error?.message?.includes('이미지')) throw error;
      fail('첨부 이미지를 읽을 수 없습니다');
    } finally { await handle?.close().catch(() => {}); }
  }
  return result;
}

export function verifiedInlineImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGE_COUNT) fail();
  const result = []; let total = 0;
  for (const image of images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || !['image/png','image/jpeg','image/gif','image/webp'].includes(image.mimeType) ||
        typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || !Number.isInteger(image.size) || image.size < 1 ||
        typeof image.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(image.sha256) || !DETAILS.has(image.detail ?? null)) fail();
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length !== image.size || bytes.toString('base64') !== image.data || detectedMime(bytes) !== image.mimeType ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256) fail();
    total += bytes.length; if (total > MAX_IMAGE_BYTES) fail('첨부 이미지 전체 크기는 8MB 이하여야 합니다');
    result.push({type: 'image', url: `data:${image.mimeType};base64,${image.data}`, detail: image.detail ?? null});
  }
  return result;
}

export function imageFingerprint(images = []) {
  return images.map(({mimeType,size,sha256,detail}) => ({mimeType,size,sha256,detail:detail ?? null}));
}
