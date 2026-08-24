#!/usr/bin/env node
// Наблюдатель за разделом «Обучение» сканера (/scanner).
//
// Сотрудники правят распознанные поля и пишут комментарии — это готовый эталон:
// человек своими руками указал, как должно быть. Скрипт забирает правки с
// прод-сервера, показывает те, что ещё не разобраны, и умеет прогнать сканер
// по тем же снимкам, чтобы проверить, исправлено ли.
//
//   node tools/scannerLessons.js check     — новые правки (ничего не помечает)
//   node tools/scannerLessons.js regress   — прогон по снимкам с правками, сверка с эталоном
//   node tools/scannerLessons.js ack ID…   — пометить правки разобранными
//   node tools/scannerLessons.js ack --all — пометить разобранными все текущие
//
// Состояние (какие правки уже разобраны) лежит в .scannerLessonsSeen.json,
// он в .gitignore — это рабочий след, а не часть кода.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.VOYO_HOST || "root@89.108.88.59";
const DIR = process.env.VOYO_DIR || "/var/www/voyo";
const SEEN = path.join(__dirname, "..", ".scannerLessonsSeen.json");

function ssh(script) {
  return execFileSync("ssh", [HOST, "cd " + DIR + " && " + script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function seen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN, "utf8")).ids || []); } catch (_) { return new Set(); }
}
function saveSeen(set) {
  fs.writeFileSync(SEEN, JSON.stringify({ ids: Array.from(set), at: new Date().toISOString() }, null, 1));
}

// Правки и примеры обучения с прода в компактном виде.
function pull() {
  const out = ssh("node -e '" + [
    'const st=JSON.parse(require("fs").readFileSync(".scanner/store.json","utf8"));',
    'const docs=new Map((st.docs||[]).map(d=>[d.id,d]));',
    'const corr=(st.corrections||[]).map(c=>({id:c.id,at:c.at,by:c.by,file:c.file,docId:c.docId,',
    '  changed:(c.changed||[]).map(x=>({label:x.label,key:x.key,from:x.was,to:x.now})),comment:c.comment||"",',
    '  img:(docs.get(c.docId)||{}).imgFile||""}));',
    'const ex=(st.examples||[]).map(e=>({id:e.id,at:e.at,by:e.by,file:e.file,diff:e.diff||"",learned:e.learned||[]}));',
    'process.stdout.write(JSON.stringify({corrections:corr,examples:ex,lessons:(st.lessons||[]).map(l=>({id:l.id,text:l.text,by:l.by}))}));',
  ].join("") + "'");
  return JSON.parse(out);
}

const fmtDate = (t) => new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function cmdCheck() {
  const data = pull();
  const done = seen();
  const fresh = data.corrections.filter((c) => !done.has(c.id));
  const freshEx = data.examples.filter((e) => !done.has(e.id));
  if (!fresh.length && !freshEx.length) { console.log("НЕТ НОВЫХ ПРАВОК"); return; }
  console.log("НОВЫХ ПРАВОК: " + fresh.length + (freshEx.length ? ", примеров: " + freshEx.length : ""));
  for (const c of fresh) {
    console.log("\n[" + c.id + "] " + fmtDate(c.at) + " · " + (c.by || "?") + " · " + c.file + (c.img ? " · снимок " + c.img : " · снимок удалён"));
    for (const ch of c.changed) console.log("   " + ch.label + ": «" + ch.from + "» → «" + ch.to + "»");
    if (c.comment) console.log("   комментарий: " + c.comment);
  }
  for (const e of freshEx) {
    console.log("\n[" + e.id + "] пример обучения " + fmtDate(e.at) + " · " + (e.by || "?") + " · " + e.file);
    if (e.diff) console.log("   расхождения: " + e.diff);
  }
  console.log("\nвсего правил в памяти сканера: " + data.lessons.length);
}

// Прогон сканера по снимкам, которые правили, со сверкой по эталону сотрудника.
function cmdRegress() {
  const script = [
    'require("dotenv").config();const fs=require("fs");const s=require("./scanner.js");',
    'const st=JSON.parse(fs.readFileSync(".scanner/store.json","utf8"));',
    'const byId=new Map(st.docs.map(d=>[d.id,d]));const truth=new Map();',
    'for(const c of st.corrections||[]){const d=byId.get(c.docId);if(!d||!d.imgFile)continue;',
    '  if(!truth.has(c.docId))truth.set(c.docId,{img:d.imgFile,name:d.file,by:c.by,want:new Map()});',
    '  for(const ch of c.changed||[])truth.get(c.docId).want.set(ch.label,ch.now);}',
    'const key=l=>(s.FIELDS.find(f=>f.label===l)||{}).key;',
    '(async()=>{let ok=0,bad=0;const fails=[];',
    ' for(const [id,t] of truth){const p=".scanner/files/"+t.img;if(!fs.existsSync(p))continue;',
    '  let doc;try{doc=await s.recognizeOne(fs.readFileSync(p),t.name,/\\.png$/i.test(t.img)?"image/png":"image/jpeg",{by:"регресс"});}',
    '  catch(e){console.log(t.name+" — ошибка: "+e.message);continue;}',
    '  console.log("\\n"+t.name.slice(0,50)+"  (правил: "+(t.by||"?")+")");',
    '  for(const [label,want] of t.want){const k=key(label);if(!k)continue;',
    '   const got=String(doc.fields[k]||"");const norm=x=>String(x).replace(/\\s+/g," ").trim().toUpperCase();',
    '   const good=norm(got)===norm(want);if(good)ok++;else{bad++;fails.push(t.name+" · "+label+": «"+got+"» вместо «"+want+"»");}',
    '   console.log("  "+(good?"верно":"НЕВЕРНО")+" "+label+": "+(good?got:"«"+got+"» — надо «"+want+"»"));}}',
    ' console.log("\\n———\\nсовпало: "+ok+" из "+(ok+bad));',
    ' if(fails.length){console.log("осталось неверным:");fails.forEach(f=>console.log("  · "+f));}})();',
  ].join("");
  fs.writeFileSync("/tmp/scanner-regress.js", script);
  execFileSync("scp", ["/tmp/scanner-regress.js", HOST + ":/root/scanner-regress.js"], { stdio: "ignore" });
  process.stdout.write(ssh("cp /root/scanner-regress.js sregress.tmp.js && node sregress.tmp.js; rm -f sregress.tmp.js"));
}

function cmdAck(args) {
  const done = seen();
  if (args[0] === "--all") {
    const data = pull();
    data.corrections.forEach((c) => done.add(c.id));
    data.examples.forEach((e) => done.add(e.id));
  } else args.forEach((id) => done.add(id));
  saveSeen(done);
  console.log("разобранными помечено: " + done.size);
}

const cmd = process.argv[2] || "check";
try {
  if (cmd === "check") cmdCheck();
  else if (cmd === "regress") cmdRegress();
  else if (cmd === "ack") cmdAck(process.argv.slice(3));
  else { console.log("Команды: check | regress | ack ID… | ack --all"); process.exit(1); }
} catch (e) {
  console.log("ОШИБКА НАБЛЮДАТЕЛЯ: " + e.message.slice(0, 300));
  process.exit(2);
}
