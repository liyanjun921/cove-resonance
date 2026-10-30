import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildListenerHtml } from '../src/listener-html.js';

async function harness({hold = false, refuse = false} = {}) {
  let now = 1800000000000;
  const elements = new Map<string, {textContent:string; disabled:boolean; click?:()=>void}>();
  const intervals = new Map<number, ()=>void>();
  const handlers = new Map<string, (event?:any)=>void>();
  const calls: Array<{method:string; params:any}> = [];
  let counter = 0, release: (()=>void)|undefined;
  const parent = {postMessage(m:any) {
    if (m.id === undefined) return;
    calls.push(m);
    const respond = () => handlers.get('message')?.({source:parent, data:{jsonrpc:'2.0',id:m.id,
      ...(m.method === 'ui/message' && refuse ? {error:{code:-32601,message:'Host refused'}} : {result:{}})}});
    if (m.method === 'ui/message' && hold) release = respond;
    else queueMicrotask(respond);
  }};
  const document = {hidden:false, addEventListener(name:string,fn:()=>void){handlers.set(name,fn);},
    getElementById(id:string) {
      if (!elements.has(id)) elements.set(id,{textContent:'',disabled:false});
      const el = elements.get(id)!;
      return Object.assign(el,{addEventListener(_name:string,fn:()=>void){el.click=fn;}});
    }};
  const window = {parent,addEventListener(name:string,fn:()=>void){handlers.set(name,fn);},
    setTimeout(){return 1;},setInterval(fn:()=>void){const id=++counter;intervals.set(id,fn);return id;},
    clearInterval(id:number){intervals.delete(id);}};
  const script = buildListenerHtml(true).match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInNewContext(script,{window,document,URL,Date:class extends Date{static now(){return now;}},
    localStorage:{getItem(){return null;},setItem(){}}});
  async function settle(){for(let i=0;i<30;i++) await Promise.resolve();}
  await settle();
  return {calls,el:(id:string)=>document.getElementById(id),settle,
    get sends(){return calls.filter(x=>x.method==='ui/message').length;},
    async advance(ms:number){now+=ms;for(const fn of [...intervals.values()]) fn();await settle();},
    hide(v:boolean){document.hidden=v;handlers.get('visibilitychange')?.();},
    async release(){release?.();await settle();}};
}

test('old generic card gains opt-in movie controls; music card remains unchanged',async()=>{
  assert.match(buildListenerHtml(true),/id="cinema-start"/);
  assert.doesNotMatch(buildListenerHtml(),/id="cinema-start"/);
  const h=await harness();await h.advance(900000);assert.equal(h.sends,0);
  h.el('cinema-start').click?.();await h.advance(299000);assert.equal(h.sends,0);
  await h.advance(1000);assert.equal(h.sends,1);
  await h.advance(300000);assert.equal(h.sends,2);
  assert.equal(h.calls.some(x=>x.method==='tools/call'),false);
  assert.match(h.calls.find(x=>x.method==='ui/message')!.params.content[0].text,/cinema_status/);
});

test('single movie test does not start recurring timer; rejection stops without retry',async()=>{
  const h=await harness();h.el('cinema-test').click?.();await h.settle();
  assert.equal(h.sends,1);await h.advance(900000);assert.equal(h.sends,1);
  const r=await harness({refuse:true});r.el('cinema-start').click?.();await r.advance(300000);
  assert.match(r.el('cinema-status').textContent,/Host refused/);
  await r.advance(900000);assert.equal(r.sends,1);assert.equal(r.el('cinema-start').disabled,false);
});

test('pending host decision never resubmits, and stop prevents rearming after late acceptance',async()=>{
  const h=await harness({hold:true});h.el('cinema-start').click?.();await h.advance(300000);
  await h.advance(1800000);assert.equal(h.sends,1);assert.equal(h.el('toggle').disabled,true);
  h.el('cinema-stop').click?.();await h.release();await h.advance(900000);
  assert.equal(h.sends,1);assert.equal(h.el('cinema-start').disabled,false);
});

test('background or explicit stop prevents sends; foreground return restarts five minutes',async()=>{
  const h=await harness();h.el('cinema-start').click?.();h.hide(true);
  await h.advance(900000);assert.equal(h.sends,0);h.hide(false);
  await h.advance(299000);assert.equal(h.sends,0);await h.advance(1000);assert.equal(h.sends,1);
  h.el('cinema-stop').click?.();await h.advance(900000);assert.equal(h.sends,1);
});
