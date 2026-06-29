// Достаём параметры Cloudflare-Turnstile со страницы /login, чтобы понять, применим
// ли метод CapSolver "AntiTurnstileTask" (нужен sitekey). Доходим до /login через
// CapSolver-клиренс (interim) + клик, затем читаем DOM челленджа (sitekey/iframe/cf).
require("dotenv").config();
const { chromium } = require("patchright");
const KEY = process.env.CAPSOLVER_KEY, PROXY = process.env.PROXY_URL || process.env.MOBILE_PROXY;
const BASE = "https://visa.vfsglobal.com/rus/en/fra", LOGIN = BASE + "/login", INTERIM = BASE + "/interim";
function pp(s){const m=String(s||"").match(/^(https?):\/\/(?:([^:@]+):([^@]+)@)?([^:\/]+):(\d+)/);return m?{scheme:m[1],host:m[4],port:m[5],user:m[2],pass:m[3]}:null;}
async function post(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();}
async function capsolve(t){const p=pp(PROXY);const c=await post("https://api.capsolver.com/createTask",{clientKey:KEY,task:{type:"AntiCloudflareTask",websiteURL:t,proxy:p.scheme+":"+p.host+":"+p.port+":"+p.user+":"+p.pass}});if(c.errorId)throw new Error(c.errorDescription);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const res=await post("https://api.capsolver.com/getTaskResult",{clientKey:KEY,taskId:c.taskId});if(res.status==="ready")return res.solution;if(res.status==="failed"||res.errorId)throw new Error(res.errorDescription);}throw new Error("timeout");}
function cookiesFrom(sol){const ck=[];if(Array.isArray(sol.cookies))for(const c of sol.cookies)ck.push({name:c.name,value:String(c.value),domain:c.domain||"visa.vfsglobal.com",path:c.path||"/",secure:true});return ck;}
async function killCookie(page){ try{ await page.evaluate(()=>{ document.querySelectorAll('#onetrust-consent-sdk,#onetrust-banner-sdk,.onetrust-pc-dark-filter').forEach(e=>e.remove()); }); }catch(e){} }
(async()=>{
  if(!KEY||!PROXY){console.error("нет ключа/прокси");process.exit(0);}
  let sol;try{sol=await capsolve(LOGIN);}catch(e){console.error("CAPSOLVER ERROR:",e.message);process.exit(0);}
  const ua=sol.userAgent||undefined; console.log("CF решён (interim).");
  const p=pp(PROXY);
  const browser=await chromium.launch({headless:true,proxy:{server:"http://"+p.host+":"+p.port,username:p.user,password:p.pass},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const ctx=await browser.newContext({userAgent:ua,locale:"ru-RU",timezoneId:"Europe/Moscow",viewport:{width:1366,height:900}});
  try{await ctx.addCookies(cookiesFrom(sol));}catch(e){}
  const page=await ctx.newPage();
  try{
    await page.goto(INTERIM,{waitUntil:"domcontentloaded",timeout:90000}).catch(e=>console.log("goto:",e.message));
    await page.waitForTimeout(9000); await killCookie(page);
    const vm=await page.$$("text=/view more/i"); for(let i=0;i<vm.length;i++){try{await vm[i].click({timeout:5000});await page.waitForTimeout(1500);}catch(e){}}
    await page.waitForTimeout(1500); await killCookie(page);
    let acc=await page.$('a[href$="/login"]'); if(acc){await acc.click().catch(()=>{});} else {await page.goto(LOGIN,{waitUntil:"domcontentloaded",timeout:60000}).catch(()=>{});}
    await page.waitForTimeout(12000);
    console.log("URL:",page.url());
    const info=await page.evaluate(()=>{
      const html=document.documentElement.outerHTML;
      const ds=document.querySelector('[data-sitekey]');
      const m=html.match(/sitekey["'\s:=]+([0-9A-Za-z_\-]{18,})/i);
      const iframes=Array.from(document.querySelectorAll('iframe')).map(f=>f.src).filter(Boolean);
      const cfParams = (window.__CF$cv$params)||null;
      return {
        title: document.title,
        bodyText: (document.body?document.body.innerText:"").replace(/\s+/g," ").slice(0,200),
        dataSitekey: ds?ds.getAttribute('data-sitekey'):null,
        sitekeyInHtml: m?m[1]:null,
        cfTurnstileScript: /challenges\.cloudflare\.com\/turnstile/.test(html),
        cfChallengePlatform: /cdn-cgi\/challenge-platform/.test(html),
        cfParams: cfParams?Object.keys(cfParams):null,
        iframes: iframes
      };
    });
    console.log("CHALLENGE INFO:", JSON.stringify(info,null,1));
  }catch(e){console.error("NAV ERROR:",e.message);}
  finally{await browser.close();}
})();
