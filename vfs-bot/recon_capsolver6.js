// VFS: проследить, куда редиректит /interim (реальный портал записи/логина).
// Запуск: node recon_capsolver6.js
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
(async()=>{
  if(!KEY||!PROXY){console.error("нет ключа/прокси");process.exit(0);}
  let sol;try{sol=await capsolve(LOGIN);}catch(e){console.error("CAPSOLVER ERROR:",e.message);process.exit(0);}
  const ua=sol.userAgent||sol.user_agent||undefined;
  const ck=[];if(Array.isArray(sol.cookies))for(const c of sol.cookies)ck.push({name:c.name,value:String(c.value),domain:c.domain||"visa.vfsglobal.com",path:c.path||"/",secure:true});else if(sol.cookies)for(const k of Object.keys(sol.cookies))ck.push({name:k,value:String(sol.cookies[k]),url:"https://visa.vfsglobal.com/"});
  console.log("CF решён.");
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:true,proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const ctx=await browser.newContext({userAgent:ua,locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:768}});
  try{if(ck.length)await ctx.addCookies(ck);}catch(e){}
  const page=await ctx.newPage();
  page.on("framenavigated",(fr)=>{ if(fr===page.mainFrame()) console.log("  nav →", fr.url()); });
  page.on("response",(r)=>{ const u=r.url(); if(/login|signin|account|book|appointment|interim|oauth|auth|b2c|identity/i.test(u) && r.request().resourceType()==="document") console.log("  doc-resp", r.status(), u.slice(0,110)); });
  try{
    console.log("→ goto /interim, слежу за редиректами 22с…");
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("goto err:",e.message));
    for(let i=0;i<11;i++){ await page.waitForTimeout(2000); }
    const fin=await page.evaluate(()=>({title:(document.title||"").slice(0,70),url:location.href,email:!!document.querySelector("input[type='email'],input[name*='mail' i]"),pass:!!document.querySelector("input[type='password']"),challenge:/just a moment|момент|проверка безопас/i.test((document.title||"")+" "+((document.body&&document.body.innerText)||"")),sessionErr:/session expired|unable to progress/i.test((document.body&&document.body.innerText)||""),body:((document.body&&document.body.innerText)||"").replace(/\s+/g," ").slice(0,260)}));
    console.log("ФИНАЛ:",JSON.stringify(fin));
    try{await page.screenshot({path:"/root/vfs-bot/recon_cap6.png"});console.log("screenshot → recon_cap6.png");}catch(_){}
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
