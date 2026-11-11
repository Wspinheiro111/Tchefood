/**
 * Lista completa do que o Tchê Food faz, agrupada por área.
 *
 * Regra desta lista: só é "pronto" o que já roda no sistema hoje. O que já está programado
 * mas depende de credencial ou contrato da própria loja (certificado A1 e CSC da NFC-e,
 * contrato da maquininha, balança física) é "implantacao". O que depende de parceria ou de
 * provedor que ainda não temos é "em-breve". Antes de mudar um status, confira no README
 * do sistema (seção "O que ainda é simulado").
 */

export type StatusFuncao = 'pronto' | 'implantacao' | 'em-breve';

export interface Funcao {
  titulo: string;
  texto: string;
  status: StatusFuncao;
}

export interface GrupoFuncoes {
  id: string;
  titulo: string;
  resumo: string;
  funcoes: Funcao[];
}

export const ROTULO_STATUS: Record<StatusFuncao, string> = {
  pronto: 'Pronto',
  implantacao: 'Ativado na implantação',
  'em-breve': 'Em breve',
};

export const GRUPOS_FUNCOES: GrupoFuncoes[] = [
  {
    id: 'salao',
    titulo: 'Salão, mesas e comandas',
    resumo: 'Comanda eletrônica no celular do garçom, do mapa de mesas ao fechamento da conta.',
    funcoes: [
      {
        titulo: 'Comanda no celular do garçom',
        texto:
          'Mapa de mesas por ambiente, lançamento por código rápido, ponto da carne obrigatório, adicionais, meio a meio e observações. O pedido cai na cozinha na hora.',
        status: 'pronto',
      },
      {
        titulo: 'Comanda por cartão numerado',
        texto:
          'Para bar, balada e restaurante sem mesa fixa: o garçom digita ou bipa o número do cartão e cai direto na conta do cliente.',
        status: 'pronto',
      },
      {
        titulo: 'Rachadinha: divisão de conta',
        texto: 'Divide por pessoa, por valor livre ou pelos itens que cada um consumiu, com os 10% proporcionais.',
        status: 'pronto',
      },
      {
        titulo: 'Taxa de serviço com rateio por garçom',
        texto: 'Taxa de 0 a 20% configurável e relatório exato de quanto cada garçom tem a receber dos 10%.',
        status: 'pronto',
      },
      {
        titulo: 'Extrato de conferência',
        texto: 'Conta parcial impressa na mesa antes do pagamento, para o cliente conferir.',
        status: 'pronto',
      },
    ],
  },
  {
    id: 'cardapio',
    titulo: 'Cardápio digital',
    resumo: 'Cardápio QR Code na mesa e cardápio 3D com realidade aumentada, sem o cliente instalar nada.',
    funcoes: [
      {
        titulo: 'Cardápio QR Code na mesa',
        texto: 'O cliente lê o QR da mesa, vê o cardápio com fotos, faz o pedido pelo celular e pede a conta.',
        status: 'pronto',
      },
      {
        titulo: 'Cardápio 3D e realidade aumentada',
        texto:
          'O cliente aponta a câmera e vê o prato em cima da mesa, no tamanho real, com os ingredientes separados e identificados.',
        status: 'pronto',
      },
      {
        titulo: 'Happy hour e preço por horário',
        texto: 'Preço diferente por dia da semana e horário, aplicado sozinho, inclusive em janelas que viram a meia-noite.',
        status: 'pronto',
      },
      {
        titulo: 'Combos e esgotado em um toque',
        texto: 'Combos com escolhas e acréscimos. Produto esgotado sai da venda em um toque, inclusive pela cozinha.',
        status: 'pronto',
      },
    ],
  },
  {
    id: 'balcao',
    titulo: 'Balcão, PDV e autoatendimento',
    resumo: 'PDV para o caixa, totem para o cliente pedir sozinho e painel de senhas na TV.',
    funcoes: [
      {
        titulo: 'PDV / Caixa com teclado e código de barras',
        texto:
          'Busca por nome, código ou leitor de código de barras, atalhos de teclado (F1 a F9), pedido para comer aqui ou para levar e senha do pedido.',
        status: 'pronto',
      },
      {
        titulo: 'Totem de autoatendimento',
        texto:
          'O cliente monta o pedido sozinho, com fotos e opções, escolhe comer aqui ou levar e recebe a senha. O pedido só vai para a cozinha depois de pago.',
        status: 'pronto',
      },
      {
        titulo: 'Painel de senhas na TV',
        texto: 'Colunas Preparando e Pronto, com o número piscando, sinal sonoro e a TV falando a senha.',
        status: 'pronto',
      },
      {
        titulo: 'Ficha rápida para balcão e eventos',
        texto:
          'Vende sem abrir mesa e imprime uma ficha por unidade com QR Code antifraude. Cada ficha só é aceita uma vez na retirada.',
        status: 'pronto',
      },
      {
        titulo: 'Controle de barril de chopp',
        texto: 'Cada chopp vendido baixa o nível do barril. Alerta quando o volume real não bate com o faturado.',
        status: 'pronto',
      },
      {
        titulo: 'Buffet a quilo com balança',
        texto: 'Leitura de balança no protocolo Toledo/Filizola, tara por recipiente e preço do quilo vindo do cadastro.',
        status: 'implantacao',
      },
    ],
  },
  {
    id: 'cozinha',
    titulo: 'Cozinha e impressão',
    resumo: 'Tela de cozinha (KDS) por praça e impressão automática em qualquer impressora térmica.',
    funcoes: [
      {
        titulo: 'KDS: tela da cozinha multipraça',
        texto: 'Pedidos separados por praça, com o tempo de preparo em verde, amarelo e vermelho piscante.',
        status: 'pronto',
      },
      {
        titulo: 'Impressão térmica ESC/POS 58 e 80 mm',
        texto: 'Cada praça com sua impressora e roteamento automático: a bebida sai no bar, o prato sai na cozinha.',
        status: 'pronto',
      },
    ],
  },
  {
    id: 'delivery',
    titulo: 'Delivery',
    resumo: 'Entrega própria completa hoje e caixa de entrada única para os aplicativos de delivery.',
    funcoes: [
      {
        titulo: 'Delivery próprio',
        texto:
          'Cliente encontrado pelo telefone, taxa por bairro, entregador, rota no Google Maps com até 10 paradas e acerto do dinheiro com o entregador.',
        status: 'pronto',
      },
      {
        titulo: 'Pedidos do iFood no mesmo sistema',
        texto: 'Aceitar, preparar, marcar pronto e despachar os pedidos do iFood sem sair do Tchê Food.',
        status: 'em-breve',
      },
      {
        titulo: '99Food, Keeta, Aiqfome, Anota AI e outros',
        texto: 'Os outros aplicativos entram na mesma caixa de entrada conforme as parcerias forem liberadas.',
        status: 'em-breve',
      },
    ],
  },
  {
    id: 'pagamentos',
    titulo: 'Pagamentos e fiscal',
    resumo: 'Maquininha integrada, NFC-e e entrada de nota de compra pelo XML.',
    funcoes: [
      {
        titulo: 'Maquininha integrada (TEF): Stone, PagBank e Mercado Pago',
        texto:
          'Cobrança enviada do sistema para a maquininha Smart, com o valor certo. Só aprova com o comprovante completo (NSU e autorização), nunca inventado.',
        status: 'implantacao',
      },
      {
        titulo: 'NFC-e modelo 65 (SEFAZ-RS)',
        texto:
          'Emissão pela Focus NFe com os dados do pagamento vinculados e DANFE na bobina. Ativada com o certificado A1 e o CSC da sua loja.',
        status: 'implantacao',
      },
      {
        titulo: 'Compras pelo XML da NF-e e estoque',
        texto:
          'Lê o XML da nota do fornecedor, dá entrada no estoque, converte a embalagem e recalcula o custo médio de cada produto.',
        status: 'pronto',
      },
    ],
  },
  {
    id: 'gestao',
    titulo: 'Gestão e controle',
    resumo: 'Caixa, painel do dono, taxas, recebíveis, relatórios e antifraude.',
    funcoes: [
      {
        titulo: 'Controle de caixa com fechamento às cegas',
        texto:
          'Abertura com fundo de troco, suprimento, sangria com PIN de gerente e fechamento às cegas: o operador conta sem ver o valor esperado.',
        status: 'pronto',
      },
      {
        titulo: 'Painel do dono',
        texto:
          'Quanto vendeu hoje contra a semana passada, projeção e meta do dia, canais de venda, o que vende e o que encalha, cancelamentos e clientes que voltam.',
        status: 'pronto',
      },
      {
        titulo: 'Taxas da maquininha e agenda de recebíveis',
        texto:
          'Cadastre as taxas do seu contrato e veja quanto sobrou de verdade e quanto cai na conta em cada dia dos próximos 35 dias.',
        status: 'pronto',
      },
      {
        titulo: 'Relatórios e conciliação',
        texto: 'Relatório do turno, conciliação maquininha × caixa por forma de pagamento e rateio dos 10%.',
        status: 'pronto',
      },
      {
        titulo: 'Antifraude com PIN de gerente',
        texto:
          'Cancelar item, dar desconto ou tirar os 10% só com PIN de gerente e motivo. Tudo fica registrado com quem autorizou.',
        status: 'pronto',
      },
      {
        titulo: 'Equipe e permissões por perfil',
        texto: 'Garçom, caixa, cozinha, gerente e proprietário, cada um com o seu PIN e só com o que pode fazer.',
        status: 'pronto',
      },
      {
        titulo: 'Alerta de cancelamento no WhatsApp do dono',
        texto: 'Aviso automático no seu celular a cada cancelamento ou estorno, mesmo longe do restaurante.',
        status: 'em-breve',
      },
    ],
  },
  {
    id: 'clientes',
    titulo: 'Clientes e fidelidade',
    resumo: 'Cashback, campanha para quem sumiu e avaliação no fim da conta.',
    funcoes: [
      {
        titulo: 'Cashback e fidelidade',
        texto:
          'O cliente que autoriza recebe cashback do consumo, com validade e regra de resgate, e a mensagem pronta para enviar no WhatsApp.',
        status: 'pronto',
      },
      {
        titulo: 'Cliente sumido',
        texto: 'Lista quem não volta há 30 dias ou mais, com a mensagem da campanha e o cupom prontos para chamar no WhatsApp.',
        status: 'pronto',
      },
      {
        titulo: 'Avaliação de 1 a 5 estrelas',
        texto: 'O cliente avalia na hora de fechar a conta e as reclamações aparecem no painel do dono.',
        status: 'pronto',
      },
    ],
  },
  {
    id: 'tecnologia',
    titulo: 'Tecnologia',
    resumo: 'Funciona sem internet, sem servidor no restaurante e em qualquer aparelho.',
    funcoes: [
      {
        titulo: 'Funciona sem internet',
        texto: 'Se a internet cair, as vendas continuam e ficam guardadas no aparelho. Quando volta, tudo sobe sozinho para a nuvem.',
        status: 'pronto',
      },
      {
        titulo: 'Na nuvem, sem servidor no caixa',
        texto: 'Roda no navegador do celular, do tablet, do computador e da maquininha Smart. Nada de servidor Windows para travar.',
        status: 'pronto',
      },
      {
        titulo: 'Várias unidades num painel só',
        texto: 'Visão consolidada das vendas de todas as lojas da rede.',
        status: 'em-breve',
      },
    ],
  },
];

export function todasAsFuncoes(): Funcao[] {
  return GRUPOS_FUNCOES.flatMap((g) => g.funcoes);
}
