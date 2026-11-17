// Завести партнёров eSIM пачкой (рассылка агентствам, 17.11.2026).
// Каждому: свой промокод (клиенту −100 ₽ на первую покупку, партнёру 15% со всех
// покупок приведённого клиента), кабинет voyomobile.ru/p/<слаг> с паролем.
// Условия те же, что у VisaZen. Кабинет начинает работать сразу, без перезапуска.
//
//   node tools/esimPartnersAdd.js <вход.json> [выход.json] [--dry]
//   вход: [{ "name": "Тур Мир", "email": "info@turmir.ru", "site": "turmir.ru" }, …]
//   выход: тот же список + code, slug, pass, link, cabinet (для писем и таблицы)
//
// Уже заведённого (по почте или слагу) второй раз не заводит, а отдаёт его данные.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, "..", ".esim");
const F = path.join(DIR, "promos.json");
const [inFile, outFile = "", flag = ""] = process.argv.slice(2).filter((a) => a !== "--dry").concat([]);
const DRY = process.argv.includes("--dry");
if (!inFile) { console.error("нужен файл со списком"); process.exit(1); }

const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const translit = (s) => String(s || "").toLowerCase().split("").map((c) => TR[c] != null ? TR[c] : c).join("");
// слаг — из домена сайта (узнаваемо для агентства), иначе из названия
function baseSlug(x) {
  let d = String(x.site || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  d = d.replace(/\.(ru|рф|com|net|org|su|travel|tours?|online|pro|info|biz|moscow|spb|xn--p1ai)$/i, "").replace(/\./g, "-");
  let s = translit(d || x.name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length < 3) s = translit(x.name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 24).replace(/-+$/, "") || "partner";
}

const list = JSON.parse(fs.readFileSync(inFile, "utf8"));
const all = JSON.parse(fs.readFileSync(F, "utf8"));
const bySlug = {}, byMail = {};
Object.keys(all).forEach((c) => {
  const p = all[c] && all[c].partner; if (!p) return;
  if (p.slug) bySlug[String(p.slug).toLowerCase()] = c;
  if (p.email) byMail[String(p.email).toLowerCase()] = c;
});
const out = [];
let added = 0;
for (const x of list) {
  const mail = String(x.email || "").trim().toLowerCase();
  let code = mail && byMail[mail];
  if (!code) {
    let slug, n = 1;
    // заранее назначенные код и слаг (очередь рассылки: таблички нарисованы заранее под этот код)
    if (x.code && x.slug && !all[String(x.code).toUpperCase()] && !bySlug[String(x.slug).toLowerCase()]) {
      slug = String(x.slug).toLowerCase(); code = String(x.code).toUpperCase();
    } else {
      slug = baseSlug(x);
      while (bySlug[slug] || slug === "visazen") slug = baseSlug(x).slice(0, 21) + "-" + (++n);
      code = slug.replace(/-/g, "").toUpperCase().slice(0, 16);
      let m = 1; while (all[code]) code = slug.replace(/-/g, "").toUpperCase().slice(0, 14) + (++m);
    }
    const pass = String(crypto.randomInt(100000, 999999));
    all[code] = {
      rub: 0, pct: 0, firstOnly: false, oncePerUser: true, active: true, uses: 0, maxUses: null, from: null, to: null,
      partner: { name: x.name, slug, pass, pct: 15, bonusRub: 0, discountRub: 100, email: mail || null, site: x.site || null, kind: x.kind || null },
      note: "Партнёр из рассылки агентствам 11.2026" + (x.kind ? " (" + x.kind + ")" : "") + ": клиенту −100 ₽ на первую покупку, партнёру 15% со всех покупок",
      ts: Date.now(),
    };
    bySlug[slug] = code; if (mail) byMail[mail] = code; added++;
  }
  const p = all[code].partner;
  out.push(Object.assign({}, x, { code, slug: p.slug, pass: p.pass, preCode: x.code || null,
    link: "https://voyomobile.ru/?promo=" + code,
    cabinet: "https://voyomobile.ru/p/" + p.slug,
    cabinetAuto: "https://voyomobile.ru/p/" + p.slug + "#k=" + p.pass }));
}
if (!DRY && added) {
  fs.copyFileSync(F, F + ".bak-partners-" + Date.now());
  // перечитываем перед записью: сервер мог за это время отметить применение кода
  const fresh = JSON.parse(fs.readFileSync(F, "utf8"));
  out.forEach((o) => { if (!fresh[o.code]) fresh[o.code] = all[o.code]; });
  fs.writeFileSync(F, JSON.stringify(fresh, null, 1), "utf8");
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 1), "utf8");
console.log((DRY ? "[проверка] " : "") + "новых партнёров: " + added + ", всего в списке: " + out.length);
if (!outFile) console.log(JSON.stringify(out, null, 1));
