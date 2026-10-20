import { open,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maxBytes=1024*1024*1024;
const mimeTypes={'.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.zip':'application/zip','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const secure=url=>url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname));
async function boundedFile(file,maximum) {
  const handle=await open(file,'r');
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size<1||stat.size>maximum)throw Error('Choose a non-empty file within the platform upload limit.');
    const buffer=Buffer.alloc(stat.size+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
    if(length!==stat.size)throw Error('The file changed while it was read. Retry with the intended stable file.');
    return buffer.subarray(0,length);
  }finally{await handle.close();}
}

async function fileSource(file,maximum,mime) {
  const {openAsBlob}=await import('node:fs');
  if(typeof openAsBlob!=='function')throw Error('Private file transfer requires Node.js 22 or newer. Update Node.js, then resume with the same file and request ID.');
  const handle=await open(file,'r');
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.size<1||before.size>maximum)throw Error('Choose a non-empty file within the platform upload limit.');
    let size=0;const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({autoClose:false})){size+=chunk.byteLength;if(size>maximum)throw Error('The file exceeds the platform upload limit.');hash.update(chunk);}
    const after=await handle.stat();
    if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('The file changed while it was read. Resume with the intended stable file.');
    // The file-backed Blob streams bytes without retaining a large media file
    // in memory. Storage's byte proof also catches a change after this read.
    const body=await openAsBlob(file,{type:mime});
    if(body.size!==size)throw Error('The file changed before transfer.');
    return {size,sha256:hash.digest('hex'),body};
  }finally{await handle.close();}
}

export async function transferScopedFile(filePath,flags,deps) {
  if(!filePath||flags.reviewed!==true||typeof flags['arguments-file']!=='string'||typeof flags['prepare-tool']!=='string'||!uuid.test(flags['request-id']||''))throw Error('Use wilber files upload <file> --prepare-tool <listed preparation tool> --arguments-file <reviewed-target.json> --request-id <uuid> --reviewed.');
  if(!/^wilber_[a-z_]+_(file|material)_prepare$/.test(flags['prepare-tool']))throw Error('Use the preparation tool returned by the current Wilber tool catalog.');
  const endpoint=new URL(deps.endpoint());if(!secure(endpoint))throw Error('Use a secure Wilber endpoint.');
  const input=JSON.parse((await boundedFile(flags['arguments-file'],128*1024)).toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('The target arguments must be a JSON object.');
  if(input.reviewed!==true&&input.instructed!==true)throw Error('Target arguments must record the member’s instruction or review.');
  const fileName=path.basename(filePath);
  const mime=typeof flags['mime-type']==='string'?flags['mime-type']:mimeTypes[path.extname(fileName).toLowerCase()]||'application/octet-stream';
  if(!mime||mime.length>150||/[\x00-\x20\x7f]/.test(mime)||fileName.length>240||/[\x00-\x1f\x7f]/.test(fileName))throw Error('Use a valid file name and MIME type.');
  const source=await fileSource(filePath,maxBytes,mime);
  const bound={file_name:fileName,mime_type:mime,size_bytes:source.size,sha256:source.sha256,idempotency_key:flags['request-id']};
  for(const [key,value]of Object.entries(bound))if(key in input&&input[key]!==value)throw Error(`The reviewed ${key} differs from this exact file or request.`);
  const args={...input,...bound};
  const binding={endpoint_origin:endpoint.origin,tool:flags['prepare-tool'],args};
  const checkpointPath=path.join(deps.configDirectory(),'file-transfers',bound.idempotency_key+'.json');
  let previous;
  try{previous=JSON.parse(await readFile(checkpointPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('The saved transfer checkpoint is unreadable. Inspect its status before using another request key.');}
  if(previous&&canonical(previous.binding)!==canonical(binding))throw Error('This request key belongs to different content or settings. Resume the unchanged action or deliberately use a new key.');
  await deps.writePrivateJson(checkpointPath,{binding,status:'preparing'});
  const prepared=await deps.callTool(flags['prepare-tool'],args);
  if(!prepared||!uuid.test(prepared.upload_id||'')||!uuid.test(prepared.file_id||'')||!['own','community','forum'].includes(prepared.family)||prepared.transfer_path!=='/api/wilber/file-transfer')throw Error('The transfer reservation could not be verified. Keep the same request key.');
  const record={binding,upload_id:prepared.upload_id,file_id:prepared.file_id,family:prepared.family};
  await deps.writePrivateJson(checkpointPath,{...record,status:prepared.status});
  const accept=async receipt=>{
    if(!receipt||!['saved','verified'].includes(receipt.status)||receipt.upload_id!==prepared.upload_id)throw Error('The durable file receipt is unavailable. Check this same upload before retrying.');
    await deps.writePrivateJson(checkpointPath,{...record,status:receipt.status==='verified'?'verified':'committed',receipt});return receipt;
  };
  if(prepared.status==='committed'||prepared.status==='verified')return accept(prepared.receipt);
  if(prepared.status!=='prepared'||prepared.sha256!==bound.sha256||prepared.size_bytes!==bound.size_bytes||prepared.mime_type!==mime)throw Error('The reservation differs from the intended file. No bytes were transferred.');
  const auth=await deps.resolveToken();
  const post=async action=>{
    let response;
    try{response=await fetch(new URL(prepared.transfer_path,endpoint),{method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:JSON.stringify({family:prepared.family,upload_id:prepared.upload_id,action}),redirect:'error',signal:AbortSignal.timeout(180000)});}catch{throw Error(`Transfer ${prepared.upload_id} could not be confirmed. Resume the exact command with the original file and request key.`);}
    let body;try{body=await response.json();}catch{throw Error(`Transfer ${prepared.upload_id} returned an unreadable response. Preserve the original request key.`);}
    if(!response.ok)throw deps.requestFailure(response.status,body,auth);
    return body;
  };
  const signed=await post('sign');
  if(signed.status==='committed'||signed.status==='verified')return accept(signed.receipt);
  let target;
  try{target=new URL(signed.upload_url);}catch{throw Error('Invalid private transfer capability.');}
  if(!secure(target)||target.origin!==signed.storage_origin||!target.pathname.includes('/object/upload/sign/')||signed.upload_id!==prepared.upload_id||signed.file_id!==prepared.file_id||signed.sha256!==bound.sha256||signed.size_bytes!==source.size||signed.mime_type!==mime)throw Error('Invalid private transfer binding.');
  // Never forward the Wilber credential to Storage, print its signed capability,
  // or persist that capability. A duplicate/uncertain PUT is resolved by bytes.
  try{await fetch(target,{method:'PUT',headers:{'Content-Type':mime,'x-upsert':'false','cache-control':'max-age=0'},body:source.body,redirect:'error',signal:AbortSignal.timeout(180000)});}catch{/* Verification determines whether the exact bytes arrived. */}
  const verified=await post('verify');
  if(verified.status!=='committed'&&verified.status!=='verified')throw Error('The transfer is pending. Resume this same request without changing its file.');
  return accept(verified.receipt);
}
