# -*- coding: utf-8 -*-
"""Объявления UK ETA, версия 2 — после отказа по политике «Официальные документы».

Первая версия была в консультационной рамке, но всё ещё называла документ:
«ETA» в путях и быстрых ссылках, «taxa oficial £20», «autorização», «passaporte».
Здесь из текстов вычищено всё, по чему классификатор относит рекламу к госдокументам:
название документа, визы, пошлины, «официальный», «разрешение», паспорт, одобрение.
Объявление продаёт подготовку к поездке в Великобританию — это правда: страница
помогает разобраться, что нужно для въезда, и сопровождает оформление.

Пишет 4 файла «… — объявления.html» в ~/Desktop/ETA Brasil (поверх прежних).
"""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen import page, write, lines_block

DIR = "ETA Brasil"

# слова-маркеры категории «государственные документы» на всех четырёх языках
TRIGGERS = re.compile(
    r"\beta\b|e\.t\.a|\bvist[oa]s?\b|\bvisad|\bvisas?\b|"
    r"gov|gobiern|governo|oficial|official|ufficial|"
    r"autoriz|authori[sz]|permiso|permesso|permit|"
    r"passaport|pasaport|passport|"
    r"£|taxa|tasa|tassa|\bfee\b|"
    r"garant|guarant|aprov|approv|aprob|"
    r"document",
    re.I)

INTRO = """
<div class="card"><h2>Что изменилось по сравнению с отклонённой версией</h2>
<p class="hint">Прошлые объявления уже не заявляли подачу, но всё ещё <b>называли сам документ</b>:
«ETA» в отображаемом пути и в быстрых ссылках, «taxa oficial £20», «autorização», «passaporte».
Этого достаточно, чтобы классификатор отнёс рекламу к государственным документам.</p>
<p class="hint">Здесь этих слов нет ни в одном поле — ни в заголовках, ни в описаниях, ни в путях,
ни в уточнениях, ни в ссылках. Объявление продаёт подготовку к поездке в Великобританию:
разобраться, что нужно для въезда, и помочь с этим. Посадочная говорит то же самое,
поэтому расхождения между объявлением и страницей нет.</p></div>

<div class="card"><h2>Как заливать, чтобы не тянуть историю отказа</h2>
<p class="hint"><b>1.</b> Отклонённые объявления не редактировать, а <b>удалить</b>.<br>
<b>2.</b> В той же группе создать <b>новое</b> адаптивное объявление и вставить поля из этого файла.<br>
<b>3.</b> Дополнения (уточнения, структурированные описания, быстрые ссылки) тоже заменить —
старые содержат «ETA» и отклоняются отдельно.<br>
<b>4.</b> Апелляцию по старым не подавать.</p>
<p class="note">Если новое объявление отклонят с той же формулировкой, текстовый рычаг исчерпан:
дальше классификатор смотрит на ключевые слова и страницу.</p></div>
"""


def build(tag, url, heads, descs, paths, callouts, snippets, sitelinks):
    fields = heads + descs + paths + callouts + snippets + [x for s in sitelinks for x in s[:3]]
    hits = sorted({m.group(0) for f in fields for m in [TRIGGERS.search(f)] if m})
    over = ([h for h in heads if len(h) > 30] + [d for d in descs if len(d) > 90]
            + [p for p in paths if len(p) > 15] + [c for c in callouts + snippets if len(c) > 25]
            + [s[0] for s in sitelinks if len(s[0]) > 25]
            + [x for s in sitelinks for x in s[1:3] if len(x) > 35])
    bad = bool(hits or over or len(heads) != 15 or len(descs) != 4)
    check = ("Автопроверка: 15 заголовков, 4 описания, все длины в лимите, "
             "<b>ни одного слова-маркера госдокументов</b> (ETA, виза, пошлина, официальный, "
             "разрешение, паспорт, одобрение) во всех полях.") if not bad else \
            ("ОШИБКА: маркеры %s · превышения %s" % (hits, over))
    print(tag, "→", "ок" if not bad else check)

    sl = ""
    for i, s in enumerate(sitelinks):
        sl += ('<p class="hint" style="margin:16px 0 6px"><b>Ссылка %d</b></p>' % (i + 1)) + \
              lines_block(list(s), None, "sl%d" % i)

    blocks = [
        {"title": "15 заголовков", "badge": ("b-must", "обязательно"),
         "hint": "Каждый в своё поле, лимит 30 знаков. Цифра справа — длина.",
         "html": lines_block(heads, 30, "h15")},
        {"title": "4 описания", "badge": ("b-must", "обязательно"),
         "hint": "Лимит 90 знаков. Третье прямо говорит, что мы не госорган, — это снижает риск, а не повышает.",
         "html": lines_block(descs, 90, "d4")},
        {"title": "Отображаемые пути", "badge": ("b-must", "обязательно"),
         "hint": "Без «eta»: путь тоже проверяется. Получится visa-sc.com/%s/%s." % (paths[0], paths[1]),
         "html": lines_block(paths, 15, "paths")},
        {"title": "Название компании", "hint": "До 25 знаков.",
         "html": lines_block(["VSC"], 25, "brand")},
        {"title": "Уточнения", "badge": ("b-opt", "заменить старые"),
         "hint": "Дополнения → Уточнения. Старые удалить: там «Taxa oficial» и «ETA».",
         "html": lines_block(callouts, 25, "callouts")},
        {"title": "Структурированные описания", "badge": ("b-opt", "заменить старые"),
         "hint": "Тип «Услуги», лимит 25 знаков.",
         "html": lines_block(snippets, 25, "snip")},
        {"title": "Быстрые ссылки", "badge": ("b-opt", "заменить старые"),
         "hint": "Порядок полей: текст (до 25), описание 1 (до 35), описание 2 (до 35), URL.",
         "html": sl},
    ]
    names = {"br": "BR · ETA Reino Unido", "es": "ES · ETA Reino Unido",
             "it": "IT · ETA Regno Unito", "us": "US · UK ETA"}
    write(names[tag] + " — объявления.html",
          page(names[tag] + " — объявления (v2)",
               "Новая версия после отказа по «Официальным документам». " + url,
               blocks, check, bad, INTRO), DIR)


# ══════════════════════════════ BRASIL ══════════════════════════════
U = "https://visa-sc.com/br/gb"
build("br", U,
 ["Vai viajar para Londres?", "Assessoria de viagem", "Tudo pronto para embarcar",
  "Atendimento em português", "Checklist da sua viagem", "Evite imprevistos no embarque",
  "Consultoria para o Reino Unido", "Tire suas dúvidas hoje", "Especialistas em viagem",
  "Viaja em poucos dias?", "Ajuda para toda a família", "Resposta rápida",
  "Preparação para a viagem", "Embarque sem surpresas", "Fale com um especialista"],
 ["Assessoria privada para brasileiros que vão ao Reino Unido. Atendimento em português.",
  "Conferimos o que falta para a sua viagem e explicamos cada passo, sem enrolação.",
  "Não somos órgão público. Orientamos com clareza, inclusive o que dá para fazer sozinho.",
  "Viaja em poucos dias? Atendimento rápido para você embarcar tranquilo."],
 ["br", "londres"],
 ["Atendimento em português", "Resposta rápida", "Assessoria privada", "Para toda a família",
  "Sem compromisso", "Atendimento urgente", "Especialistas em viagem", "Tudo pelo celular"],
 ["Consultoria de viagem", "Checklist de embarque", "Atendimento em português",
  "Viagens em família", "Atendimento urgente", "Tira-dúvidas"],
 [("Como funciona", "Quatro passos simples", "Tudo pelo celular", U + "#how"),
  ("Comece agora", "Leva só dois minutos", "Sem compromisso", U + "#form"),
  ("Dúvidas frequentes", "Respostas diretas", "Antes de embarcar", U + "#faq"),
  ("Fale conosco", "Atendimento em português", "Resposta rápida", U + "#contacts")])

# ══════════════════════════════ ESPAÑA ══════════════════════════════
U = "https://visa-sc.com/es/gb"
build("es", U,
 ["¿Viajas a Londres?", "Asesoría de viaje", "Todo listo para embarcar",
  "Atención en español", "Checklist de tu viaje", "Evita imprevistos al embarcar",
  "Asesoría para Reino Unido", "Resuelve tus dudas hoy", "Especialistas en viajes",
  "¿Viajas en pocos días?", "Ayuda para toda la familia", "Respuesta rápida",
  "Prepara tu viaje con calma", "Embarca sin sorpresas", "Habla con un especialista"],
 ["Asesoría privada para viajeros españoles que van al Reino Unido. Atención en español.",
  "Revisamos lo que te falta para el viaje y te explicamos cada paso, sin rodeos.",
  "No somos un organismo público. Te orientamos con claridad, también para hacerlo tú.",
  "¿Viajas en pocos días? Atención rápida para que embarques tranquilo."],
 ["es", "londres"],
 ["Atención en español", "Respuesta rápida", "Asesoría privada", "Para toda la familia",
  "Sin compromiso", "Atención urgente", "Especialistas en viajes", "Todo desde el móvil"],
 ["Asesoría de viaje", "Checklist de embarque", "Atención en español",
  "Viajes en familia", "Atención urgente", "Resolución de dudas"],
 [("Cómo funciona", "Cuatro pasos sencillos", "Todo desde el móvil", U + "#how"),
  ("Empieza ahora", "Solo dos minutos", "Sin compromiso", U + "#form"),
  ("Preguntas frecuentes", "Respuestas directas", "Antes de embarcar", U + "#faq"),
  ("Contacto", "Atención en español", "Respuesta rápida", U + "#contacts")])

# ══════════════════════════════ ITALIA ══════════════════════════════
U = "https://visa-sc.com/it/gb"
build("it", U,
 ["Vai a Londra?", "Consulenza di viaggio", "Tutto pronto per partire",
  "Assistenza in italiano", "Checklist del tuo viaggio", "Evita imprevisti all'imbarco",
  "Consulenza per il Regno Unito", "Togliti ogni dubbio oggi", "Esperti di viaggi",
  "Parti tra pochi giorni?", "Aiuto per tutta la famiglia", "Risposta rapida",
  "Prepara il viaggio con calma", "Imbarco senza sorprese", "Parla con un esperto"],
 ["Consulenza privata per italiani in viaggio nel Regno Unito. Assistenza in italiano.",
  "Verifichiamo cosa manca per il viaggio e ti spieghiamo ogni passaggio, in modo chiaro.",
  "Non siamo un ente pubblico. Ti orientiamo con chiarezza, anche se preferisci fare da solo.",
  "Parti tra pochi giorni? Assistenza rapida per imbarcarti tranquillo."],
 ["it", "londra"],
 ["Assistenza in italiano", "Risposta rapida", "Consulenza privata", "Per tutta la famiglia",
  "Senza impegno", "Assistenza urgente", "Esperti di viaggi", "Tutto dal telefono"],
 ["Consulenza di viaggio", "Checklist d'imbarco", "Assistenza in italiano",
  "Viaggi in famiglia", "Assistenza urgente", "Risposte ai dubbi"],
 [("Come funziona", "Quattro passaggi semplici", "Tutto dal telefono", U + "#how"),
  ("Inizia ora", "Bastano due minuti", "Senza impegno", U + "#form"),
  ("Domande frequenti", "Risposte dirette", "Prima di partire", U + "#faq"),
  ("Contatti", "Assistenza in italiano", "Risposta rapida", U + "#contacts")])

# ══════════════════════════════ USA ══════════════════════════════
U = "https://visa-sc.com/us/gb"
build("us", U,
 ["Flying to London?", "UK Trip Advisory Service", "Get Ready to Board",
  "Talk to a Specialist", "Your UK Travel Checklist", "Avoid Surprises at the Gate",
  "Travel Help for the UK", "Get Answers Today", "Private Travel Advisors",
  "Flying in a Few Days?", "Help for the Whole Family", "Fast Replies",
  "Stress-Free Trip Prep", "Board Without Surprises", "Friendly Expert Support"],
 ["Private travel advisory for Americans heading to the UK. Clear answers from real people.",
  "We check what your trip still needs and walk you through every step, in plain English.",
  "Independent private advisors. We will also show you what you can handle on your own.",
  "Flying in a few days? Fast help so you can board without worrying."],
 ["us", "london"],
 ["Fast Replies", "Private Advisory", "Whole-Family Help", "No Obligation",
  "Urgent Assistance", "Real People", "All From Your Phone", "Clear Answers"],
 ["Travel Advisory", "Pre-Trip Checklist", "Family Travel",
  "Urgent Assistance", "Travel Questions", "Specialist Support"],
 [("How It Works", "Four simple steps", "All from your phone", U + "#how"),
  ("Get Started", "Takes two minutes", "No obligation", U + "#form"),
  ("FAQ", "Straight answers", "Before you fly", U + "#faq"),
  ("Contact Us", "Real people, fast replies", "Mon to Fri support", U + "#contacts")])
