// ═══════════════════════════════════════════════════════════════════════════
// Поиск страны для eSIM — один на витрину (public/esim.html) и телеграм-бот
// (tgbot.js), чтобы оба понимали человека одинаково. Появился 15.09.2026.
//
// Находит страну, как бы её ни набрали:
//   • по-русски и через синонимы: «Китай», «Америка», «Эмираты», «Тайланд»;
//   • в английской раскладке вместо русской: «rbnfq» → Китай;
//   • в русской раскладке вместо английской: «сршты» → China → Китай;
//   • по-английски: «China», «Italy», «Turkey»;
//   • транслитом: «kitay», «italiya», «turciya», «yaponiya»;
//   • с одной опечаткой в словах от пяти букв: «итлаия».
//
// Английские и русские названия берутся из Intl.DisplayNames для всех стран
// сразу, поэтому новые страны в каталоге ищутся без правки этого файла.
// Синонимы ниже — только то, что встроенные названия не покрывают.
//
// Путь файла выбран под правило сайтов eSIM в server.js: на esim.voyotravel.ru
// и voyomobile.* пропускаются только адреса, начинающиеся с /esim или /esim_.
// ═══════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EsimCountrySearch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Как люди на самом деле называют страны: города и курорты вместо стран,
  // разговорные и старые названия. Английские официальные названия и русские
  // из Intl здесь повторять не нужно.
  var ALIAS = {
    "US": "сша америка соединенные штаты штаты нью-йорк майами usa america states",
    "AE": "оаэ эмираты арабские дубай абу-даби шарджа uae dubai emirates",
    "GB": "великобритания англия британия лондон шотландия uk britain england london",
    "KR": "южная корея корея сеул korea seoul",
    "KP": "северная корея кндр",
    "CZ": "чехия прага czech czechia prague",
    "TR": "турция стамбул анталия анталья кемер алания бодрум turkey turkiye istanbul antalya",
    "TH": "таиланд тайланд бангкок пхукет самуи паттайя thailand phuket bangkok",
    "ES": "испания барселона мадрид тенерифе майорка канары spain barcelona",
    "IT": "италия рим милан венеция сицилия italy rome",
    "FR": "франция париж ницца france paris",
    "DE": "германия берлин мюнхен germany berlin",
    "GR": "греция афины крит родос greece crete",
    "EG": "египет хургада шарм шарм-эль-шейх каир egypt hurghada",
    "CN": "китай пекин шанхай хайнань санья гуанчжоу china beijing shanghai",
    "JP": "япония токио киото japan tokyo",
    "VN": "вьетнам нячанг фукуок дананг ханой vietnam",
    "GE": "грузия тбилиси батуми georgia tbilisi batumi",
    "AM": "армения ереван armenia yerevan",
    "AZ": "азербайджан баку azerbaijan baku",
    "RS": "сербия белград serbia belgrade",
    "ME": "черногория будва montenegro",
    "CY": "кипр ларнака лимассол пафос cyprus",
    "IL": "израиль тель-авив иерусалим israel",
    "IN": "индия гоа дели india goa",
    "ID": "индонезия бали джакарта indonesia bali",
    "MV": "мальдивы maldives",
    "LK": "шри-ланка шриланка цейлон sri lanka srilanka ceylon",
    "KZ": "казахстан алматы астана kazakhstan almaty",
    "UZ": "узбекистан ташкент самарканд uzbekistan",
    "KG": "киргизия кыргызстан бишкек kyrgyzstan",
    "BY": "беларусь белоруссия минск belarus minsk",
    "MD": "молдова молдавия кишинев moldova",
    "PT": "португалия лиссабон мадейра portugal lisbon",
    "NL": "нидерланды голландия амстердам netherlands holland amsterdam",
    "AT": "австрия вена austria vienna",
    "CH": "швейцария цюрих женева switzerland",
    "PL": "польша варшава краков poland",
    "HU": "венгрия будапешт hungary budapest",
    "FI": "финляндия хельсинки finland",
    "SE": "швеция стокгольм sweden",
    "NO": "норвегия осло norway",
    "DK": "дания копенгаген denmark",
    "HR": "хорватия сплит дубровник croatia",
    "BG": "болгария варна бургас bulgaria",
    "RO": "румыния romania",
    "AL": "албания albania",
    "MX": "мексика канкун mexico cancun",
    "BR": "бразилия рио brazil",
    "AR": "аргентина argentina",
    "CA": "канада торонто canada",
    "AU": "австралия сидней australia sydney",
    "NZ": "новая зеландия зеландия new zealand",
    "ZA": "юар южная африка south africa",
    "MA": "марокко marrakech morocco",
    "TN": "тунис tunisia",
    "QA": "катар доха qatar doha",
    "SA": "саудовская аравия саудовская saudi arabia",
    "OM": "оман oman",
    "BH": "бахрейн bahrain",
    "KW": "кувейт kuwait",
    "JO": "иордания акаба jordan",
    "SG": "сингапур singapore",
    "MY": "малайзия куала-лумпур лангкави malaysia",
    "PH": "филиппины боракай philippines",
    "HK": "гонконг hongkong hong kong",
    "MO": "макао macau macao",
    "TW": "тайвань taiwan",
    "KH": "камбоджа cambodia",
    "LA": "лаос laos",
    "MN": "монголия mongolia",
    "TZ": "танзания занзибар zanzibar tanzania",
    "KE": "кения kenya",
    "SC": "сейшелы сейшельские seychelles",
    "MU": "маврикий mauritius",
    "CU": "куба гавана cuba",
    "DO": "доминикана доминиканская пунта-кана dominican",
    "US-HI": "гавайи hawaii",
    "EU-REGION": "европа европу европе шенген евросоюз europe schengen eu",
  };

  // Раскладки: те же клавиши в русской и английской раскладке
  var EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
  var RU = "йцукенгшщзхъфывапролджэячсмитьбюё";
  var EN_RU = {}, RU_EN = {};
  for (var i = 0; i < EN.length; i++) { EN_RU[EN[i]] = RU[i]; RU_EN[RU[i]] = EN[i]; }
  function swap(s, map) { var o = ""; for (var j = 0; j < s.length; j++) o += map[s[j]] || s[j]; return o; }

  // Кириллица в латиницу: одинаково для названий и для запроса
  var TR = { "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z", "и": "i", "й": "y",
    "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
    "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya" };

  function norm(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[.,'’"«»()]/g, " ")
      .replace(/[-‐–—_]/g, " ").replace(/\s+/g, " ").trim();
  }
  // Звуковой «скелет» латиницы: сводит к одному виду italiya/italia/italy,
  // kitay/kitaj/kitai, turciya/turtsiya, thailand/tailand, kazakhstan/kazahstan.
  function skel(s) {
    var t = "";
    s = norm(s);
    for (var j = 0; j < s.length; j++) t += (TR[s[j]] !== undefined ? TR[s[j]] : s[j]);
    return t.replace(/[^a-z]/g, "")
      .replace(/shch/g, "sh").replace(/sch/g, "sh").replace(/tch/g, "ch")
      .replace(/kh/g, "h").replace(/ph/g, "f").replace(/th/g, "t").replace(/gh/g, "g")
      .replace(/tz|ts/g, "c").replace(/ck/g, "k").replace(/x/g, "ks").replace(/q/g, "k").replace(/w/g, "v")
      .replace(/(iya|ija|iia|ia|ya|ja)/g, "ia").replace(/(yu|ju|iu)/g, "iu").replace(/(yo|jo|io)/g, "io")
      .replace(/ey$|ay$|ai$|aj$/g, "ai").replace(/[yj]/g, "i").replace(/ee/g, "i")
      .replace(/(.)\1+/g, "$1");
  }

  var dnRu = null, dnEn = null;
  try { dnRu = new Intl.DisplayNames(["ru"], { type: "region" }); } catch (e) {}
  try { dnEn = new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) {}
  function intlName(dn, iso) { try { return (dn && /^[A-Z]{2}$/.test(iso) && dn.of(iso)) || ""; } catch (e) { return ""; } }

  // Одна опечатка (замена, пропуск, лишняя буква или перестановка соседних)
  function oneTypo(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; }
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }

  // Слова и скелеты для одной страны. Кэш: на витрине список не меняется.
  var cache = {};
  function keysOf(iso, name) {
    var k = iso + "|" + name;
    if (cache[k]) return cache[k];
    var names = [name, intlName(dnRu, iso), intlName(dnEn, iso)].map(norm).filter(Boolean);
    var words = names.slice();
    names.forEach(function (n) { n.split(" ").forEach(function (w) { if (w.length > 2) words.push(w); }); });
    String(ALIAS[iso] || "").split(" ").forEach(function (w) { if (w) words.push(norm(w)); });
    var uniq = {};
    words.forEach(function (w) { uniq[w] = 1; });
    words = Object.keys(uniq);
    return (cache[k] = { primary: names, words: words, skels: words.map(skel) });
  }

  // Варианты запроса: как набрал, в другой раскладке, без пробелов
  function queryVariants(query) {
    var q = norm(query), out = [q];
    if (/[a-z]/.test(q)) out.push(swap(q, EN_RU));
    if (/[а-яе]/.test(q)) out.push(swap(q, RU_EN));
    out.push(q.replace(/ /g, ""));
    var uniq = {};
    return out.filter(function (v) { if (!v || uniq[v]) return false; uniq[v] = 1; return true; });
  }

  // Оценка совпадения: чем меньше, тем выше в выдаче. null — не подходит.
  function score(keys, variants) {
    var best = null;
    function take(s) { if (best === null || s < best) best = s; }
    variants.forEach(function (v, vi) {
      var shift = vi === 0 ? 0 : 1;                       // своя раскладка чуть выше чужой
      var sv = skel(v);
      keys.primary.forEach(function (n) {
        if (n === v) take(0 + shift);
        else if (n.indexOf(v) === 0) take(2 + shift);
      });
      keys.words.forEach(function (w) {
        if (w === v) take(1 + shift);
        else if (w.indexOf(v) === 0) take(3 + shift);
      });
      if (sv.length >= 3) keys.skels.forEach(function (s) {
        if (s === sv) take(4 + shift);
        else if (sv.length >= 4 && s.indexOf(sv) === 0) take(5 + shift);
        else if (sv.length >= 5 && (oneTypo(s, sv) || oneTypo(s.slice(0, sv.length), sv))) take(7 + shift);
      });
      if (v.length >= 3) keys.primary.forEach(function (n) { if (n.indexOf(" " + v) > 0) take(6 + shift); });
    });
    return best;
  }

  // list: [{iso, name, ...}] — возвращает те же объекты в порядке уместности.
  // opts.withScore: вернуть [{item, score}] — боту, чтобы сразу открыть страну,
  // если лучшее совпадение явно лучше остальных.
  function search(list, query, opts) {
    var variants = queryVariants(query);
    if (!variants.length || norm(query).length < 2) return [];
    var hits = [];
    (list || []).forEach(function (item, idx) {
      if (!item || !item.iso) return;
      var s = score(keysOf(item.iso, item.name || ""), variants);
      if (s !== null) hits.push({ item: item, s: s, idx: idx });
    });
    hits.sort(function (a, b) { return a.s - b.s || (b.item.count || 0) - (a.item.count || 0) || a.idx - b.idx; });
    // Есть уверенное совпадение — не мешаем ему случайными: «сша» не должна тянуть
    // Китай через «шанхай», «japan» не должна подмешивать Испанию как опечатку.
    if (hits.length) {
      var best = hits[0].s;
      hits = hits.filter(function (h) { return best <= 4 ? h.s < 6 || h.s <= best + 1 : (best <= 6 ? h.s < 7 || h.s <= best + 1 : true); });
    }
    return hits.map(function (h) { return opts && opts.withScore ? { item: h.item, score: h.s } : h.item; });
  }

  return { search: search, norm: norm, skel: skel, ALIAS: ALIAS };
});
