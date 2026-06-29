// VFS /interim: раскрыть аккордеоны (View more) → найти кнопку записи/логина.
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
async function dumpAll(page,tag){
  const s=await page.evaluate(()=>Array.from(document.querySelectorAll("a,button")).map(el=>{const r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return null;const t=(el.innerText||"").trim().replace(/\s+/g," ").slice(0,45);if(!t)return null;return {tag:el.tagName,t:t,href:el.getAttribute("href")||""};}).filter(Boolean).slice(0,60));
  console.log("=== "+tag+" === ("+s.length+")");s.forEach(e=>console.log("  ["+e.tag+"] "+e.t+(e.href?"  → "+e.href:"")));
}
(async()=>{
  if(!KEY||!PROXY){console.error("нет ключа/прокси");process.exit(0);}
  let sol;try{sol=await capsolve(LOGIN);}catch(e){console.error("CAPSOLVER ERROR:",e.message);process.exit(0);}
  const ua=sol.userAgent||sol.user_agent||undefined;
  const ck=[];if(Array.isArray(sol.cookies))for(const c of sol.cookies)ck.push({name:c.name,value:String(c.value),domain:c.domain||"visa.vfsglobal.com",path:c.path||"/",secure:true});else if(sol.cookies)for(const k of Object.keys(sol.cookies))ck.push({name:k,value:String(sol.cookies[k]),url:"https://visa.vfsglobal.com/"});
  console.log("CF решён.");
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:true,proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const ctx=await browser.newContext({userAgent:ua,locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:900}});
  try{if(ck.length)await ctx.addCookies(ck);}catch(e){}
  const page=await ctx.newPage();
  try{
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("goto err:",e.message));
    await page.waitForTimeout(12000);
    const cb=await page.$("#onetrust-accept-btn-handler"); if(cb){await cb.click().catch(()=>{}); await page.waitForTimeout(2000);}
    // раскрыть все "View more"
    const vm=await page.$$("text=/view more/i");
    console.log("View more найдено:", vm.length);
    for(let i=0;i<vm.length;i++){ try{ await vm[i].scrollIntoViewIfNeeded(); await vm[i].click({timeout:5000}); await page.waitForTimeout(2500); console.log("раскрыл View more #"+(i+1)); }catch(e){console.log("vm click err:",e.message);} }
    await page.waitForTimeout(3000);
    await dumpAll(page,"interim после раскрытия аккордеонов");
    try{await page.screenshot({path:"/root/vfs-bot/recon_cap8.png",fullPage:true});console.log("screenshot(full) → recon_cap8.png");}catch(_){}
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
