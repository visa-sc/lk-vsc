// VFS /login: проходим CF на interim, кликаем в /login, и если на /login снова
// Cloudflare-челлендж — ДОСАЛВИВАЕМ его CapSolver'ом по текущему URL (свежий
// cf_clearance → reload), до 3 попыток. Затем снимаем форму входа. Прокси PROXY_URL.
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.PROXY_URL || process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
function cookiesFrom(sol){const ck=[];if(Array.isArray(sol.cookies))for(const c of sol.cookies)ck.push({name:c.name,value:String(c.value),domain:c.domain||"visa.vfsglobal.com",path:c.path||"/",secure:true});return ck;}
async function challenged(page){ try{ const t=await page.evaluate(()=>document.body?document.body.innerText:""); return /проверки безопасности|checking your browser|just a moment|verifying you are human|вредоносных ботов|Ray ID/i.test(t||""); }catch(e){return false;} }
(async()=>{
  if(!KEY||!PROXY){console.error("нет ключа/прокси");process.exit(0);}
  let sol;try{sol=await capsolve(LOGIN);}catch(e){console.error("CAPSOLVER ERROR:",e.message);process.exit(0);}
  const ua=sol.userAgent||sol.user_agent||undefined;
  console.log("CF решён (interim).");
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:true,proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const ctx=await browser.newContext({userAgent:ua,locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:900}});
  try{await ctx.addCookies(cookiesFrom(sol));}catch(e){}
  const page=await ctx.newPage();
  try{
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("goto err:",e.message));
    await page.waitForTimeout(9000);
    const cb=await page.$("#onetrust-accept-btn-handler"); if(cb){await cb.click().catch(()=>{}); await page.waitForTimeout(1500);}
    const vm=await page.$$("text=/view more/i");
    for(let i=0;i<vm.length;i++){ try{ await vm[i].scrollIntoViewIfNeeded(); await vm[i].click({timeout:5000}); await page.waitForTimeout(1800); }catch(e){} }
    await page.waitForTimeout(2000);
    let acc=await page.$('a[href$="/login"]');
    if(acc){ await acc.scrollIntoViewIfNeeded().catch(()=>{}); await acc.click().catch(e=>console.log("accept click err:",e.message)); }
    else { await page.goto(LOGIN,{waitUntil:"domcontentloaded",timeout:60000}).catch(()=>{}); }
    await page.waitForTimeout(9000);
    // ДОСАЛВ Cloudflare на /login, если челлендж
    for(let attempt=1; attempt<=3 && await challenged(page); attempt++){
      console.log("CF-челлендж на",page.url(),"→ пересолвим (попытка "+attempt+")");
      let s2; try{ s2=await capsolve(page.url()); }catch(e){ console.log("resolve err:",e.message); break; }
      try{ await ctx.addCookies(cookiesFrom(s2)); }catch(e){}
      await page.reload({waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("reload:",e.message));
      await page.waitForTimeout(10000);
    }
    const isCh = await challenged(page);
    console.log("URL:",page.url(),"| ещё челлендж:",isCh);
    const form=await page.evaluate(()=>{
      const inp=Array.from(document.querySelectorAll("input,select,textarea")).map(e=>({type:e.type||"",name:e.name||"",id:e.id||"",ph:e.placeholder||"",fc:e.getAttribute("formcontrolname")||"",vis:!!(e.offsetWidth||e.offsetHeight)})).filter(x=>x.type!=="hidden"&&x.vis);
      const btn=Array.from(document.querySelectorAll("button,[type=submit]")).map(e=>((e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,40))).filter(Boolean);
      const cap={recaptcha:/recaptcha/i.test(document.body.innerHTML),hcaptcha:/hcaptcha/i.test(document.body.innerHTML),turnstile:/turnstile|cf-chl/i.test(document.body.innerHTML),datadome:/datadome/i.test(document.body.innerHTML)};
      const otp=/otp|one[- ]?time|verification code|код подтвержд/i.test(document.body.innerText);
      const txt=document.body?document.body.innerText.replace(/\s+/g," ").slice(0,500):"";
      return {inp,btn,cap,otp,txt};
    });
    console.log("VISIBLE INPUTS:",JSON.stringify(form.inp,null,1));
    console.log("BUTTONS:",JSON.stringify(form.btn));
    console.log("CAPTCHA:",JSON.stringify(form.cap),"| OTP:",form.otp);
    console.log("TEXT(500):",form.txt);
    await page.screenshot({path:"/root/vfs-bot/recon_login2.png",fullPage:true}).catch(()=>{});
    console.log("screenshot → recon_login2.png");
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
