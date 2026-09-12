# -*- coding: utf-8 -*-
"""Четыре страницы UK ETA: Бразилия, Испания, Италия, США.

ETA Великобритании обязательна всем четырём национальностям:
бразильцам и американцам с 8 января 2025, гражданам ЕС со 2 апреля 2025.
Пошлина одна для всех — £20 (≈ €23 / $27 / R$ 139).
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_eta import build

UK_FEE = "£20"

# ══════════════════════════════ BRASIL ══════════════════════════════
BR = dict(
    lang="pt-BR", locale="pt_BR", num_loc="pt-BR", cur="R$ ", cur_code="BRL",
    file="br/gb.html", path="/br/gb", url="https://visa-sc.com/br/gb", form="br-gb",
    tel="+55 11 4210-8500", tel_h="+551142108500",
    office_city="São Paulo",
    office_addr="Av. Paulista, 1374 — Bela Vista, São Paulo — SP, 01310-100",
    hours_br="Seg a sex, 9h às 19h (horário de Brasília)",
    hours_uk="Mon to Fri, 8am to 5pm (London time)",
    title="ETA do Reino Unido para brasileiros — solicite online | VSC",
    desc=("ETA do Reino Unido obrigatória para brasileiros desde janeiro de 2025. "
          "Revisamos cada campo antes de enviar, atendimento em português. Taxa oficial de £20 inclusa."),
    og_title="ETA do Reino Unido para brasileiros",
    og_desc="Solicite online, com revisão antes do envio e atendimento em português.",
    h1=('ETA do Reino Unido para brasileiros.<br>'
        '<span class="hl">Rápido, em português e sem erro no formulário.</span>'),
    sub=("Obrigatória para todo brasileiro que viaja ao Reino Unido, inclusive em conexão.<br>"
         "Um erro no formulário custa a recusa e uma nova taxa — conferimos cada campo antes de enviar.<br>"
         "Você preenche pelo celular e acompanha o resto pelo WhatsApp."),
    facts=[("Taxa oficial", UK_FEE), ("Validade", "2 anos"), ("Resposta", "a partir de 15 min"),
           ("Estadia", "até 6 meses"), ("Entradas", "quantas quiser"), ("Atendimento", "em português")],
    btn="Solicitar minha ETA", btn_s="Solicitar", wa_btn="Falar no WhatsApp",
    nav=["O que é", "Como funciona", "Solicitar", "Dúvidas", "Contato"],
    ph_name="Nome completo", ph_mail="E-mail", ph_phone="WhatsApp com DDD *",
    form_title="Solicitar a ETA", form_title2="do Reino Unido",
    form_sub="Conferimos os seus dados antes de enviar.",
    form_sub2="Um especialista responde e explica o próximo passo.",
    consent='Ao enviar, você concorda com o tratamento dos seus <a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">dados pessoais</a>.',
    done_h="Recebemos o seu pedido", done_p="Um especialista entra em contato para confirmar os dados.",
    err_phone="Informe um telefone válido com o DDD.", sending="Enviando...",
    err_send="Não foi possível enviar. Escreva para info@visa-sc.com.",
    err_net="Erro de conexão. Tente novamente ou escreva para info@visa-sc.com.",
    privacy="Política de privacidade",
    st1="Plano", st2="Viajantes", st3="Confirmar",
    next="Continuar", back="Voltar", add="+ Adicionar outro viajante", send="Enviar pedido",
    l_mail="E-mail para receber", l_wa="WhatsApp com DDD",
    l_pass="Passaporte", l_first="Nome e nome do meio", l_last="Sobrenome",
    l_birth="Data de nascimento", l_sex="Sexo",
    w_trav="Viajante", w_del="Remover", w_m="Masculino", w_f="Feminino",
    w_people="Viajantes", w_total="Total",
    err_fill="Preencha nome, sobrenome, data de nascimento e sexo de cada viajante.",
    order_h="Solicite a sua ETA",
    order_sub=("Três passos: escolher a velocidade, informar quem viaja e confirmar. "
               "O pagamento é combinado depois, nada é cobrado agora."),
    flag="🇬🇧", product="ETA do Reino Unido",
    aside=[("Entrega mais rápida", "15 minutos"), ("Validade", "2 anos"),
           ("Atendimento", "em português"), ("Taxa oficial inclusa", "£20 por pessoa")],
    p1_h="Qual a pressa?", p1_hint="Todos os planos incluem a revisão completa e a taxa oficial de £20.",
    p2_h="Quem vai viajar", p2_hint="Escreva exatamente como está no passaporte, sem abreviar.",
    p3_h="Confira e envie", p3_hint="Depois do envio, um especialista confirma os dados antes de cobrar.",
    countries=["Brasil", "Portugal", "Argentina", "Chile", "Uruguai", "México", "Colômbia", "Outro"],
    tiers=[dict(id="padrao", name="Padrão", time="Pronto em até 24 horas", price=599, default=True),
           dict(id="rapido", name="Rápido", time="Pronto em até 4 horas", price=799, tag="Mais escolhido"),
           dict(id="urgente", name="Urgente", time="Pronto em até 15 minutos", price=999)],
    who_h="O que é a ETA do Reino Unido",
    alert_b="Obrigatória para todos, inclusive bebês e conexões",
    alert_p=("Desde 8 de janeiro de 2025 a ETA é exigida de todo brasileiro que viaja ao Reino Unido: "
             "turismo, negócios, visita a parentes e até conexão sem sair do aeroporto. Sem ETA aprovada "
             "a companhia aérea não deixa embarcar. Cada passageiro precisa da sua, incluindo crianças. "
             "Vale 2 anos e serve para quantas viagens você fizer nesse período."),
    gov=('<b>Não somos um órgão do governo.</b> A VSC é uma empresa privada de assessoria e não tem '
         'vínculo com o governo do Reino Unido. Você pode solicitar a ETA por conta própria no site '
         'oficial <a href="https://www.gov.uk/apply-eta" target="_blank" rel="noopener nofollow">gov.uk</a> '
         'pagando apenas a taxa oficial de £20. O que você paga aqui a mais é o nosso trabalho: revisão '
         'do formulário, conferência da foto e do passaporte, acompanhamento e suporte em português.'),
    prob_h="Por que pedidos são recusados",
    problems=[("Foto fora do padrão",
               "A ETA exige foto biométrica tirada na hora. Fundo, sombra e enquadramento errados "
               "reprovam o pedido e a taxa não volta."),
              ("Dados diferentes do passaporte",
               "Nome com acento, sobrenome composto, um dígito errado: o sistema compara caractere "
               "por caractere e recusa qualquer divergência."),
              ("Resposta imprecisa sobre antecedentes",
               "As perguntas parecem simples, mas uma resposta errada transforma um pedido automático "
               "em análise manual de semanas."),
              ("Pedido em cima da hora",
               "A maioria sai em minutos, mas o governo se reserva até 3 dias úteis. Quem pede na "
               "véspera do voo corre risco real de perder a viagem.")],
    how_h="Como funciona",
    steps=[("Você preenche", "Dados do passaporte pelo formulário. Leva dois minutos."),
           ("A gente confere", "Comparamos cada campo com o documento e avisamos se algo não bate."),
           ("Cuidamos do processo", "Acompanhamos o pedido do início ao fim, incluindo a taxa oficial."),
           ("Você recebe a resposta", "A ETA fica vinculada ao passaporte. Avisamos assim que sair.")],
    faq_h="Dúvidas frequentes",
    faq=[("Preciso de ETA se for só fazer conexão em Londres?",
          "Sim. É exigida inclusive para quem faz conexão sem passar pela imigração. Sem ela a "
          "companhia aérea não autoriza o embarque."),
         ("Quanto tempo a ETA vale?",
          "Dois anos ou até o vencimento do passaporte, o que acontecer primeiro. Nesse período você "
          "entra quantas vezes quiser, com estadia de até 6 meses por visita."),
         ("A ETA é colada no passaporte?",
          "Não, é eletrônica e fica vinculada ao número do passaporte. Trocou de passaporte, "
          "precisa de uma nova."),
         ("Meu filho pequeno também precisa?",
          "Sim, cada passageiro precisa da sua, independentemente da idade. Fazemos da família inteira "
          "de uma vez."),
         ("Vocês garantem que vai ser aprovado?",
          "Não, e desconfie de quem garantir: a decisão é das autoridades britânicas. O que garantimos "
          "é o pedido sem erros de preenchimento, que é onde a maioria das recusas acontece."),
         ("Posso fazer sozinho?",
          "Pode, e explicamos como: o pedido é feito no site oficial gov.uk pagando £20. A nossa taxa "
          "é pelo trabalho de revisar, orientar e acompanhar em português."),
         ("Como faço o pagamento?",
          "Combinamos depois do pedido. Você recebe o comprovante e o recibo por e-mail."),
         ("E se a ETA for recusada?",
          "A taxa oficial não é devolvida pelo governo em nenhuma hipótese. Se a recusa vier de erro "
          "nosso, refazemos sem cobrar a nossa taxa de novo.")],
    legal1=("A VSC é uma empresa privada de assessoria em documentação de viagem. Não somos consulado, "
            "embaixada nem órgão do governo, e não representamos oficialmente nenhum país. A decisão "
            "sobre conceder ou negar a autorização é exclusiva das autoridades competentes."),
    legal2=("As informações desta página têm caráter informativo, não constituem aconselhamento "
            "jurídico e não substituem as regras oficiais do país de destino. Prazos e valores "
            "oficiais podem mudar sem aviso prévio."),
)

# ══════════════════════════════ ESPAÑA ══════════════════════════════
ES = dict(
    lang="es-ES", locale="es_ES", num_loc="es-ES", cur="€", cur_code="EUR",
    file="es/gb.html", path="/es/gb", url="https://visa-sc.com/es/gb", form="es-gb",
    tel="+34 910 60 84 20", tel_h="+34910608420",
    office_city="Madrid",
    office_addr="Calle de Alcalá 61, 28014 Madrid",
    hours_br="Lun a vie, 9:00 a 19:00 (hora peninsular)",
    hours_uk="Mon to Fri, 8am to 5pm (London time)",
    title="ETA Reino Unido para españoles — solicítala online | VSC",
    desc=("La ETA del Reino Unido es obligatoria para los españoles desde abril de 2025. "
          "Revisamos cada campo antes de enviar, atención en español. Tasa oficial de £20 incluida."),
    og_title="ETA Reino Unido para españoles",
    og_desc="Solicítala online, con revisión antes del envío y atención en español.",
    h1=('ETA del Reino Unido para españoles.<br>'
        '<span class="hl">Rápido, en español y sin errores en el formulario.</span>'),
    sub=("Obligatoria para todo español que viaje al Reino Unido, incluso en tránsito.<br>"
         "Un error en el formulario supone denegación y pagar la tasa otra vez — revisamos cada campo.<br>"
         "Rellenas desde el móvil y nosotros nos encargamos del resto."),
    facts=[("Tasa oficial", UK_FEE), ("Validez", "2 años"), ("Respuesta", "desde 15 min"),
           ("Estancia", "hasta 6 meses"), ("Entradas", "las que quieras"), ("Atención", "en español")],
    btn="Solicitar mi ETA", btn_s="Solicitar", wa_btn="Escríbenos",
    nav=["Qué es", "Cómo funciona", "Solicitar", "Dudas", "Contacto"],
    ph_name="Nombre completo", ph_mail="Correo electrónico", ph_phone="Teléfono con prefijo *",
    form_title="Solicitar la ETA", form_title2="del Reino Unido",
    form_sub="Revisamos tus datos antes de enviar.",
    form_sub2="Un especialista te responde y te explica el siguiente paso.",
    consent='Al enviar, aceptas el tratamiento de tus <a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">datos personales</a>.',
    done_h="Hemos recibido tu solicitud", done_p="Un especialista te contactará para confirmar los datos.",
    err_phone="Indica un teléfono válido con prefijo.", sending="Enviando...",
    err_send="No se ha podido enviar. Escríbenos a info@visa-sc.com.",
    err_net="Error de conexión. Inténtalo de nuevo o escríbenos a info@visa-sc.com.",
    privacy="Política de privacidad",
    st1="Plan", st2="Viajeros", st3="Confirmar",
    next="Continuar", back="Volver", add="+ Añadir otro viajero", send="Enviar solicitud",
    l_mail="Correo para recibirla", l_wa="Teléfono con prefijo",
    l_pass="Pasaporte", l_first="Nombre y segundo nombre", l_last="Apellidos",
    l_birth="Fecha de nacimiento", l_sex="Sexo",
    w_trav="Viajero", w_del="Quitar", w_m="Masculino", w_f="Femenino",
    w_people="Viajeros", w_total="Total",
    err_fill="Rellena nombre, apellidos, fecha de nacimiento y sexo de cada viajero.",
    order_h="Solicita tu ETA",
    order_sub=("Tres pasos: elegir la rapidez, indicar quién viaja y confirmar. "
               "El pago se acuerda después, ahora no se cobra nada."),
    flag="🇬🇧", product="ETA del Reino Unido",
    aside=[("Entrega más rápida", "15 minutos"), ("Validez", "2 años"),
           ("Atención", "en español"), ("Tasa oficial incluida", "£20 por persona")],
    p1_h="¿Cuánta prisa tienes?", p1_hint="Todos los planes incluyen la revisión completa y la tasa oficial de £20.",
    p2_h="Quién viaja", p2_hint="Escríbelo exactamente como figura en el pasaporte, sin abreviar.",
    p3_h="Revisa y envía", p3_hint="Tras el envío, un especialista confirma los datos antes de cobrar.",
    countries=["España", "Portugal", "Italia", "Francia", "Alemania", "Argentina", "México", "Otro"],
    tiers=[dict(id="estandar", name="Estándar", time="Enviada en 24 horas", price=89, default=True),
           dict(id="rapido", name="Rápida", time="Enviada en 4 horas", price=119, tag="La más elegida"),
           dict(id="urgente", name="Urgente", time="Enviada en 15 minutos", price=159)],
    who_h="Qué es la ETA del Reino Unido",
    alert_b="Obligatoria para todos, también bebés y tránsitos",
    alert_p=("Desde el 2 de abril de 2025 la ETA se exige a todo ciudadano español que viaje al Reino "
             "Unido: turismo, negocios, visitas familiares e incluso tránsito sin salir del aeropuerto. "
             "Sin ETA aprobada la aerolínea no permite embarcar. Cada pasajero necesita la suya, "
             "incluidos los niños. Vale 2 años y sirve para todos los viajes de ese periodo."),
    gov=('<b>No somos un organismo público.</b> VSC es una empresa privada de gestoría y no tiene '
         'vínculo con el Gobierno del Reino Unido. Puedes solicitar la ETA por tu cuenta en la web '
         'oficial <a href="https://www.gov.uk/apply-eta" target="_blank" rel="noopener nofollow">gov.uk</a> '
         'pagando solo la tasa oficial de £20. Lo que pagas aquí de más es nuestro trabajo: revisión '
         'del formulario, comprobación de la foto y el pasaporte, seguimiento y atención en español.'),
    prob_h="Por qué se deniegan las solicitudes",
    problems=[("Foto que no cumple el estándar",
               "La ETA exige foto biométrica hecha en el momento. Fondo, sombras o encuadre "
               "incorrectos tumban la solicitud y la tasa no se devuelve."),
              ("Datos distintos a los del pasaporte",
               "Tildes, apellidos compuestos, un dígito mal: el sistema compara carácter a carácter "
               "y rechaza cualquier discrepancia."),
              ("Respuestas imprecisas sobre antecedentes",
               "Las preguntas parecen sencillas, pero una respuesta mal formulada convierte una "
               "solicitud automática en una revisión manual de semanas."),
              ("Solicitar con el tiempo justo",
               "La mayoría sale en minutos, pero el Gobierno se reserva hasta 3 días hábiles. "
               "Quien la pide la víspera del vuelo se arriesga de verdad.")],
    how_h="Cómo funciona",
    steps=[("Rellenas los datos", "Datos del pasaporte en el formulario. Dos minutos."),
           ("Los revisamos", "Comparamos cada campo con el documento y te avisamos si algo no cuadra."),
           ("Nos ocupamos del trámite", "Hacemos el seguimiento de principio a fin, tasa oficial incluida."),
           ("Recibes la respuesta", "La ETA queda ligada al pasaporte. Te avisamos en cuanto salga.")],
    faq_h="Preguntas frecuentes",
    faq=[("¿Necesito ETA si solo hago escala en Londres?",
          "Sí. Se exige incluso para quien hace escala sin pasar por inmigración. Sin ella la "
          "aerolínea no autoriza el embarque."),
         ("¿Cuánto tiempo vale la ETA?",
          "Dos años o hasta que caduque el pasaporte, lo que ocurra antes. Durante ese periodo entras "
          "las veces que quieras, con estancias de hasta 6 meses."),
         ("¿Se pega en el pasaporte?",
          "No, es electrónica y queda ligada al número de pasaporte. Si cambias de pasaporte, "
          "necesitas una nueva."),
         ("¿Mi hijo pequeño también la necesita?",
          "Sí, cada pasajero necesita la suya, sea cual sea su edad. Tramitamos la de toda la familia "
          "de una vez."),
         ("¿Garantizáis la aprobación?",
          "No, y desconfía de quien la garantice: la decisión es de las autoridades británicas. Lo que "
          "garantizamos es una solicitud sin errores de cumplimentación, que es donde se producen "
          "la mayoría de las denegaciones."),
         ("¿Puedo hacerlo yo mismo?",
          "Puedes, y te explicamos cómo: la solicitud se hace en gov.uk pagando £20. Nuestra tarifa "
          "es por revisar, orientarte y hacer el seguimiento en español."),
         ("¿Cómo se paga?",
          "Lo acordamos después de la solicitud. Recibes el justificante y la factura por correo."),
         ("¿Y si me la deniegan?",
          "El Gobierno no devuelve la tasa oficial en ningún caso. Si la denegación viene de un error "
          "nuestro, repetimos la solicitud sin cobrarte otra vez nuestra tarifa.")],
    legal1=("VSC es una empresa privada de gestoría de documentación de viaje. No somos consulado, "
            "embajada ni organismo público, y no representamos oficialmente a ningún país. La decisión "
            "de conceder o denegar la autorización corresponde en exclusiva a las autoridades competentes."),
    legal2=("La información de esta página es orientativa, no constituye asesoramiento jurídico y no "
            "sustituye a la normativa oficial del país de destino. Los plazos y las tasas oficiales "
            "pueden cambiar sin previo aviso."),
)

# ══════════════════════════════ ITALIA ══════════════════════════════
IT = dict(
    lang="it-IT", locale="it_IT", num_loc="it-IT", cur="€", cur_code="EUR",
    file="it/gb.html", path="/it/gb", url="https://visa-sc.com/it/gb", form="it-gb",
    tel="+39 02 8734 1250", tel_h="+390287341250",
    office_city="Milano",
    office_addr="Via Dante 7, 20121 Milano",
    hours_br="Lun–ven, 9:00–19:00 (ora italiana)",
    hours_uk="Mon to Fri, 8am to 5pm (London time)",
    title="ETA Regno Unito per italiani — richiedila online | VSC",
    desc=("L'ETA per il Regno Unito è obbligatoria per gli italiani da aprile 2025. "
          "Controlliamo ogni campo prima dell'invio, assistenza in italiano. Tassa ufficiale di £20 inclusa."),
    og_title="ETA Regno Unito per italiani",
    og_desc="Richiedila online, con controllo prima dell'invio e assistenza in italiano.",
    h1=('ETA per il Regno Unito, per italiani.<br>'
        '<span class="hl">Veloce, in italiano e senza errori nel modulo.</span>'),
    sub=("Obbligatoria per ogni italiano che viaggia nel Regno Unito, anche solo in transito.<br>"
         "Un errore nel modulo significa rifiuto e tassa da ripagare — controlliamo ogni campo.<br>"
         "Compili dal telefono, al resto pensiamo noi."),
    facts=[("Tassa ufficiale", UK_FEE), ("Validità", "2 anni"), ("Risposta", "da 15 min"),
           ("Soggiorno", "fino a 6 mesi"), ("Ingressi", "quanti vuoi"), ("Assistenza", "in italiano")],
    btn="Richiedi la tua ETA", btn_s="Richiedi", wa_btn="Scrivici",
    nav=["Cos'è", "Come funziona", "Richiedi", "Domande", "Contatti"],
    ph_name="Nome e cognome", ph_mail="E-mail", ph_phone="Telefono con prefisso *",
    form_title="Richiedi l'ETA", form_title2="per il Regno Unito",
    form_sub="Controlliamo i tuoi dati prima dell'invio.",
    form_sub2="Un consulente ti risponde e ti spiega il passo successivo.",
    consent='Inviando accetti il trattamento dei tuoi <a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">dati personali</a>.',
    done_h="Abbiamo ricevuto la richiesta", done_p="Un consulente ti contatterà per confermare i dati.",
    err_phone="Inserisci un numero valido con il prefisso.", sending="Invio...",
    err_send="Invio non riuscito. Scrivi a info@visa-sc.com.",
    err_net="Errore di connessione. Riprova o scrivi a info@visa-sc.com.",
    privacy="Informativa sulla privacy",
    st1="Piano", st2="Viaggiatori", st3="Conferma",
    next="Continua", back="Indietro", add="+ Aggiungi un altro viaggiatore", send="Invia richiesta",
    l_mail="E-mail per riceverla", l_wa="Telefono con prefisso",
    l_pass="Passaporto", l_first="Nome e secondo nome", l_last="Cognome",
    l_birth="Data di nascita", l_sex="Sesso",
    w_trav="Viaggiatore", w_del="Rimuovi", w_m="Maschile", w_f="Femminile",
    w_people="Viaggiatori", w_total="Totale",
    err_fill="Compila nome, cognome, data di nascita e sesso di ogni viaggiatore.",
    order_h="Richiedi la tua ETA",
    order_sub=("Tre passaggi: scegliere la rapidità, indicare chi viaggia e confermare. "
               "Il pagamento si concorda dopo, ora non viene addebitato nulla."),
    flag="🇬🇧", product="ETA per il Regno Unito",
    aside=[("Consegna più rapida", "15 minuti"), ("Validità", "2 anni"),
           ("Assistenza", "in italiano"), ("Tassa ufficiale inclusa", "£20 a persona")],
    p1_h="Quanta fretta hai?", p1_hint="Tutti i piani includono il controllo completo e la tassa ufficiale di £20.",
    p2_h="Chi viaggia", p2_hint="Scrivi esattamente come sul passaporto, senza abbreviare.",
    p3_h="Controlla e invia", p3_hint="Dopo l'invio un consulente conferma i dati prima di addebitare.",
    countries=["Italia", "Spagna", "Francia", "Germania", "Portogallo", "Svizzera", "Romania", "Altro"],
    tiers=[dict(id="standard", name="Standard", time="Inviata entro 24 ore", price=89, default=True),
           dict(id="rapida", name="Rapida", time="Inviata entro 4 ore", price=119, tag="La più scelta"),
           dict(id="urgente", name="Urgente", time="Inviata entro 15 minuti", price=159)],
    who_h="Cos'è l'ETA per il Regno Unito",
    alert_b="Obbligatoria per tutti, anche neonati e transiti",
    alert_p=("Dal 2 aprile 2025 l'ETA è richiesta a ogni cittadino italiano che viaggia nel Regno "
             "Unito: turismo, lavoro, visite ai parenti e perfino transito senza uscire dall'aeroporto. "
             "Senza ETA approvata la compagnia aerea non fa imbarcare. Ogni passeggero deve avere la "
             "propria, bambini compresi. Vale 2 anni e copre tutti i viaggi di quel periodo."),
    gov=('<b>Non siamo un ente pubblico.</b> VSC è una società privata di consulenza e non ha alcun '
         'legame con il governo del Regno Unito. Puoi richiedere l\'ETA da solo sul sito ufficiale '
         '<a href="https://www.gov.uk/apply-eta" target="_blank" rel="noopener nofollow">gov.uk</a> '
         'pagando soltanto la tassa ufficiale di £20. Quello che paghi qui in più è il nostro lavoro: '
         'controllo del modulo, verifica della foto e del passaporto, monitoraggio e assistenza in italiano.'),
    prob_h="Perché le richieste vengono rifiutate",
    problems=[("Foto non conforme",
               "L'ETA richiede una foto biometrica scattata al momento. Sfondo, ombre o inquadratura "
               "sbagliati fanno respingere la richiesta e la tassa non torna indietro."),
              ("Dati diversi dal passaporto",
               "Accenti, doppi cognomi, una cifra sbagliata: il sistema confronta carattere per "
               "carattere e rifiuta qualsiasi differenza."),
              ("Risposte imprecise sui precedenti",
               "Le domande sembrano semplici, ma una risposta formulata male trasforma una richiesta "
               "automatica in un esame manuale di settimane."),
              ("Richiesta all'ultimo momento",
               "La maggior parte esce in pochi minuti, ma il governo si riserva fino a 3 giorni "
               "lavorativi. Chi la chiede la vigilia del volo rischia davvero.")],
    how_h="Come funziona",
    steps=[("Compili i dati", "Dati del passaporto nel modulo. Due minuti."),
           ("Li controlliamo", "Confrontiamo ogni campo con il documento e ti avvisiamo se qualcosa non torna."),
           ("Seguiamo la pratica", "Ci occupiamo di tutto dall'inizio alla fine, tassa ufficiale compresa."),
           ("Ricevi la risposta", "L'ETA resta collegata al passaporto. Ti avvisiamo appena arriva.")],
    faq_h="Domande frequenti",
    faq=[("Serve l'ETA se faccio solo scalo a Londra?",
          "Sì. È richiesta anche a chi fa scalo senza passare dall'immigrazione. Senza, la compagnia "
          "aerea non autorizza l'imbarco."),
         ("Quanto dura l'ETA?",
          "Due anni o fino alla scadenza del passaporto, se prima. In quel periodo entri quante volte "
          "vuoi, con soggiorni fino a 6 mesi."),
         ("Viene applicata sul passaporto?",
          "No, è elettronica e resta collegata al numero di passaporto. Se cambi passaporto ne serve "
          "una nuova."),
         ("Serve anche per mio figlio piccolo?",
          "Sì, ogni passeggero deve avere la propria, a qualsiasi età. Gestiamo tutta la famiglia in "
          "una volta sola."),
         ("Garantite l'approvazione?",
          "No, e diffida di chi la garantisce: la decisione spetta alle autorità britanniche. Quello "
          "che garantiamo è una richiesta senza errori di compilazione, che è dove nascono quasi tutti "
          "i rifiuti."),
         ("Posso farlo da solo?",
          "Puoi, e ti spieghiamo come: la richiesta si fa su gov.uk pagando £20. La nostra tariffa è "
          "per il lavoro di controllare, guidarti e seguire la pratica in italiano."),
         ("Come si paga?",
          "Lo concordiamo dopo la richiesta. Ricevi la ricevuta e la fattura via e-mail."),
         ("E se viene rifiutata?",
          "Il governo non restituisce la tassa ufficiale in nessun caso. Se il rifiuto dipende da un "
          "errore nostro, rifacciamo la richiesta senza farti pagare di nuovo la nostra tariffa.")],
    legal1=("VSC è una società privata di consulenza in documentazione di viaggio. Non siamo consolato, "
            "ambasciata né ente pubblico e non rappresentiamo ufficialmente alcun paese. La decisione "
            "di concedere o negare l'autorizzazione spetta esclusivamente alle autorità competenti."),
    legal2=("Le informazioni di questa pagina hanno carattere orientativo, non costituiscono "
            "consulenza legale e non sostituiscono le norme ufficiali del paese di destinazione. "
            "Tempi e importi ufficiali possono cambiare senza preavviso."),
)

# ══════════════════════════════ USA ══════════════════════════════
US = dict(
    lang="en-US", locale="en_US", num_loc="en-US", cur="$", cur_code="USD",
    file="us/gb.html", path="/us/gb", url="https://visa-sc.com/us/gb", form="us-gb",
    tel="+1 (646) 480-0270", tel_h="+16464800270",
    office_city="New York",
    office_addr="447 Broadway, 2nd Floor, New York, NY 10013",
    hours_br="Mon to Fri, 9am to 7pm (Eastern Time)",
    hours_uk="Mon to Fri, 8am to 5pm (London time)",
    title="UK ETA for US citizens — apply online | VSC",
    desc=("The UK ETA has been required for US citizens since January 2025. We check every field "
          "before submitting and follow the application through. £20 government fee included."),
    og_title="UK ETA for US citizens",
    og_desc="Apply online, with a full review before submission.",
    h1=('UK travel authorisation for US citizens.<br>'
        '<span class="hl">Checked before it is submitted.</span>'),
    sub=("Required for every American flying to the UK, including layovers.<br>"
         "One typo means a refusal and a second fee — we check every field against your passport.<br>"
         "Fill it in on your phone, we handle the rest."),
    facts=[("Government fee", UK_FEE), ("Valid for", "2 years"), ("Decision", "from 15 min"),
           ("Stay", "up to 6 months"), ("Entries", "unlimited"), ("Support", "in English")],
    btn="Apply for my ETA", btn_s="Apply", wa_btn="Message us",
    nav=["What it is", "How it works", "Apply", "FAQ", "Contact"],
    ph_name="Full name", ph_mail="Email", ph_phone="Phone number *",
    form_title="Apply for the ETA", form_title2="United Kingdom",
    form_sub="We check your details before submitting.",
    form_sub2="A specialist replies and explains the next step.",
    consent='By submitting you agree to the processing of your <a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">personal data</a>.',
    done_h="We have your application", done_p="A specialist will contact you to confirm the details.",
    err_phone="Please enter a valid phone number.", sending="Sending...",
    err_send="We could not send it. Please email info@visa-sc.com.",
    err_net="Connection error. Try again or email info@visa-sc.com.",
    privacy="Privacy policy",
    st1="Plan", st2="Travellers", st3="Confirm",
    next="Continue", back="Back", add="+ Add another traveller", send="Submit application",
    l_mail="Email to receive it", l_wa="Phone number",
    l_pass="Passport", l_first="First and middle name", l_last="Last name",
    l_birth="Date of birth", l_sex="Gender",
    w_trav="Traveller", w_del="Remove", w_m="Male", w_f="Female",
    w_people="Travellers", w_total="Total",
    err_fill="Please fill in first name, last name, date of birth and gender for each traveller.",
    order_h="Apply for your ETA",
    order_sub=("Three steps: pick the speed, tell us who is travelling, confirm. "
               "Payment is arranged afterwards, nothing is charged now."),
    flag="🇬🇧", product="United Kingdom ETA",
    aside=[("Fastest delivery", "15 minutes"), ("Valid for", "2 years"),
           ("Support", "in English"), ("Government fee included", "£20 per person")],
    p1_h="How soon do you fly?", p1_hint="Every plan includes the full review and the £20 government fee.",
    p2_h="Who is travelling", p2_hint="Enter names exactly as they appear in the passport.",
    p3_h="Review and submit", p3_hint="After submission a specialist confirms the details before charging.",
    countries=["United States", "Canada", "United Kingdom", "Australia", "Ireland", "Germany", "Other"],
    tiers=[dict(id="standard", name="Standard", time="Submitted within 24 hours", price=99, default=True),
           dict(id="rush", name="Rush", time="Submitted within 4 hours", price=139, tag="Most chosen"),
           dict(id="superrush", name="Super Rush", time="Submitted within 15 minutes", price=179)],
    who_h="What the UK ETA is",
    alert_b="Required for everyone, including infants and layovers",
    alert_p=("Since 8 January 2025 every US citizen travelling to the UK needs an ETA: tourism, "
             "business, visiting family, even a layover without leaving the airport. Without an "
             "approved ETA the airline will not let you board. Every passenger needs their own, "
             "children included. It lasts 2 years and covers every trip in that period."),
    gov=('<b>We are not a government body.</b> VSC is a private advisory company with no affiliation '
         'to the UK government. You can apply yourself on the official site '
         '<a href="https://www.gov.uk/apply-eta" target="_blank" rel="noopener nofollow">gov.uk</a> '
         'paying only the £20 government fee. What you pay here on top is our work: reviewing the form, '
         'checking the photo and passport, submitting and following it through.'),
    prob_h="Why applications get refused",
    problems=[("Photo that fails the standard",
               "The ETA needs a biometric photo taken on the spot. Wrong background, shadows or "
               "framing fail the application, and the fee is not refunded."),
              ("Details that differ from the passport",
               "A hyphenated surname, a middle name left out, one wrong digit: the system compares "
               "character by character and rejects any mismatch."),
              ("Vague answers on the suitability questions",
               "They look simple, but an imprecise answer turns an automatic approval into a manual "
               "review that takes weeks."),
              ("Applying at the last minute",
               "Most come back in minutes, but the Home Office allows itself up to 3 working days. "
               "Applying the night before the flight is a real risk.")],
    how_h="How it works",
    steps=[("You fill in the details", "Passport details in the form. Takes two minutes."),
           ("We check them", "Every field is compared with your document and we flag anything off."),
           ("We handle the process", "We look after it end to end, government fee included."),
           ("You get the decision", "The ETA is linked to your passport. We tell you as soon as it lands.")],
    faq_h="Frequently asked questions",
    faq=[("Do I need an ETA for a layover at Heathrow?",
          "Yes. It is required even if you transit without clearing immigration. Without it the "
          "airline will not let you board."),
         ("How long is the ETA valid?",
          "Two years, or until your passport expires, whichever comes first. In that window you can "
          "enter as often as you like, staying up to 6 months per visit."),
         ("Is it stamped in my passport?",
          "No. It is electronic and linked to your passport number. New passport means a new ETA."),
         ("Does my baby need one too?",
          "Yes, every passenger needs their own regardless of age. We can do the whole family at once."),
         ("Do you guarantee approval?",
          "No, and be wary of anyone who does: the decision belongs to the UK authorities. What we "
          "guarantee is an application free of filing errors, which is where most refusals come from."),
         ("Can I just do it myself?",
          "You can, and here is how: the application is made on gov.uk for £20. Our fee is for "
          "reviewing, guiding you and following it through."),
         ("How do I pay?",
          "We arrange it after the application. You get a receipt by email."),
         ("What if it is refused?",
          "The government does not refund the official fee under any circumstances. If the refusal "
          "comes from our mistake, we redo the application without charging our fee again.")],
    legal1=("VSC is a private travel documentation advisory company. We are not a consulate, an "
            "embassy or a government body, and we do not officially represent any country. The "
            "decision to grant or refuse an authorisation rests solely with the competent authorities."),
    legal2=("The information on this page is general, does not constitute legal advice and does not "
            "replace the official rules of the destination country. Official fees and timings may "
            "change without notice."),
)

for cfg in (BR, ES, IT, US):
    build(cfg)
