import { open,mkdir,link,rename,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function exportScopedAccount(flags,deps) {
  if(typeof flags.output!=='string'||!flags.output.trim())throw Error('Use wilber account export --output <private-local.json>.');
  const output=path.resolve(flags.output);
  const descriptor=await deps.callTool('wilber_account_export',{});
  if(!descriptor||descriptor.export_path!=='/api/wilber/account-export'||!/^[a-f0-9]{64}$/.test(descriptor.revision)||!Array.isArray(descriptor.tables)||descriptor.tables.length>100||descriptor.tables.some(table=>!table||!/^[a-z][a-z0-9_]{0,100}$/.test(table.name)||!Number.isSafeInteger(table.count)||table.count<0))throw Error('Your private export could not be prepared. No account data was saved.');
  const names=descriptor.tables.map(table=>table.name);if(new Set(names).size!==names.length)throw Error('The export table manifest is invalid.');
  const endpoint=new URL(deps.endpoint());if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost'].includes(endpoint.hostname)))throw Error('Use a secure Wilber endpoint.');
  const auth=await deps.resolveToken();
  await mkdir(path.dirname(output),{recursive:true,mode:0o700});
  const temporary=path.join(path.dirname(output),`.wilber-account-export-${randomUUID()}.tmp`);
  const handle=await open(temporary,'wx',0o600);let completed=false;let rows=0;
  try {
    await handle.writeFile('{"format":"wilber-account-export-v1","exported_at":'+JSON.stringify(new Date().toISOString())+',"revision":'+JSON.stringify(descriptor.revision)+',"tables":{');
    let firstTable=true;
    for(const table of descriptor.tables){
      await handle.writeFile((firstTable?'':',')+JSON.stringify(table.name)+':[');firstTable=false;
      let offset=0,firstRow=true;
      while(offset<table.count){
        const response=await fetch(new URL(descriptor.export_path,endpoint),{method:'POST',headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},body:JSON.stringify({table:table.name,limit:Math.min(10,descriptor.page_limit||100),offset,revision:descriptor.revision}),redirect:'error',signal:AbortSignal.timeout(120000)});
        let page;try{page=await response.json();}catch{throw Error('An export page was unreadable. Your incomplete local file will be removed.');}
        if(!response.ok)throw deps.requestFailure(response.status,page,auth);
        if(page.table!==table.name||page.revision!==descriptor.revision||page.offset!==offset||page.total!==table.count||!Array.isArray(page.items)||page.items.length<1||page.items.length>10||offset+page.items.length>table.count)throw Error('The export changed or returned an invalid page. Start a fresh export.');
        for(const item of page.items){await handle.writeFile((firstRow?'':',')+JSON.stringify(item));firstRow=false;rows++;}
        offset+=page.items.length;
        if(page.next_offset!==(offset<table.count?offset:null))throw Error('The export page could not be reconciled. Start a fresh export.');
      }
      await handle.writeFile(']');
    }
    const current=await deps.callTool('wilber_account_export',{});
    if(current.revision!==descriptor.revision||JSON.stringify(current.tables)!==JSON.stringify(descriptor.tables))throw Error('Your account changed during export. Start a fresh export to capture its current state.');
    await handle.writeFile('}}\n');await handle.sync();await handle.close();
    if(flags.overwrite===true)await rename(temporary,output);else{await link(temporary,output);await unlink(temporary);}
    completed=true;return {status:'saved',path:output,tables:descriptor.tables.length,rows};
  }catch(error){if(error?.code==='EEXIST')throw Error('The output file already exists. Choose another path, or use --overwrite for an intentional replacement.');throw error;}
  finally{if(!completed){await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}}
}
