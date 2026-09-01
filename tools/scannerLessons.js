#!/usr/bin/env node
// Наблюдатель за разделом «Обучение» сканера (/scanner).
//
// Сотрудники правят распознанные поля и пишут комментарии — это готовый эталон:
// человек своими руками указал, как должно быть. Скрипт забирает правки с
// прод-сервера, показывает те, что ещё не разобраны, и умеет прогнать сканер
// по тем же снимкам, чтобы проверить, исправлено ли.
//
//   node tools/scannerLessons.js check     — новые правки (ничего не помечает)
//   node tools/scannerLessons.js replay    — БЕСПЛАТНАЯ проверка: разбор гоняется
//                                            заново по сохранённым ответам модели,
//                                            к ИИ не обращается, API-баланс не тратит
//   node tools/scannerLessons.js regress   — платный прогон по самим снимкам (~10 ₽),
//                                            только когда без него никак
//   node tools/scannerLessons.js try ФАЙЛ [rf] — прогнать один снимок МИМО журнала
//                                            (rf — как внутренний паспорт)
//                                            (в историю и дашборд не попадёт)
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

// Бесплатная проверка: берём сохранённые сырые ответы модели (doc.raw) и
// прогоняем по ним ТОЛЬКО наш разбор — сверку с MRZ, транслитерацию, даты,
// код подразделения. К ИИ не обращаемся ни разу, денег с баланса не уходит.
// Проверяет ровно ту часть, где живут почти все доработки; чтение снимка
// моделью так не проверить — для этого есть платный regress.
function cmdReplay() {
  const script = [
    'const fs=require("fs");const s=require("./scanner.js");',
    'const st=JSON.parse(fs.readFileSync(".scanner/store.json","utf8"));',
    'const byId=new Map(st.docs.map(d=>[d.id,d]));const truth=new Map();',
    'for(const c of st.corrections||[]){const d=byId.get(c.docId);if(!d)continue;',
    '  if(!truth.has(c.docId))truth.set(c.docId,{doc:d,by:c.by,want:new Map()});',
    '  for(const ch of c.changed||[])truth.get(c.docId).want.set(ch.label,ch.now);}',
    'const AF=s.FIELDS.concat(s.FIELDS_RF||[],s.FIELDS_RF_REG||[]);const key=l=>(AF.find(f=>f.label===l)||{}).key;',
    'let ok=0,bad=0,noraw=0;const fails=[];',
    'for(const [id,t] of truth){const d=t.doc;',
    ' if(!d.raw||!d.raw.ai){noraw++;continue;}',
    ' let r;',
    ' if(d.rf){const mrz=s.parseMrzRf(d.raw.ai.mrz_line1,d.raw.ai.mrz_line2);r=s.buildFieldsRf(d.raw.ai,mrz);}',
    ' else{const mrz=d.raw.mrz?s.parseMrzTd3(d.raw.mrz.line1,d.raw.mrz.line2):s.parseMrzTd3(d.raw.ai.mrz_line1,d.raw.ai.mrz_line2);r=s.buildFields(d.raw.ai,mrz,d.raw.alt);}',
    ' console.log("\\n"+String(d.file).slice(0,50)+"  (правил: "+(t.by||"?")+")");',
    ' for(const [label,want] of t.want){const k=key(label);if(!k)continue;',
    '  const got=String(r.fields[k]||"");const norm=x=>String(x).replace(/\\s+/g," ").trim().toUpperCase();',
    '  const good=norm(got)===norm(want);if(good)ok++;else{bad++;fails.push(String(d.file)+" · "+label+": «"+got+"» вместо «"+want+"»");}',
    '  console.log("  "+(good?"верно":"НЕВЕРНО")+" "+label+": "+(good?got:"«"+got+"» — надо «"+want+"»"));}}',
    'console.log("\\n———\\nсовпало: "+ok+" из "+(ok+bad)+(noraw?"  (без сохранённого ответа модели, пропущено документов: "+noraw+")":""));',
    'if(fails.length){console.log("осталось неверным:");fails.forEach(f=>console.log("  · "+f));}',
  ].join("");
  fs.writeFileSync("/tmp/scanner-replay.js", script);
  execFileSync("scp", ["/tmp/scanner-replay.js", HOST + ":/root/scanner-replay.js"], { stdio: "ignore" });
  process.stdout.write(ssh("cp /root/scanner-replay.js sreplay.tmp.js && node sreplay.tmp.js; rm -f sreplay.tmp.js"));
}

// Прогон сканера по снимкам, которые правили, со сверкой по эталону сотрудника.
function cmdRegress() {
  const script = [
    'require("dotenv").config();const fs=require("fs");const s=require("./scanner.js");',
    'const st=JSON.parse(fs.readFileSync(".scanner/store.json","utf8"));',
    'const byId=new Map(st.docs.map(d=>[d.id,d]));const truth=new Map();',
    'for(const c of st.corrections||[]){const d=byId.get(c.docId);if(!d||!d.imgFile)continue;',
    '  if(!truth.has(c.docId))truth.set(c.docId,{img:d.imgFile,name:d.file,by:c.by,rf:!!d.rf,want:new Map()});',
    '  for(const ch of c.changed||[])truth.get(c.docId).want.set(ch.label,ch.now);}',
    'const AF=s.FIELDS.concat(s.FIELDS_RF||[],s.FIELDS_RF_REG||[]);const key=l=>(AF.find(f=>f.label===l)||{}).key;',
    '(async()=>{let ok=0,bad=0;const fails=[];',
    ' for(const [id,t] of truth){const p=".scanner/files/"+t.img;if(!fs.existsSync(p))continue;',
    '  let doc;try{doc=await (t.rf?s.recognizeRf:s.recognizeOne)(fs.readFileSync(p),t.name,/\\.png$/i.test(t.img)?"image/png":"image/jpeg",{by:"регресс"});}',
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

// Проверка снимка в обход журнала: зовём распознавание напрямую, запись в
// историю делает не оно, а маршрут /scanner/api/parse. Так мои проверки больше
// не подмешиваются к работе сотрудников и не портят дашборд.
function cmdTry(args) {
  const img = args[0];
  if (!img) { console.log("нужно имя файла из .scanner/files"); return; }
  const script = [
    'require("dotenv").config();const fs=require("fs");const s=require("./scanner.js");',
    'const p=".scanner/files/" + process.argv[2];',
    'const mime=/[.]png$/i.test(p)?"image/png":/[.]pdf$/i.test(p)?"application/pdf":"image/jpeg";',
    'const rf=process.argv[3]==="rf";',
    '(async()=>{const d=await (rf?s.recognizeRf:s.recognizeOne)(fs.readFileSync(p),process.argv[2],mime,{by:"проверка"});',
    ' const f=d.fields;const rub=(d.spend||[]).reduce((a,e)=>a+((e.in||0)*1+(e.out||0)*5)/1e6,0)*80;',
    ' console.log(f.surnameRu,f.nameRu,f.patronymicRu,"|",f.surnameLat,f.nameLat);',
    ' console.log("серия и номер:",f.number,"| выдан:",f.issueDate,f.authority,"| место рожд.:",f.birthPlace);',
    ' console.log("запросов:",(d.spend||[]).length,"| ~"+rub.toFixed(2)+" руб |",(d.ms/1000).toFixed(1)+"с |",d.model);',
    ' (d.warnings||[]).forEach(w=>console.log("  ·",w.slice(0,150)));})();',
  ].join("");
  fs.writeFileSync("/tmp/scanner-try.js", script);
  execFileSync("scp", ["/tmp/scanner-try.js", HOST + ":/root/scanner-try.js"], { stdio: "ignore" });
  process.stdout.write(ssh("cp /root/scanner-try.js stry.tmp.js && node stry.tmp.js " + JSON.stringify(img) + (args[1] === "rf" ? " rf" : "") + "; rm -f stry.tmp.js"));
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
  else if (cmd === "replay") cmdReplay();
  else if (cmd === "try") cmdTry(process.argv.slice(3));
  else if (cmd === "regress") cmdRegress();
  else if (cmd === "ack") cmdAck(process.argv.slice(3));
  else { console.log("Команды: check | regress | ack ID… | ack --all"); process.exit(1); }
} catch (e) {
  console.log("ОШИБКА НАБЛЮДАТЕЛЯ: " + e.message.slice(0, 300));
  process.exit(2);
}
