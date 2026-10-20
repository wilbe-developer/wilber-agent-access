import { open,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const BUILD_UPLOAD_MAX_BYTES=4*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mimeTypes={'.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};

async function boundedFile(file) {
  const handle=await open(file,'r');
  try {
    const info=await handle.stat();
    if(!info.isFile()||info.size<1||info.size>BUILD_UPLOAD_MAX_BYTES)throw Error('Choose a non-empty file up to 4 MiB, also within the task limit.');
    const buffer=Buffer.alloc(BUILD_UPLOAD_MAX_BYTES+1);let size=0;
    while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead;}
    if(size<1||size>BUILD_UPLOAD_MAX_BYTES)throw Error('The file exceeds the 4 MiB upload limit.');
    return buffer.subarray(0,size);
  }finally{await handle.close();}
}

export async function uploadBuildFile(filePath,flags,deps) {
  if(!filePath||flags.reviewed!==true)throw Error('Use wilber build upload <local-file> with the task, programme, revision, step, request ID and --reviewed after the member authorises this file.');
  for(const key of ['task-id','program-version-id','request-id'])if(typeof flags[key]!=='string'||!uuid.test(flags[key]))throw Error(`A valid --${key} is required.`);
  if(typeof flags['expected-revision']!=='string'||!/^[a-f0-9]{64}$/.test(flags['expected-revision']))throw Error('Use --expected-revision from the latest Build task read.');
  if(typeof flags['step-id']!=='string'||!flags['step-id'])throw Error('Use the upload step ID from the task edit context.');
  const endpoint=new URL(deps.endpoint());
  if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost'].includes(endpoint.hostname)))throw Error('Use a secure Wilber endpoint.');
  const bytes=await boundedFile(filePath);const fileName=path.basename(filePath);
  const mime=typeof flags['mime-type']==='string'?flags['mime-type']:mimeTypes[path.extname(fileName).toLowerCase()]||'application/octet-stream';
  if(fileName.length>200||/[\x00-\x1f\x7f]/.test(fileName))throw Error('Use a file name up to 200 characters without control characters.');
  if(!Object.values(mimeTypes).includes(mime))throw Error('Supported Build files are PDF, TXT, CSV, PNG, JPEG, DOCX, XLSX and PPTX, subject to the task’s narrower upload rules.');
  const args={task_id:flags['task-id'],program_version_id:flags['program-version-id'],expected_revision:flags['expected-revision'],step_id:flags['step-id'],...(flags['field-id']?{field_id:String(flags['field-id'])}:{}),...(flags['replace-file-id']?{replace_file_id:String(flags['replace-file-id'])}:{}),file_name:fileName,mime_type:mime,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),idempotency_key:flags['request-id'],reviewed:true,...(flags['acknowledge-public-sharing']===true?{acknowledge_public_sharing:true}:{})};
  const checkpointPath=path.join(deps.configDirectory(),'build-uploads',args.idempotency_key+'.json');
  const binding={endpoint_origin:endpoint.origin,args};let checkpoint;
  try{checkpoint=JSON.parse(await readFile(checkpointPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('The saved upload checkpoint is unreadable; inspect it before starting another request.');}
  if(checkpoint&&JSON.stringify(checkpoint.binding)!==JSON.stringify(binding))throw Error('This request ID belongs to different file content or task settings. Retry the original exact action or use a new ID for a deliberately new action.');
  await deps.writePrivateJson(checkpointPath,{binding,status:'preparing'});
  const upload=await deps.callTool('wilber_build_file_prepare',args);
  if(!upload||!uuid.test(upload.upload_id||'')||!uuid.test(upload.file_id||''))throw Error('The upload reservation could not be confirmed. Keep the original request ID.');
  await deps.writePrivateJson(checkpointPath,{binding,upload_id:upload.upload_id,status:upload.status});
  if(upload.status==='committed'){
    if(upload.receipt?.status!=='saved')throw Error('The saved upload receipt is unavailable; check its status before retrying.');
    await deps.writePrivateJson(checkpointPath,{binding,upload_id:upload.upload_id,status:'committed',receipt:upload.receipt});return upload.receipt;
  }
  if(upload.status!=='prepared'||upload.upload_path!==`/api/wilber/build-file-upload?upload_id=${upload.upload_id}`)throw Error('The upload reservation is invalid. No bytes were sent.');
  const target=new URL(upload.upload_path,endpoint);const auth=await deps.resolveToken();
  const form=new FormData();form.append('file',new Blob([bytes],{type:mime}),fileName);
  let response;
  try {response=await fetch(target,{method:'POST',headers:{Authorization:`Bearer ${auth.token}`},body:form,redirect:'error',signal:AbortSignal.timeout(120000)});}
  catch{throw Error(`The file upload could not be confirmed. Keep request ID ${args.idempotency_key}; check upload ${upload.upload_id} or repeat the exact command with the unchanged file.`);}
  let result;try{result=await response.json();}catch{throw Error(`The upload response was unreadable. Check upload ${upload.upload_id}; preserve the original request ID and file.`);}
  if(!response.ok)throw deps.requestFailure(response.status,result,auth);
  if(result?.status!=='saved'||result?.upload_id!==upload.upload_id||result?.file?.fileId!==upload.file_id)throw Error('The file attachment was not acknowledged. Check the same upload before retrying.');
  await deps.writePrivateJson(checkpointPath,{binding,upload_id:upload.upload_id,status:'committed',receipt:result});
  return result;
}
