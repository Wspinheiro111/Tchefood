# Tchê Food — Landing page comercial

Site de vendas do **Tchê Food — Da Comanda à Maquininha** (W9 Sistemas). App independente em React 18 + TypeScript + Vite + Tailwind, sem backend.

## Rodar

```bash
cd landing
npm install
npm run dev      # desenvolvimento
npm test         # testes da calculadora
npm run build    # gera dist/ (site estático, pode ir para Vercel, Netlify ou qualquer hospedagem)
```

## Antes de publicar

Tudo fica em `src/lib/config.ts`:

- `WHATSAPP_NUMERO`: número comercial, só dígitos com DDI e DDD (ex.: `5551999998888`). Já configurado: (55) 99653-8255.
- `PLANOS[].precoMensal`: mensalidade de cada plano. Com `null` o card mostra "Sob consulta".
- `EM_BREVE`: recursos anunciados que ainda não estão prontos (aparecem com selo "Em breve").

## Calculadora

A lógica fica em `src/lib/calculadora.ts`, com as premissas em `PREMISSAS` (custo de tablet, computador de apoio, minutos economizados por fechamento, perda de caixa etc.). A página mostra essas premissas para o cliente em "Ver premissas do cálculo". Ajuste os valores ali se quiser números diferentes.

## Seções

Hero com simulação interativa da rachadinha · Benefícios · Calculadora de economia · Comparativo com sistemas tradicionais · 3 planos · Dúvidas · CTA final · Botão flutuante do WhatsApp.
