// VFS /interim: закрыть cookie, найти кнопку перехода к записи/логину. Полный скрин + дамп.
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
async function dump(page,tag){
  const s=await page.evaluate(()=>Array.from(document.querySelectorAll("a,button")).map(el=>{const r=el.getBoundingClientRect();if(r.width===0&&r.height===0)return null;const t=(el.innerText||"").trim().replace(/\s+/g," ").slice(0,40);if(!t)return null;return {tag:el.tagName,t:t,href:el.getAttribute("href")||""};}).filter(Boolean).slice(0,50));
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
    // cookie consent (OneTrust, рус)
    for(const sel of ["#onetrust-accept-btn-handler","button:has-text('Согласиться')","button:has-text('Accept All')","button:has-text('Принять')"]){
      const b=await page.$(sel); if(b){await b.click().catch(()=>{}); console.log("consent закрыт:",sel); await page.waitForTimeout(2500); break;}
    }
    await dump(page,"interim после consent");
    // попробуем кликнуть переход к записи/логину
    let clicked="";
    for(const sel of ["button:has-text('Book Appointment')","a:has-text('Book Appointment')","button:has-text('Schedule')","button:has-text('Continue')","a:has-text('Continue')","button:has-text('Start')","button:has-text('Login')","a:has-text('Login')","button:has-text('Sign In')","button:has-text('Записаться')","button:has-text('Продолжить')"]){
      const el=await page.$(sel); if(el){await el.scrollIntoViewIfNeeded().catch(()=>{}); await el.click({timeout:6000}).catch(()=>{}); clicked=sel; console.log("→ кликнул:",sel); await page.waitForTimeout(9000); break;}
    }
    if(clicked){
      const fin=await page.evaluate(()=>({title:(document.title||"").slice(0,60),url:location.href,email:!!document.querySelector("input[type='email'],input[name*='mail' i]"),pass:!!document.querySelector("input[type='password']"),sessionErr:/session expired|unable to progress/i.test((document.body&&document.body.innerText)||"")}));
      console.log("после клика:",JSON.stringify(fin));
      await dump(page,"после клика страница");
    }
    try{await page.screenshot({path:"/root/vfs-bot/recon_cap7.png",fullPage:true});console.log("screenshot(full) → recon_cap7.png");}catch(_){}
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
