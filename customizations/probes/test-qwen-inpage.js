const { chromium } = require("C:/Users/Administrator/.9router/runtime/node_modules/playwright-core");
const log=(...a)=>console.log(`[${new Date().toISOString().slice(11,19)}]`,...a);
(async()=>{
  const ctx=await chromium.launchPersistentContext("C:/Users/Administrator/.9router/browser-profiles/qwen",{headless:true,executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",viewport:null,args:["--disable-blink-features=AutomationControlled"]});
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto("https://chat.qwen.ai/",{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log("goto",e.message));
  await page.waitForTimeout(12000);
  const out=await page.evaluate(async()=>{
    const tok=localStorage.getItem("token");
    const H={Authorization:"Bearer "+tok,"Content-Type":"application/json",Accept:"text/event-stream","x-request-id":crypto.randomUUID()};
    const res=await fetch("/api/v2/chat/completions",{method:"POST",headers:H,body:JSON.stringify({model:"qwen3.7-plus",messages:[{role:"user",content:"Reply with exactly: INPAGE-OK"}],stream:true})});
    const ct=res.headers.get("content-type");
    let text="";
    if(res.body){const rd=res.body.getReader();const d=new TextDecoder();const end=Date.now()+25000;
      while(Date.now()<end&&text.length<4000){const{done,value}=await rd.read();if(done)break;text+=d.decode(value,{stream:true});}
      try{rd.cancel()}catch{}}
    return {status:res.status,ct,len:text.length,head:text.slice(0,1200)};
  });
  log("in-page completions ->", out.status, "| ct:", out.ct, "| bytes:", out.len);
  console.log(out.head.replace(/\n/g," ").slice(0,1000));
  await ctx.close();
})().catch(e=>console.error("FATAL",e.message));
