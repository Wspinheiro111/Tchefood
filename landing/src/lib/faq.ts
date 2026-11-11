/**
 * Perguntas frequentes. A mesma lista vira a seção "Dúvidas" da página e o FAQPage do
 * JSON-LD (src/lib/seo.ts), então o texto que o Google lê é sempre o que o cliente vê.
 */
import { PLANOS } from './config';

function brl(v: number): string {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function respostaPrecos(): string {
  const planos = PLANOS.map((p) => `${p.nome} por ${p.precoMensal === null ? 'valor sob consulta' : brl(p.precoMensal)}`);
  const ultimo = planos.pop();
  const tef = PLANOS.find((p) => p.recursos.some((r) => r.startsWith('TEF')));
  return (
    `São ${PLANOS.length} planos mensais: ${planos.join(', ')} e ${ultimo}.` +
    (tef ? ` O TEF integrado à maquininha está a partir do plano ${tef.nome}.` : '')
  );
}

export interface Pergunta {
  p: string;
  r: string;
}

export const PERGUNTAS: Pergunta[] = [
  {
    p: 'O que é o Tchê Food?',
    r: 'É um sistema para restaurantes, bares, churrascarias, pizzarias, lancherias e delivery. Junta comanda no celular do garçom, PDV de caixa, tela da cozinha (KDS), totem de autoatendimento, cardápio digital QR Code, delivery próprio, controle de caixa, cashback e NFC-e num sistema só.',
  },
  {
    p: 'Preciso comprar tablets ou computadores novos?',
    r: 'Não. O garçom usa o próprio celular pelo navegador, o caixa usa o computador que você já tem e a cozinha pode usar qualquer tela ou TV com navegador. Garçons são ilimitados em todos os planos.',
  },
  {
    p: 'Funciona com a minha maquininha?',
    r: 'O Tchê Food tem integração com as maquininhas Smart da Stone, do PagBank e do Mercado Pago. A integração (TEF) está nos planos a partir do Churrascaria & Salão Pro e é ativada na implantação com o contrato da sua loja. Na demonstração confirmamos o modelo que você tem.',
  },
  {
    p: 'E se a internet cair no meio do movimento?',
    r: 'As vendas continuam. Os pedidos ficam guardados no aparelho e sobem sozinhos para a nuvem quando a conexão volta, sem perder nada.',
  },
  {
    p: 'O sistema emite NFC-e?',
    r: 'Sim. A emissão da NFC-e modelo 65 é feita pela Focus NFe, com os dados do pagamento vinculados e DANFE na bobina. Ela é ativada na implantação com o certificado digital A1 e o CSC da sua empresa.',
  },
  {
    p: 'Tem cardápio digital QR Code?',
    r: 'Tem, incluso em todos os planos. O cliente lê o QR Code da mesa, vê o cardápio com fotos, faz o pedido e pede a conta pelo celular. Também há o cardápio 3D com realidade aumentada, que mostra o prato em cima da mesa pela câmera.',
  },
  {
    p: 'Serve para delivery?',
    r: 'Sim. O delivery próprio já funciona: cadastro do cliente pelo telefone, taxa por bairro, entregador, rota no Google Maps e acerto com o entregador. A integração com iFood e outros aplicativos de delivery está chegando.',
  },
  {
    p: 'Como o sistema evita fraude e desvio no caixa?',
    r: 'Cancelar item, dar desconto ou tirar os 10% exige PIN de gerente e motivo, e tudo fica registrado com quem autorizou. O caixa fecha às cegas: o operador conta o dinheiro sem ver o valor esperado, e a diferença só aparece para o gerente.',
  },
  {
    p: 'Quanto custa?',
    r: respostaPrecos(),
  },
  {
    p: 'Como funciona a implantação?',
    r: 'Cadastramos seu cardápio, configuramos impressoras e maquininhas e treinamos a equipe. Você combina a data direto com a gente pelo WhatsApp.',
  },
];
