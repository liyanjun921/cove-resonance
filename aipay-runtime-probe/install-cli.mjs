import path from 'node:path';
import {pathToFileURL} from 'node:url';
const metadata='https://render.alipay.com/p/yuyan/alipay-bot-cli-helper-config_cli-install-prod/zh_CN.json';
const r=await fetch(metadata,{signal:AbortSignal.timeout(30000)});
if(!r.ok)throw new Error('Official update service unavailable');
await r.arrayBuffer();
const cli=path.resolve('node_modules/@alipay/agent-payment/dist/cli.js');
process.argv=[process.execPath,cli,'install-cli','--json'];
await import(pathToFileURL(cli).href);
