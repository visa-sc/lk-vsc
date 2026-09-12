# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_eta import build

COMMON = dict(
    lang="pt-BR", locale="pt_BR", num_loc="pt-BR", cur="R$ ", cur_code="BRL",
    tel="+55 11 4210-8500", tel_h="+551142108500",
    office_city="São Paulo",
    office_addr="Av. Paulista, 1374 — Bela Vista, São Paulo — SP, 01310-100",
    ph_name="Nome completo, como no passaporte",
    ph_mail="E-mail",
    ph_phone="WhatsApp com DDD *",
    consent='Ao enviar, você concorda com o tratamento dos seus <a href="/files/policy_20241106155551.pdf" target="_blank" rel="noopener">dados pessoais</a>.',
    done_h="Recebemos o seu pedido",
    done_p="Um especialista entra em contato pelo WhatsApp para confirmar os dados.",
    err_phone="Informe um telefone válido com o DDD.",
    sending="Enviando...",
    err_send="Não foi possível enviar. Escreva para info@visa-sc.com.",
    err_net="Erro de conexão. Tente novamente ou escreva para info@visa-sc.com.",
    hours_br="Seg a sex, 9h às 19h (horário de Brasília)",
    hours_uk="Mon to Fri, 8am to 5pm (London time)",
    privacy="Política de privacidade",
    wa_btn="Falar no WhatsApp",
    # ── мастер оформления ──
    st1="Dados", st2="Viajantes", st3="Confirmar",
    next="Continuar", back="Voltar", add="+ Adicionar outro viajante",
    send="Enviar pedido",
    l_mail="E-mail para receber", l_wa="WhatsApp com DDD",
    l_pass="Passaporte", l_first="Nome e nome do meio", l_last="Sobrenome",
    l_birth="Data de nascimento", l_sex="Sexo",
    w_trav="Viajante", w_del="Remover", w_m="Masculino", w_f="Feminino",
    w_people="Viajantes", w_total="Total",
    err_fill="Preencha nome, sobrenome, data de nascimento e sexo de cada viajante.",

    btn_s="Pedido",
    nav=["Quem precisa", "Preços", "Como funciona", "Dúvidas", "Contato"],
    legal2=("As informações desta página têm caráter informativo, não constituem "
            "aconselhamento jurídico e não substituem as regras oficiais do país de destino. "
            "Prazos e valores oficiais podem mudar sem aviso prévio."),
)

# ─────────────────────────── Reino Unido ───────────────────────────
GB = dict(COMMON,
    file="br/gb.html", path="/br/gb", url="https://visa-sc.com/br/gb", form="br-gb",
    title="ETA do Reino Unido para brasileiros — preenchemos o seu pedido | VSC",
    desc=("ETA do Reino Unido é obrigatória para brasileiros desde janeiro de 2025. "
          "Preenchemos e revisamos o seu pedido, conferimos a foto e o passaporte, "
          "acompanhamos até a resposta. Taxa oficial de £20 separada da nossa taxa de serviço."),
    og_title="ETA do Reino Unido para brasileiros",
    og_desc="Preenchemos, revisamos e acompanhamos o seu pedido até a resposta.",
    h1=('ETA do Reino Unido para brasileiros.<br>'
        '<span class="hl">Preenchemos, revisamos e acompanhamos.</span>'),
    sub=("Obrigatória para todo brasileiro que viaja ao Reino Unido, inclusive em conexão.<br>"
         "Um erro no formulário custa a recusa e uma nova taxa — conferimos cada campo antes de enviar.<br>"
         "Você manda os dados pelo WhatsApp e acompanha o resto pelo celular."),
    facts=[("Taxa oficial", "£20"), ("Validade", "2 anos"),
           ("Resposta", "até 3 dias úteis"), ("Estadia", "até 6 meses"),
           ("Entradas", "quantas quiser"), ("Suporte", "em português")],
    btn="Solicitar minha ETA",
    form_title="Solicitar a ETA", form_title2="do Reino Unido",
    form_sub="Conferimos os seus dados antes de enviar. Sem compromisso até você confirmar o pagamento.",
    form_sub2="Um especialista responde pelo WhatsApp e explica o próximo passo.",

    who_h="Quem precisa da ETA",
    alert_b="Todo brasileiro precisa, sem exceção",
    alert_p=("Desde 8 de janeiro de 2025 a ETA é obrigatória para brasileiros em qualquer viagem ao "
             "Reino Unido: turismo, negócios, visita a parentes, estudo de curta duração e até "
             "conexão sem sair do aeroporto. Sem ETA aprovada a companhia aérea não deixa embarcar. "
             "Vale para bebês e crianças também — cada passageiro precisa da sua."),
    gov=('<b>Não somos um órgão do governo.</b> A VSC é uma empresa privada de assessoria e não tem '
         'vínculo com o governo do Reino Unido. Você pode solicitar a ETA por conta própria no site '
         'oficial <a href="https://www.gov.uk/apply-eta" target="_blank" rel="noopener nofollow">gov.uk</a> '
         'pagando apenas a taxa oficial de £20. O que você paga aqui a mais é o nosso trabalho: '
         'revisão do formulário, conferência da foto e do passaporte, acompanhamento até a resposta '
         'e suporte em português.'),

    prob_h="Por que pedidos são recusados",
    problems=[
        ("Foto fora do padrão",
         "A ETA exige foto no padrão biométrico tirada na hora pelo aplicativo. Fundo, sombra e "
         "enquadramento errados reprovam o pedido e a taxa não volta."),
        ("Dados diferentes do passaporte",
         "Nome com acento, sobrenome composto, número do passaporte digitado errado: o sistema "
         "compara caractere por caractere e recusa qualquer divergência."),
        ("Resposta errada sobre antecedentes",
         "As perguntas sobre condenações e recusas anteriores parecem simples, mas uma resposta "
         "imprecisa transforma um pedido automático em análise manual de semanas."),
        ("Pedido em cima da hora",
         "A maioria sai em minutos, mas o governo se reserva até 3 dias úteis. Quem pede na véspera "
         "do voo corre risco real de perder a viagem."),
    ],

    order_h="Solicite a sua ETA",
    order_sub=("Três passos: escolher a velocidade, informar quem viaja e confirmar. "
               "O pagamento é combinado depois pelo WhatsApp, nada é cobrado agora."),
    flag="🇬🇧", product="ETA do Reino Unido",
    aside=[("Entrega mais rápida", "15 minutos"),
           ("Revisão", "antes de enviar"),
           ("Atendimento", "em português"),
           ("Taxa oficial inclusa", "£20 por pessoa")],
    p1_h="Qual a pressa?", p1_hint="Todos os planos incluem a revisão completa e a taxa oficial de £20.",
    p2_h="Quem vai viajar", p2_hint="Escreva exatamente como está no passaporte, sem abreviar.",
    p3_h="Confira e envie", p3_hint="Depois do envio, um especialista confirma tudo pelo WhatsApp.",
    countries=["Brasil","Portugal","Argentina","Chile","Uruguai","Paraguai","México","Colômbia",
               "Estados Unidos","Canadá","Espanha","Itália","Alemanha","França","Japão","Outro"],
    tiers=[
        dict(id="padrao", name="Padrão", time="Pronto em até 24 horas", price=599, default=True),
        dict(id="rapido", name="Rápido", time="Pronto em até 4 horas", price=799, tag="Mais escolhido"),
        dict(id="urgente", name="Urgente", time="Pronto em até 15 minutos", price=999),
    ],

    how_h="Como funciona",
    steps=[("Você manda os dados",
            "Foto do passaporte e uma selfie pelo WhatsApp ou pelo formulário. Leva dois minutos."),
           ("A gente confere",
            "Comparamos cada campo com o passaporte e checamos se a foto atende ao padrão exigido."),
           ("Enviamos e pagamos a taxa",
            "Fazemos o pedido no sistema oficial e pagamos a taxa de £20 em seu nome."),
           ("Você recebe a resposta",
            "A ETA fica vinculada ao passaporte eletronicamente. Avisamos assim que sair.")],

    faq_h="Dúvidas frequentes",
    faq=[
        ("Preciso de ETA se for só fazer conexão em Londres?",
         "Sim. A ETA é exigida inclusive para quem faz conexão sem passar pela imigração. "
         "Sem ela, a companhia aérea não autoriza o embarque."),
        ("Quanto tempo a ETA vale?",
         "Dois anos ou até o vencimento do passaporte, o que acontecer primeiro. Dentro desse "
         "período você entra quantas vezes quiser, com estadia de até 6 meses por visita."),
        ("A ETA é colada no passaporte?",
         "Não. Ela é eletrônica e fica vinculada ao número do passaporte. Por isso, se você trocar "
         "de passaporte, precisa solicitar uma nova."),
        ("Meu filho pequeno também precisa?",
         "Sim, cada passageiro precisa da sua própria ETA, independentemente da idade. "
         "Fazemos o pedido da família inteira de uma vez."),
        ("Vocês garantem que vai ser aprovado?",
         "Não, e desconfie de quem garantir: a decisão é exclusiva das autoridades britânicas. "
         "O que garantimos é que o pedido vai sem erros de preenchimento — que é onde a maioria "
         "das recusas acontece. Se o erro for nosso, refazemos sem cobrar."),
        ("Posso fazer sozinho?",
         "Pode, e explicamos como: o pedido é feito no site oficial gov.uk pelo aplicativo, pagando "
         "£20. A nossa taxa é pelo trabalho de revisar, enviar e acompanhar em português."),
        ("Como faço o pagamento?",
         "Pix ou cartão de crédito. Você recebe o comprovante e o recibo por e-mail."),
        ("E se a ETA for recusada?",
         "A taxa oficial não é devolvida pelo governo em nenhuma hipótese. Se a recusa vier de um "
         "erro de preenchimento nosso, refazemos o pedido sem cobrar a nossa taxa novamente."),
    ],
    legal1=("A VSC é uma empresa privada de assessoria em documentação de viagem. Não somos "
            "consulado, embaixada nem órgão do governo, e não representamos oficialmente nenhum país. "
            "A decisão sobre conceder ou negar a autorização é exclusiva das autoridades competentes."),
)

# ─────────────────────────── Canadá ───────────────────────────
CA = dict(COMMON,
    file="br/canada.html", path="/br/canada", url="https://visa-sc.com/br/canada", form="br-ca",
    title="eTA do Canadá para brasileiros — solicite online | VSC",
    desc=("eTA do Canadá para brasileiros: autorização eletrônica válida por 5 anos para viagens "
          "de turismo e negócios. Revisamos cada campo antes de enviar, atendimento em português. "
          "Taxa oficial CAD 7 inclusa no valor."),
    og_title="eTA do Canadá para brasileiros",
    og_desc="Solicite online, com revisão antes do envio e atendimento em português.",
    h1=('eTA do Canadá para brasileiros.<br>'
        '<span class="hl">Rápido, em português e sem erro no formulário.</span>'),
    sub=("Autorização eletrônica para entrar no Canadá por via aérea, válida por 5 anos.<br>"
         "Conferimos cada campo com o seu passaporte antes de enviar — erro de digitação custa recusa.<br>"
         "Você manda os dados pelo celular e acompanha o resto pelo WhatsApp."),
    facts=[("Taxa oficial", "CAD 7"), ("Validade", "5 anos"),
           ("Resposta", "a partir de 3h"), ("Estadia", "até 6 meses"),
           ("Entradas", "quantas quiser"), ("Suporte", "em português")],
    btn="Solicitar minha eTA",
    form_title="Solicitar a eTA", form_title2="do Canadá",
    form_sub="Conferimos os seus dados antes de enviar. Nada é cobrado agora.",
    form_sub2="Um especialista responde pelo WhatsApp e explica o próximo passo.",

    who_h="O que é a eTA do Canadá",
    alert_b="Vale para quem chega de avião, por 5 anos",
    alert_p=("A eTA é a autorização eletrônica para turismo e negócios no Canadá, com estadia de até "
             "6 meses por visita. Fica vinculada ao passaporte, vale <b>5 anos</b> e serve para quantas "
             "viagens você fizer nesse período. Vale para quem chega ou faz conexão <b>por via aérea</b>; "
             "para entrada de carro, ônibus ou navio as regras são outras e a gente explica no atendimento."),
    gov=('<b>Não somos um órgão do governo.</b> A VSC é uma empresa privada de assessoria e não tem '
         'vínculo com o governo do Canadá. Você pode solicitar a eTA por conta própria no site oficial '
         '<a href="https://www.canada.ca/en/immigration-refugees-citizenship/services/visit-canada/eta.html" '
         'target="_blank" rel="noopener nofollow">canada.ca</a> pagando apenas a taxa oficial de CAD 7. '
         'O que você paga aqui a mais é o nosso trabalho: revisar o formulário, enviar '
         'e acompanhar em português.'),

    prob_h="Por que pedidos são recusados",
    problems=[
        ("Foto e dados fora do padrão",
         "O sistema canadense compara cada campo com o passaporte e recusa qualquer divergência: "
         "acento no nome, sobrenome composto, um dígito errado no número do documento."),
        ("Esquecem que vale só para avião",
         "Com eTA você entra voando. Chegando de carro pela fronteira dos Estados Unidos ou de navio, "
         "a eTA não serve e a entrada é negada."),
        ("Passaporte trocado depois da aprovação",
         "A eTA fica vinculada ao número do passaporte. Passaporte novo, eTA nova — mesmo que os "
         "5 anos ainda não tenham acabado."),
        ("Dados fora do padrão do passaporte",
         "Nome com acento, sobrenome composto, número digitado errado. O sistema compara caractere "
         "por caractere e recusa qualquer divergência."),
    ],

    order_h="Solicite a sua eTA",
    order_sub=("Três passos: escolher a velocidade, informar quem viaja e confirmar. "
               "O pagamento é combinado depois pelo WhatsApp, nada é cobrado agora."),
    flag="🇨🇦", product="eTA do Canadá",
    aside=[("Entrega mais rápida", "3 horas"),
           ("Validade", "5 anos"),
           ("Atendimento", "em português"),
           ("Taxa oficial inclusa", "CAD 7 por pessoa")],
    p1_h="Qual a pressa?", p1_hint="Todos os planos incluem a checagem de elegibilidade e a taxa oficial de CAD 7.",
    p2_h="Quem vai viajar", p2_hint="Escreva exatamente como está no passaporte, sem abreviar.",
    p3_h="Confira e envie", p3_hint="Antes de cobrar, confirmamos pelo WhatsApp se a eTA se aplica ao seu caso.",
    countries=["Brasil","Argentina","Chile","México","Uruguai","Panamá","Costa Rica",
               "Tailândia","Filipinas","Marrocos","Trinidad e Tobago","Seicheles","Outro"],
    tiers=[
        dict(id="padrao", name="Padrão", time="Pronto em até 24 horas", price=499, default=True),
        dict(id="rapido", name="Rápido", time="Pronto em até 6 horas", price=699, tag="Mais escolhido"),
        dict(id="urgente", name="Urgente", time="Pronto em até 3 horas", price=899),
    ],

    how_h="Como funciona",
    steps=[("Você manda os dados",
            "Passaporte e dados básicos pelo formulário. Leva dois minutos."),
           ("A gente confere",
            "Comparamos cada campo com o passaporte e confirmamos tudo com você."),
           ("Cuidamos do processo",
            "Acompanhamos o pedido do início ao fim, incluindo a taxa oficial de CAD 7."),
           ("Você recebe a resposta",
            "A eTA fica vinculada ao passaporte eletronicamente e vale por 5 anos.")],

    faq_h="Dúvidas frequentes",
    faq=[
        ("Todo brasileiro pode usar a eTA?",
         "A maioria sim, e a gente confirma isso no atendimento antes de qualquer cobrança. "
         "Em alguns casos o consulado pede o visto de visitante no lugar da eTA — se for o seu caso, "
         "avisamos na hora e explicamos o caminho, sem cobrar nada por isso."),
        ("Posso entrar de carro pelos Estados Unidos com eTA?",
         "Não. A eTA vale apenas para quem chega ou faz conexão por via aérea. Para entrada "
         "terrestre ou marítima é preciso visto, mesmo tendo eTA aprovada."),
        ("Quanto tempo vale a eTA?",
         "Cinco anos ou até o vencimento do passaporte, o que vier primeiro. Dentro desse período "
         "você pode entrar várias vezes, com estadia de até 6 meses por visita."),
        ("Quanto tempo demora a resposta?",
         "A maioria sai em minutos, mas o governo pode pedir documentos adicionais e levar alguns "
         "dias. Por isso recomendamos pedir com pelo menos uma semana de antecedência."),
        ("Vocês garantem a aprovação?",
         "Não, e desconfie de quem garantir: a decisão é exclusiva das autoridades canadenses. "
         "O que garantimos é a verificação honesta antes de você gastar e o preenchimento sem erros."),
        ("Como faço o pagamento?",
         "Pix ou cartão de crédito, só depois da verificação gratuita. "
         "Você recebe comprovante e recibo por e-mail."),
        ("Posso fazer sozinho?",
         "Pode, e explicamos como: o pedido é feito no site oficial canada.ca pagando CAD 7. "
         "A nossa taxa é pelo trabalho de verificar, revisar e acompanhar em português."),
    ],
    legal1=("A VSC é uma empresa privada de assessoria em documentação de viagem. Não somos "
            "consulado, embaixada nem órgão do governo, e não representamos oficialmente nenhum país. "
            "A decisão sobre conceder ou negar a autorização é exclusiva das autoridades competentes."),
)

for cfg in (CA,):
    build(cfg)
