import http from 'node:http';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// This independent process never imports Bridge, NetEase, credentials or wallet mutation tools.
export function runVendorQuery({binary=path.join(homedir(),'.local/bin/alipay-bot'),timeout=55000}={}) {
  return new Promise(resolve=>{
    const keys=['PATH','USER','LOGNAME','HOME','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR'];
    const env=Object.fromEntries(keys.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    const child=spawn(binary,['check-wallet','--json'],{shell:false,env,stdio:['ignore','pipe','pipe']});
    let stdout='',bytes=0,timedOut=false,overflow=false,finished=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',s=>{bytes+=Buffer.byteLength(s);if(bytes>262144){overflow=true;child.kill('SIGKILL')}else stdout+=s});
    child.stderr.resume();
    const finish=exitCode=>{if(finished)return;finished=true;clearTimeout(timer);resolve({stdout,exitCode,timedOut,overflow})};
    child.on('error',()=>finish(-1));child.on('close',code=>finish(code??-1));
  });
}

export function summarize(out,records=[]) {
  let vendorCode=null,structuredResult=false;
  try { const d=JSON.parse(out.stdout);if(d&&typeof d==='object'&&typeof d.code==='number'){vendorCode=d.code;structuredResult=true} } catch {}
  let gatewayTransportSuccess=null,gatewayHttpStatus=null,nativeDependencyError=false,gatewayNetworkError=false;
  for(const record of records){
    const p=record?.payload;if(!p||typeof p!=='object')continue;
    const error=typeof p.errorSummary==='string'?p.errorSummary:'';
    if(/undefined symbol|cannot open shared object/i.test(error))nativeDependencyError=true;
    if(/network is unreachable|dial tcp|lookup .*:|TLS handshake|connection refused/i.test(error))gatewayNetworkError=true;
    if(record.message?.startsWith('AgentGW')||p.serviceCode==='alipay.agmnt.AgMntService'){
      if(typeof p.transportSuccess==='boolean')gatewayTransportSuccess=p.transportSuccess;
      if(Number.isInteger(p.httpStatus))gatewayHttpStatus=p.httpStatus;
    }
  }
  return {phase:'complete',cliExitCode:out.exitCode,structuredResult,vendorCode,timedOut:!!out.timedOut,outputTruncated:!!out.overflow,gatewayTransportSuccess,gatewayHttpStatus,nativeDependencyError,gatewayNetworkError};
}

async function recentDiagnostics(since) {
  const dir=path.join(homedir(),'.alipay-bot-cli/monitor-queue'),records=[];
  try {
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.json')).slice(-150)){
      const p=path.join(dir,name),info=await stat(p);
      if(info.mtimeMs<since||info.size>32768)continue;
      try{records.push(JSON.parse(await readFile(p,'utf8')))}catch{}
    }
  }catch{}
  return records;
}
export async function diagnose({runner=runVendorQuery,diagnostics=recentDiagnostics}={}) {
  const since=Date.now();
  const out=await runner();
  return summarize(out,await diagnostics(since));
}

export function createProbeServer(getState) {
  return http.createServer((req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;
    const ok=req.method==='GET'&&['/','/healthz','/status'].includes(route);
    res.writeHead(ok?200:404,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    // Only sanitized operational booleans/codes are returned; never CLI stdout, account state, links or identifiers.
    res.end(JSON.stringify(ok?{service:'aipay-runtime-probe',scope:'read-only-runtime-diagnostic',walletAuthorizationEnabled:false,paymentsEnabled:false,...getState()}:{error:'unsupported_operation'}));
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let state={phase:'running'};
  const server=createProbeServer(()=>state);
  server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('Read-only Alipay runtime probe listening. Authorization and payments are absent.'));
  // Exactly one read-only vendor query per process start. HTTP requests cannot trigger another query.
  diagnose().then(result=>{state=result;console.log(JSON.stringify(result))}).catch(()=>{state={phase:'failed',reason:'diagnostic_unavailable'};console.log(JSON.stringify(state))});
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
