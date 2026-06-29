// VFS: пройти CF (CapSolver) → home/interim → клик "I accept - Book an appointment
// now" → /login → снять структуру формы входа (поля, кнопки, капча/OTP, iframes).
// Прокси берём из PROXY_URL (proxy-seller Sticky RU), иначе MOBILE_PROXY.
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.PROXY_URL || process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
(async()=>{
  if(!KEY||!PROXY){console.error("нет ключа/прокси");process.exit(0);}
  let sol;try{sol=await capsolve(LOGIN);}catch(e){console.error("CAPSOLVER ERROR:",e.message);process.exit(0);}
  const ua=sol.userAgent||sol.user_agent||undefined;
  const ck=[];if(Array.isArray(sol.cookies))for(const c of sol.cookies)ck.push({name:c.name,value:String(c.value),domain:c.domain||"visa.vfsglobal.com",path:c.path||"/",secure:true});
  console.log("CF решён.");
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:true,proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const ctx=await browser.newContext({userAgent:ua,locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:900}});
  try{if(ck.length)await ctx.addCookies(ck);}catch(e){}
  const page=await ctx.newPage();
  try{
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("goto err:",e.message));
    await page.waitForTimeout(10000);
    const cb=await page.$("#onetrust-accept-btn-handler"); if(cb){await cb.click().catch(()=>{}); await page.waitForTimeout(1500);}
    // раскрыть аккордеоны "View more" — кнопка записи спрятана внутри блока №2
    const vm=await page.$$("text=/view more/i");
    console.log("View more найдено:", vm.length);
    for(let i=0;i<vm.length;i++){ try{ await vm[i].scrollIntoViewIfNeeded(); await vm[i].click({timeout:5000}); await page.waitForTimeout(2000); }catch(e){} }
    await page.waitForTimeout(2500);
    let acc=await page.$('a[href$="/login"]');
    if(!acc){ const els=await page.$$("a"); for(const e of els){ const t=((await e.innerText().catch(()=>""))||"").toLowerCase(); if(t.includes("book an appointment now")||t.includes("i accept")){acc=e;break;} } }
    if(acc){ await acc.scrollIntoViewIfNeeded().catch(()=>{}); await acc.click().catch(e=>console.log("accept click err:",e.message)); }
    else { console.log("ссылка accept не найдена, goto /login напрямую"); await page.goto(LOGIN,{waitUntil:"domcontentloaded",timeout:60000}).catch(()=>{}); }
    await page.waitForTimeout(13000);
    console.log("URL сейчас:", page.url());
    const form=await page.evaluate(()=>{
      const inp=Array.from(document.querySelectorAll("input,select,textarea")).map(e=>({tag:e.tagName,type:e.type||"",name:e.name||"",id:e.id||"",ph:e.placeholder||"",fc:e.getAttribute("formcontrolname")||"",vis:!!(e.offsetWidth||e.offsetHeight)})).filter(x=>x.type!=="hidden");
      const btn=Array.from(document.querySelectorAll("button,[type=submit]")).map(e=>((e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,40))).filter(Boolean);
      const ifr=Array.from(document.querySelectorAll("iframe")).map(e=>e.src||"").filter(Boolean);
      const html=document.body?document.body.innerHTML:"";
      const cap={recaptcha:/recaptcha/i.test(html),hcaptcha:/hcaptcha/i.test(html),turnstile:/turnstile|cf-chl/i.test(html),datadome:/datadome/i.test(html),arkose:/arkose|funcaptcha/i.test(html)};
      const otp=/otp|one[- ]?time|verification code|код подтвержд/i.test(document.body?document.body.innerText:"");
      const txt=document.body?document.body.innerText.replace(/\s+/g," ").slice(0,700):"";
      return {inp,btn,ifr,cap,otp,txt};
    });
    console.log("INPUTS:",JSON.stringify(form.inp,null,1));
    console.log("BUTTONS:",JSON.stringify(form.btn));
    console.log("IFRAMES:",JSON.stringify(form.ifr));
    console.log("CAPTCHA:",JSON.stringify(form.cap),"| OTP-текст:",form.otp);
    console.log("TEXT(700):",form.txt);
    await page.screenshot({path:"/root/vfs-bot/recon_login.png",fullPage:true}).catch(()=>{});
    console.log("screenshot → recon_login.png");
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
