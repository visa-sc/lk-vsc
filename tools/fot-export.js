// Односторонний канал снимков раздела «ФОТ» на рабочее место Кати Зайцевой.
//
// Прод Андрея раз в сутки кладёт готовые снимки в /var/www/kateadmin/data/fot/.
// Её портал читает их у себя и рисует свою копию раздела. Обратно ничего не ходит,
// её код и её процесс на прод не влияют. Второго обращения к amoCRM не возникает —
// мы копируем то, что и так посчитано ночным съёмом.
//
// Запуск: node tools/fot-export.js  (крон в 06:00 МСК, после ночных расчётов)
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");
const DST = "/var/www/kateadmin/data/fot";

const FILES = [
  [".vscStaffPerf.json", "staffPerf.json"],      // сотрудники: сделки, выручка, этапы, звонки
  [".lkCityRevenue.json", "cityRevenue.json"],   // объём и выручка месяца, разрез по городам
  [".vscCallStats.json", "callStats.json"],      // звонки по операторам из нот amoCRM
  [".vscLoadBase.json", "loadBase.json"],        // целевые контакты и звонки из листа /vsc
  [".vscZarplata.json", "zarplata.json"],        // разбор зарплатной таблицы по месяцам
  [".vscManagerPay.json", "managerPay.json"],    // ЗП управляющей, ручной ввод
  [".vscProfit.json", "profit.json"]             // прибыль по месяцам, ручной ввод
];

function main() {
  try { fs.mkdirSync(DST, { recursive: true }); } catch (e) { console.error("FOT EXPORT: не создать " + DST + ": " + e.message); return; }
  let ok = 0, skip = 0;
  FILES.forEach(([from, to]) => {
    const src = path.join(SRC, from);
    if (!fs.existsSync(src)) { skip++; return; }
    try {
      // Пишем через временный файл: читатель никогда не увидит половину снимка.
      const tmp = path.join(DST, to + ".tmp");
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, path.join(DST, to));
      ok++;
    } catch (e) { console.error("FOT EXPORT: " + from + " → " + to + ": " + e.message); }
  });
  try {
    fs.writeFileSync(path.join(DST, "README.txt"),
      "Снимки раздела «ФОТ» с прода voyotravel.ru. Обновляются раз в сутки в 06:00 МСК.\n"
      + "Канал односторонний: сюда только пишут, отсюда только читают.\n"
      + "Описание полей и логики — в FOT-HANDOFF.md рядом с пакетом передачи.\n"
      + "Последнее обновление: " + new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК\n", "utf8");
  } catch (_) {}
  console.log("FOT EXPORT: скопировано " + ok + ", пропущено (нет файла) " + skip);
}
main();
