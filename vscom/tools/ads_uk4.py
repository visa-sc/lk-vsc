# -*- coding: utf-8 -*-
"""12 файлов Google Ads: 4 кампании UK ETA × (ключи, минуса, объявления).

Объявления сразу в консультационной рамке — без глаголов, заявляющих подачу
документа в госорган. Прямые формулировки лежат отдельным блоком на случай,
когда аккаунт получит сертификат.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_br import make

def policy(no_list):
    return """<pre style="max-height:none">ЭТО САМАЯ ЗАРЕГУЛИРОВАННАЯ ТЕМАТИКА В GOOGLE ADS.

1. ОБЪЯВЛЕНИЯ УЖЕ НАПИСАНЫ ТАК, ЧТОБЫ ПРОЙТИ

   Политика «Government documents and services» разрешает рекламу подачи
   документов только госорганам и авторизованным провайдерам. Поэтому
   объявления ниже не заявляют подачу: они продают то, на что разрешения
   не нужно — проверку данных, разбор и сопровождение.

   Это не маскировка: посадочная говорит ровно то же самое и честно
   указывает, что заявку можно подать самому на gov.uk за £20.

2. НА ВСЯКИЙ СЛУЧАЙ ПОДАЙТЕ НА СЕРТИФИКАТ

   Инструменты → Настройка → Сертификаты → «Документы и услуги
   государственных органов». Десять минут, бесплатно. Если объявления
   всё-таки пометят как требующие сертификата, он уже будет в работе.

   Верификация рекламодателя у вас пройдена, повторно не нужна.

3. С 5 ОКТЯБРЯ 2026 ТРЕБОВАНИЯ УЖЕСТОЧАЮТСЯ

   Google начнёт требовать, чтобы домен был указан как авторизованный
   на официальном сайте правительства. Для посредников это закрывает
   канал. Окно для теста — три недели, дальше SEO и соцсети.

4. ЧЕГО НЕЛЬЗЯ ПИСАТЬ НИКОГДА

""" + no_list + """
5. ЧТО УЖЕ СТОИТ НА ПОСАДОЧНОЙ

   Блок «мы не орган власти» со ссылкой на gov.uk, отдельно показанная
   госпошлина £20, прямой текст о самостоятельной подаче и честное
   «одобрение не гарантируем» в FAQ.</pre>"""

GEO_T = ("Гео: {geo}, таргетинг по присутствию (люди, находящиеся в этих местах).\n"
         "Исключить всё остальное: язык объявления не защищает от показов в других странах.")

# ══════════════════════════════ BRASIL ══════════════════════════════
BR_EXACT = """[eta reino unido]
[eta inglaterra]
[eta uk]
[eta para o reino unido]
[eta reino unido brasileiros]
[solicitar eta reino unido]
[pedir eta reino unido]
[tirar eta reino unido]
[fazer eta reino unido]
[como tirar eta reino unido]
[como solicitar eta reino unido]
[eta reino unido preço]
[eta reino unido preco]
[eta reino unido valor]
[eta reino unido quanto custa]
[eta inglaterra brasileiros]
[autorização eletrônica de viagem reino unido]
[autorizacao eletronica de viagem reino unido]
[autorização de viagem inglaterra]
[eta londres]
[eta escócia]
[eta escocia]""".strip().split("\n")

BR_PHRASE = '''"eta reino unido"
"eta inglaterra"
"eta uk"
"solicitar eta"
"como tirar eta"
"como fazer eta"
"preciso de eta"
"quem precisa de eta"
"eta obrigatória"
"eta obrigatoria"
"eta para conexão"
"eta para conexao"
"eta reino unido documentos"
"eta reino unido prazo"
"eta reino unido validade"
"documentos para viajar para inglaterra"
"documentos para viajar para o reino unido"
"o que precisa para viajar para londres"
"autorização para viajar para inglaterra"
"entrar no reino unido"'''.strip().split("\n")

BR_NEG = [
 dict(title="1. Переезд, работа и учёба", hint="Главный источник мусора: бразильцы массово ищут, как уехать в Европу насовсем. Слова «reino unido» и «autorização» стоят ровно в тех же запросах.",
      items="""emprego
empregos
trabalho
trabalhar
vaga
vagas
salário
salario
morar
morando
imigrar
imigração
imigracao
residência
residencia
cidadania
passaporte italiano
passaporte português
passaporte portugues
estudar
intercâmbio
intercambio
universidade
faculdade
curso
au pair
skilled worker
work visa
student visa""".strip().split("\n")),
 dict(title="2. Другие визы и другие страны", hint="«Visto» в запросе почти всегда значит, что человек ищет не ETA.",
      items="""visto de trabalho
visto de estudante
visto de estudo
visto permanente
visto americano
esta
eua
estados unidos
canadá
canada
austrália
australia
schengen
europa
irlanda
portugal
espanha
japão
japao
índia
india""".strip().split("\n")),
 dict(title="3. Бесплатно и проверка репутации", hint="«Reclame aqui», «golpe», «é confiável» — человек проверяет площадку, а не покупает.",
      items="""grátis
gratis
de graça
de graca
gratuito
golpe
golpes
falso
falsa
fraude
reclame aqui
é confiável
e confiavel
é seguro
e seguro
reclamação
reclamacao""".strip().split("\n")),
 dict(title="4. Чистая справка", hint="«Como tirar» намеренно НЕ минусуем — это целевой запрос.",
      items="""o que é
o que e
para que serve
significado
diferença entre
diferenca entre
wikipedia
notícias
noticias
fórum
forum""".strip().split("\n")),
]
BR_DECIDE = dict(title="Решить самому",
    hint="""<b>Конкуренты</b> — по их брендам показываться разрешено, но на бюджете 15 $ в день
они съедят всё. Уберите на старте.<br>
<b>«consulado», «embaixada», «gov uk»</b> — человек ищет официальное учреждение.""",
    items="""ivisa
visahq
sherpa
byevisa
etaland
consulado
embaixada
vfs
gov uk
gov.uk""".strip().split("\n"))
BR_PROTECT = """eta · reino unido · inglaterra · uk · londres · escócia
solicitar · pedir · tirar · fazer · como tirar · autorização · autorizacao
preço · preco · valor · quanto custa · brasileiros · viagem · viajar
conexão · documentos · prazo · validade · obrigatória"""
BR_H = ["Vai para o Reino Unido?", "Consultoria para a viagem", "Checagem dos seus dados",
        "Orientação em português", "Tire suas dúvidas hoje", "Documentos em ordem",
        "Evite erro no formulário", "Assessoria privada", "Resposta a partir de 15 min",
        "Válida por 2 anos", "Para toda a família", "Viaja em 48 horas?",
        "Confira antes de viajar", "Sem surpresa no aeroporto", "Atendimento rápido"]
BR_D = ["Assessoria privada para brasileiros. Conferimos seus dados e orientamos em português.",
        "Autorização válida por 2 anos, com entradas ilimitadas e estadia de até 6 meses.",
        "Não somos órgão público. Explicamos também o que dá para resolver por conta própria.",
        "Tire dúvidas antes de viajar. Atendimento rápido para quem embarca em poucos dias."]
BR_C = ["Checagem de dados", "Orientação em português", "Assessoria privada", "Válida por 2 anos",
        "Pedido da família", "Sem compromisso", "Atendimento urgente", "Resposta rápida"]
BR_S = ["Consultoria de viagem", "Checagem de dados", "Orientação em português",
        "Pedido em família", "Atendimento urgente", "Dúvidas sobre documentos"]
BR_SL = [("O que é a ETA", "Obrigatória desde janeiro de 2025", "Vale até para conexão",
          "https://visa-sc.com/br/gb#who"),
         ("Solicitar online", "Três passos pelo celular", "Revisão antes do envio",
          "https://visa-sc.com/br/gb#form"),
         ("Como funciona", "Quatro passos simples", "Tudo pelo telefone",
          "https://visa-sc.com/br/gb#how"),
         ("Dúvidas frequentes", "Prazo, validade e recusa", "Respostas sem enrolação",
          "https://visa-sc.com/br/gb#faq")]
BR_NO = """   «oficial», «governo», «site do governo», «autorizado pelo governo»
   «garantido», «aprovação garantida», «100% aprovado»
   «visto para o Reino Unido» — нужна ETA, а не виза
   «mais barato que o site oficial»
"""

# ══════════════════════════════ ESPAÑA ══════════════════════════════
ES_EXACT = """[eta reino unido]
[eta inglaterra]
[eta uk]
[eta para reino unido]
[eta reino unido españoles]
[solicitar eta reino unido]
[pedir eta reino unido]
[tramitar eta reino unido]
[sacar eta reino unido]
[como solicitar eta reino unido]
[como sacar eta reino unido]
[eta reino unido precio]
[eta reino unido cuanto cuesta]
[eta reino unido coste]
[autorización electrónica de viaje reino unido]
[autorizacion electronica de viaje reino unido]
[permiso electrónico reino unido]
[eta londres]
[eta escocia]
[eta inglaterra españoles]""".strip().split("\n")
ES_PHRASE = '''"eta reino unido"
"eta inglaterra"
"eta uk"
"solicitar eta"
"como sacar la eta"
"necesito eta"
"quien necesita eta"
"eta obligatoria"
"eta escala londres"
"eta reino unido requisitos"
"eta reino unido plazo"
"eta reino unido validez"
"documentos para viajar a inglaterra"
"documentos para viajar a reino unido"
"que se necesita para viajar a londres"
"permiso para viajar a inglaterra"
"entrar en reino unido"
"viajar a londres con dni"'''.strip().split("\n")
ES_NEG = [
 dict(title="1. Переезд, работа и учёба", hint="Испанцы ищут работу и учёбу в UK огромными объёмами, и слова те же самые. Без этой группы половина бюджета уйдёт туда.",
      items="""trabajo
trabajar
empleo
empleos
oferta
ofertas
sueldo
salario
vivir
mudarse
emigrar
residencia
nacionalidad
estudiar
intercambio
universidad
máster
master
curso
au pair
skilled worker
sponsorship
visado de trabajo
visado de estudiante""".strip().split("\n")),
 dict(title="2. Другие документы и страны", hint="«Visado» — это уже не ETA. Плюс чужие направления.",
      items="""visado
visados
esta
estados unidos
eeuu
canadá
canada
australia
schengen
irlanda
japón
japon
india
china
pasaporte nuevo
renovar pasaporte""".strip().split("\n")),
 dict(title="3. Бесплатно и проверка репутации", hint="",
      items="""gratis
gratuito
gratuita
estafa
estafas
fraude
opiniones
es fiable
es seguro
es legal
foro
forocoches""".strip().split("\n")),
 dict(title="4. Чистая справка", hint="«Cómo solicitar» и «cómo sacar» НЕ минусуем — это покупательские запросы.",
      items="""qué es
que es
para qué sirve
para que sirve
significado
diferencia entre
wikipedia
noticias""".strip().split("\n")),
]
ES_DECIDE = dict(title="Решить самому",
    hint="""<b>Конкуренты</b> — показываться по ним разрешено, но бюджет съедят.<br>
<b>«consulado», «embajada», «gov.uk»</b> — человек ищет официальное учреждение.""",
    items="""ivisa
visahq
sherpa
byevisa
consulado
embajada
gov uk
gov.uk
exteriores""".strip().split("\n"))
ES_PROTECT = """eta · reino unido · inglaterra · uk · londres · escocia
solicitar · pedir · tramitar · sacar · cómo solicitar · autorización · permiso
precio · cuánto cuesta · coste · españoles · viaje · viajar
escala · requisitos · plazo · validez · obligatoria"""
ES_H = ["¿Viajas al Reino Unido?", "Gestión de tu viaje", "Revisamos tus datos",
        "Atención en español", "Resuelve tus dudas hoy", "Documentación en orden",
        "Evita errores en el formulario", "Gestoría privada", "Respuesta desde 15 min",
        "Válida 2 años", "Para toda la familia", "¿Vuelas en 48 horas?",
        "Compruébalo antes de volar", "Sin sustos en el aeropuerto", "Atención rápida"]
ES_D = ["Gestoría privada para españoles. Revisamos tus datos y te atendemos en español.",
        "Autorización válida 2 años, entradas ilimitadas y estancias de hasta 6 meses.",
        "No somos un organismo público. También te explicamos cómo hacerlo por tu cuenta.",
        "Resuelve dudas antes de volar. Atención rápida si viajas en pocos días."]
ES_C = ["Revisión de datos", "Atención en español", "Gestoría privada", "Válida 2 años",
        "Trámite familiar", "Sin compromiso", "Atención urgente", "Respuesta rápida"]
ES_S = ["Gestión de viaje", "Revisión de datos", "Atención en español",
        "Trámite familiar", "Atención urgente", "Dudas sobre documentos"]
ES_SL = [("Qué es la ETA", "Obligatoria desde abril de 2025", "También para escalas",
          "https://visa-sc.com/es/gb#who"),
         ("Solicitar online", "Tres pasos desde el móvil", "Revisión antes del envío",
          "https://visa-sc.com/es/gb#form"),
         ("Cómo funciona", "Cuatro pasos sencillos", "Todo desde el teléfono",
          "https://visa-sc.com/es/gb#how"),
         ("Preguntas frecuentes", "Plazos, validez y denegación", "Respuestas directas",
          "https://visa-sc.com/es/gb#faq")]
ES_NO = """   «oficial», «gobierno», «web del gobierno», «autorizado por el gobierno»
   «garantizado», «aprobación garantizada», «100% aprobado»
   «visado para el Reino Unido» — нужна ETA, а не виза
   «más barato que la web oficial»
"""

# ══════════════════════════════ ITALIA ══════════════════════════════
IT_EXACT = """[eta regno unito]
[eta inghilterra]
[eta uk]
[eta per il regno unito]
[eta regno unito italiani]
[richiedere eta regno unito]
[come richiedere eta regno unito]
[fare eta regno unito]
[eta regno unito costo]
[eta regno unito prezzo]
[eta regno unito quanto costa]
[autorizzazione elettronica di viaggio regno unito]
[autorizzazione viaggio inghilterra]
[permesso elettronico regno unito]
[eta londra]
[eta scozia]
[eta inghilterra italiani]
[domanda eta regno unito]""".strip().split("\n")
IT_PHRASE = '''"eta regno unito"
"eta inghilterra"
"eta uk"
"richiedere eta"
"come richiedere eta"
"serve eta"
"chi deve richiedere eta"
"eta obbligatoria"
"eta scalo londra"
"eta regno unito requisiti"
"eta regno unito tempi"
"eta regno unito validità"
"documenti per viaggiare in inghilterra"
"documenti per andare a londra"
"cosa serve per andare a londra"
"entrare nel regno unito"
"viaggiare a londra con carta d identità"'''.strip().split("\n")
IT_NEG = [
 dict(title="1. Переезд, работа и учёба", hint="Итальянцы массово ищут работу и учёбу в Лондоне. Это самый объёмный мусор в тематике.",
      items="""lavoro
lavorare
offerte
stipendio
salario
vivere
trasferirsi
emigrare
residenza
cittadinanza
studiare
studio
università
universita
master
corso
au pair
skilled worker
sponsorship
visto di lavoro
visto di studio""".strip().split("\n")),
 dict(title="2. Другие документы и страны", hint="«Visto» означает, что человек ищет не ETA.",
      items="""visto
visti
esta
stati uniti
usa
canada
australia
schengen
irlanda
giappone
india
cina
passaporto nuovo
rinnovo passaporto""".strip().split("\n")),
 dict(title="3. Бесплатно и проверка репутации", hint="",
      items="""gratis
gratuito
gratuita
truffa
truffe
frode
recensioni
è affidabile
e affidabile
è sicuro
forum""".strip().split("\n")),
 dict(title="4. Чистая справка", hint="«Come richiedere» НЕ минусуем — это целевой запрос.",
      items="""cos'è
cos e
che cos è
significato
differenza tra
wikipedia
notizie""".strip().split("\n")),
]
IT_DECIDE = dict(title="Решить самому",
    hint="""<b>Конкуренты</b> — показываться разрешено, но на старте съедят бюджет.<br>
<b>«consolato», «ambasciata», «gov.uk»</b> — поиск официального учреждения.""",
    items="""ivisa
visahq
sherpa
byevisa
consolato
ambasciata
gov uk
gov.uk
questura""".strip().split("\n"))
IT_PROTECT = """eta · regno unito · inghilterra · uk · londra · scozia
richiedere · come richiedere · fare · domanda · autorizzazione · permesso
costo · prezzo · quanto costa · italiani · viaggio · viaggiare
scalo · requisiti · tempi · validità · obbligatoria"""
IT_H = ["Viaggi nel Regno Unito?", "Assistenza per il viaggio", "Controlliamo i tuoi dati",
        "Assistenza in italiano", "Togliti i dubbi oggi", "Documenti in regola",
        "Evita errori nel modulo", "Consulenza privata", "Risposta da 15 minuti",
        "Valida 2 anni", "Per tutta la famiglia", "Parti entro 48 ore?",
        "Controlla prima di partire", "Nessuna sorpresa in aeroporto", "Assistenza rapida"]
IT_D = ["Consulenza privata per italiani. Controlliamo i dati e ti assistiamo in italiano.",
        "Autorizzazione valida 2 anni, ingressi illimitati e soggiorni fino a 6 mesi.",
        "Non siamo un ente pubblico. Ti spieghiamo anche come fare da solo, se preferisci.",
        "Chiarisci i dubbi prima di partire. Assistenza rapida se voli tra pochi giorni."]
IT_C = ["Controllo dei dati", "Assistenza in italiano", "Consulenza privata", "Valida 2 anni",
        "Pratica per famiglie", "Senza impegno", "Assistenza urgente", "Risposta rapida"]
IT_S = ["Assistenza viaggio", "Controllo dei dati", "Assistenza in italiano",
        "Pratica familiare", "Assistenza urgente", "Dubbi sui documenti"]
IT_SL = [("Cos'è l'ETA", "Obbligatoria da aprile 2025", "Serve anche per lo scalo",
          "https://visa-sc.com/it/gb#who"),
         ("Richiedi online", "Tre passaggi dal telefono", "Controllo prima dell'invio",
          "https://visa-sc.com/it/gb#form"),
         ("Come funziona", "Quattro passaggi semplici", "Tutto dal telefono",
          "https://visa-sc.com/it/gb#how"),
         ("Domande frequenti", "Tempi, validità e rifiuto", "Risposte dirette",
          "https://visa-sc.com/it/gb#faq")]
IT_NO = """   «ufficiale», «governo», «sito del governo», «autorizzato dal governo»
   «garantito», «approvazione garantita», «100% approvato»
   «visto per il Regno Unito» — нужна ETA, а не виза
   «più economico del sito ufficiale»
"""

# ══════════════════════════════ USA ══════════════════════════════
US_EXACT = """[uk eta]
[eta uk]
[uk travel authorisation]
[uk travel authorization]
[electronic travel authorisation uk]
[electronic travel authorization uk]
[uk eta for us citizens]
[uk eta americans]
[apply for uk eta]
[how to apply for uk eta]
[uk eta application]
[uk eta cost]
[uk eta price]
[uk eta how much]
[uk eta requirements]
[eta england]
[eta london]
[eta scotland]
[do i need a uk eta]
[uk entry requirements]""".strip().split("\n")
US_PHRASE = '''"uk eta"
"eta for uk"
"uk travel authorisation"
"apply for uk eta"
"how to get uk eta"
"do i need eta"
"who needs uk eta"
"uk eta layover"
"uk eta transit"
"uk eta processing time"
"uk eta validity"
"uk eta for children"
"documents to travel to england"
"what do i need to travel to london"
"entering the uk"
"flying to london requirements"'''.strip().split("\n")
US_NEG = [
 dict(title="1. Переезд, работа и учёба", hint="Американцы ищут работу и учёбу в UK ощутимо меньше, чем южане, но запросы дорогие. Отсекаем сразу.",
      items="""job
jobs
work
working
employment
salary
move to
moving to
relocate
relocation
residency
citizenship
study
student
university
college
tuition
skilled worker
sponsorship
work visa
student visa
settlement""".strip().split("\n")),
 dict(title="2. Другие документы и страны", hint="ВАЖНО: «passport» минусуем — американцы массово ищут продление паспорта, и это не мы.",
      items="""passport
passports
renew
renewal
global entry
tsa precheck
nexus
esta
schengen
ireland
canada
australia
japan
india
china
green card
dual citizenship""".strip().split("\n")),
 dict(title="3. Бесплатно и проверка репутации", hint="«Is it legit», «scam», «reddit» — человек проверяет площадку.",
      items="""free
scam
scams
fraud
is it legit
legit
reviews
reddit
complaints
better business bureau
bbb""".strip().split("\n")),
 dict(title="4. Чистая справка", hint="«How to apply» НЕ минусуем — это покупательский запрос.",
      items="""what is
what does
meaning
difference between
wikipedia
news
explained""".strip().split("\n")),
]
US_DECIDE = dict(title="Решить самому",
    hint="""<b>Конкуренты</b> — показываться разрешено, но на старте съедят бюджет.<br>
<b>«gov.uk», «embassy», «consulate»</b> — поиск официального сайта. В США доля таких
запросов выше, чем в Европе: люди чаще ищут первоисточник.""",
    items="""ivisa
visahq
sherpa
byevisa
cibt
gov uk
gov.uk
embassy
consulate
home office""".strip().split("\n"))
US_PROTECT = """eta · uk · united kingdom · england · london · scotland · britain
apply · how to apply · application · authorisation · authorization · travel
cost · price · how much · fee · requirements · valid · validity
layover · transit · children · family · us citizens · americans"""
US_H = ["Flying to the UK?", "Travel document check", "We review your details",
        "Talk to a specialist", "Get your questions answered", "Paperwork in order",
        "Avoid form mistakes", "Private advisory firm", "Answers from 15 minutes",
        "Valid for 2 years", "For the whole family", "Flying within 48 hours?",
        "Check before you fly", "No surprises at the gate", "Fast assistance"]
US_D = ["Private advisory service for US travellers. We review your details before filing.",
        "Valid for two years, unlimited entries and stays of up to six months per visit.",
        "We are not a government body. We will also show you how to do it yourself on gov.uk.",
        "Get answers before you fly. Fast help if you are travelling in the next few days."]
US_C = ["Detail review", "English-speaking team", "Private advisory", "Valid 2 years",
        "Family applications", "No obligation", "Urgent assistance", "Fast answers"]
US_S = ["Travel advisory", "Detail review", "Family applications",
        "Urgent assistance", "Document questions", "Pre-flight check"]
US_SL = [("What the ETA is", "Required since January 2025", "Layovers included",
          "https://visa-sc.com/us/gb#who"),
         ("Apply online", "Three steps from your phone", "Reviewed before filing",
          "https://visa-sc.com/us/gb#form"),
         ("How it works", "Four simple steps", "All from your phone",
          "https://visa-sc.com/us/gb#how"),
         ("FAQ", "Timing, validity and refusals", "Straight answers",
          "https://visa-sc.com/us/gb#faq")]
US_NO = """   «official», «government», «government site», «government authorised»
   «guaranteed», «guaranteed approval», «100% approved»
   «UK visa» — американцам нужна ETA, а не виза
   «cheaper than the official site»
"""

INTRO_K = """
<div class="card"><h2>Почему это направление сильнее предыдущих</h2>
<p class="hint">ETA обязательна <b>каждому</b>, кто летит в Британию, включая транзит и младенцев.
Это не узкий сегмент — это весь турпоток страны. И решение принимается быстро: человек узнаёт
об ETA за неделю-две до вылета и закрывает вопрос сразу, без долгих раздумий.</p>
<p class="hint">Плюс дедлайн работает на нас: без ETA не пустят на рейс. В отличие от eSIM,
здесь у покупки нет бесплатной альтернативы.</p></div>
"""
INTRO_M = """
<div class="card"><h2>Главный источник мусора здесь один и тот же</h2>
<p class="hint">Не «бесплатно» и не справочные запросы, а <b>эмиграция</b>: работа, учёба, ПМЖ.
Люди ищут это теми же словами — «Reino Unido», «Regno Unito», «United Kingdom». Первая группа
ниже самая важная: без неё половина бюджета уйдёт на тех, кто ищет работу в Лондоне.</p></div>
"""

CAMPS = [
 ("uk_eta_br", "BR · ETA Reino Unido", "Поисковая кампания, язык португальский. visa-sc.com/br/gb",
  "https://visa-sc.com/br/gb", BR_EXACT, BR_PHRASE, BR_NEG, BR_DECIDE, BR_PROTECT,
  BR_H, BR_D, ["br", "eta-uk"], BR_C, BR_S, BR_SL, "0,30 $", "Бразилия", "португальский",
  "Прямой спрос. Бразильцы часто пишут без диакритики, поэтому варианты с акцентами и без даны отдельными строками — Google считает их разными близкими вариантами.",
  BR_NO),
 ("uk_eta_es", "ES · ETA Reino Unido", "Поисковая кампания, язык испанский. visa-sc.com/es/gb",
  "https://visa-sc.com/es/gb", ES_EXACT, ES_PHRASE, ES_NEG, ES_DECIDE, ES_PROTECT,
  ES_H, ES_D, ["es", "eta-uk"], ES_C, ES_S, ES_SL, "0,45 $", "Испания", "испанский",
  "Прямой спрос. Испанцы часто набирают без ударений — «autorizacion», «escocia», поэтому оба варианта даны отдельно.",
  ES_NO),
 ("uk_eta_it", "IT · ETA Regno Unito", "Поисковая кампания, язык итальянский. visa-sc.com/it/gb",
  "https://visa-sc.com/it/gb", IT_EXACT, IT_PHRASE, IT_NEG, IT_DECIDE, IT_PROTECT,
  IT_H, IT_D, ["it", "eta-uk"], IT_C, IT_S, IT_SL, "0,45 $", "Италия", "итальянский",
  "Прямой спрос. Обратите внимание на «domanda eta» — по-итальянски это «заявление», один из самых частых способов сформулировать запрос.",
  IT_NO),
 ("uk_eta_us", "US · UK ETA", "Поисковая кампания, язык английский. visa-sc.com/us/gb",
  "https://visa-sc.com/us/gb", US_EXACT, US_PHRASE, US_NEG, US_DECIDE, US_PROTECT,
  US_H, US_D, ["us", "uk-eta"], US_C, US_S, US_SL, "0,80 $", "США", "английский",
  "Прямой спрос. Британское и американское написание («authorisation» / «authorization») даны отдельными ключами — американцы пишут через z, но читают британские источники.",
  US_NO),
]

for (slug, name, sub, url, ex, ph, neg, dec, prot, heads, descs, paths,
     calls, snips, sl, bid, geo, langname, exhint, nolist) in CAMPS:
    make(slug, name, name, sub, url, ex, ph, neg, dec, prot,
         heads, descs, paths, "VSC", calls, snips, sl,
         INTRO_K, INTRO_M, bid, GEO_T.format(geo=geo), langname, exhint, policy(nolist))
