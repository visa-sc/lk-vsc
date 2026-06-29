// VFS /login через ЧИСТЫЙ резидентский IP (proxy-seller) в HEADFUL-режиме (Xvfb),
// БЕЗ CapSolver — даём управляемому Cloudflare-челленджу раскрутиться самому на
// каждом шаге (home → interim → /login). Цель: пройдёт ли чистый IP+headful нативно.
require("dotenv").config();
const { chromium } = require("patchright");
const PROXY = process.env.PROXY_URL || process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", HOME = BASE + "/", INTERIM = BASE + "/interim", LOGIN = BASE + "/login";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function challenged(page){ try{ const t=await page.evaluate(()=>document.body?document.body.innerText:""); return /проверки безопасности|checking your browser|just a moment|verifying you are human|вредоносных ботов|Ray ID/i.test(t||""); }catch(e){return false;} }
async function waitClear(page,label,tries){ for(let i=0;i<tries;i++){ if(!(await challenged(page))) return true; console.log("  "+label+": CF держится, ждём ("+(i+1)+")"); await page.waitForTimeout(5000);} return !(await challenged(page)); }
(async()=>{
  if(!PROXY){console.error("нет прокси");process.exit(0);}
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:false, proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass}, args:["--no-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled","--start-maximized"]});
  const ctx=await browser.newContext({locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:900}});
  const page=await ctx.newPage();
  try{
    await page.goto(HOME,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("home goto:",e.message));
    await page.waitForTimeout(4000);
    console.log("HOME clear:", await waitClear(page,"home",8), "| url:", page.url());
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("interim goto:",e.message));
    await page.waitForTimeout(3000);
    console.log("INTERIM clear:", await waitClear(page,"interim",8));
    const cb=await page.$("#onetrust-accept-btn-handler"); if(cb){await cb.click().catch(()=>{}); await page.waitForTimeout(1500);}
    const vm=await page.$$("text=/view more/i");
    for(let i=0;i<vm.length;i++){ try{ await vm[i].scrollIntoViewIfNeeded(); await vm[i].click({timeout:5000}); await page.waitForTimeout(1600);}catch(e){} }
    await page.waitForTimeout(2000);
    let acc=await page.$('a[href$="/login"]');
    if(acc){ await acc.scrollIntoViewIfNeeded().catch(()=>{}); await acc.click().catch(e=>console.log("accept click:",e.message)); }
    else { await page.goto(LOGIN,{waitUntil:"domcontentloaded",timeout:60000}).catch(()=>{}); }
    await page.waitForTimeout(6000);
    const loginOk = await waitClear(page,"login",12); // до 60с на раскрутку CF
    console.log("LOGIN clear:", loginOk, "| url:", page.url());
    const form=await page.evaluate(()=>{
      const inp=Array.from(document.querySelectorAll("input,select,textarea")).map(e=>({type:e.type||"",name:e.name||"",id:e.id||"",ph:e.placeholder||"",fc:e.getAttribute("formcontrolname")||"",vis:!!(e.offsetWidth||e.offsetHeight)})).filter(x=>x.type!=="hidden"&&x.vis);
      const btn=Array.from(document.querySelectorAll("button,[type=submit]")).map(e=>((e.innerText||e.value||"").trim().replace(/\s+/g," ").slice(0,40))).filter(Boolean);
      const cap={recaptcha:/recaptcha/i.test(document.body.innerHTML),hcaptcha:/hcaptcha/i.test(document.body.innerHTML),turnstile:/turnstile|cf-chl/i.test(document.body.innerHTML),datadome:/datadome/i.test(document.body.innerHTML)};
      const txt=document.body?document.body.innerText.replace(/\s+/g," ").slice(0,500):"";
      return {inp,btn,cap,txt};
    });
    console.log("VISIBLE INPUTS:",JSON.stringify(form.inp,null,1));
    console.log("BUTTONS:",JSON.stringify(form.btn));
    console.log("CAPTCHA:",JSON.stringify(form.cap));
    console.log("TEXT(500):",form.txt);
    await page.screenshot({path:"/root/vfs-bot/recon_login3.png",fullPage:true}).catch(()=>{});
    console.log("screenshot → recon_login3.png");
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
