#!/usr/bin/env node
// Gera o texto da auditoria GPT de um PR (processo em docs/auditoria-gpt.md).
// Só usa git: roda em qualquer clone, sem token do GitHub.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "https://github.com/Wspinheiro111/Tchefood";
const LIMITE_COLAR = 120_000;
const EXCLUIR = [":(exclude)package-lock.json"];
const BINARIO = /\.(png|jpe?g|gif|webp|ico|glb|gltf|usdz|apk|jar|zip|pdf|ttf|woff2?)$/i;

const INSTRUCOES = `Você é um auditor sênior independente de código. Audite o pull request abaixo do Tchê Food, um SaaS de restaurante (comanda do garçom, caixa, PDV, KDS, delivery, totem, NFC-e, maquininhas Stone/PagBank/Mercado Pago). Stack: React 18 + TypeScript estrito + Vite + Zustand persistido em IndexedDB (offline-first), Supabase/Postgres (SQL em db/ e supabase/migrations, RPCs e triggers), Edge Functions e servidor Node em server/. Dinheiro sempre em centavos inteiros.

Audite SOMENTE o que este PR muda (o diff está no fim). Código fora do diff só conta se o PR quebrar o uso dele.

EIXOS DE RISCO (confira cada um que o diff tocar):
1. Dinheiro: centavos inteiros, arredondamento, soma de itens/10%/descontos/taxas, rachadinha, troco; conta só fecha com saldo 0,00; nada de float em valor.
2. Alçada: cancelar, desconto, tirar os 10%, sangria, estorno exigem PIN de gerente e motivo, com audit_logs; a regra tem de valer no servidor (RPC/trigger), não só na tela.
3. Isolamento por loja (multi-tenant): toda leitura/escrita filtrada pela loja; RLS e RPCs não deixam uma loja ver ou alterar dado de outra.
4. Offline e sincronização: fila de eventos (outbox), reenvio sem duplicar (idempotência por id), conflito entre aparelhos, evento recusado pelo servidor não trava a fila nem some.
5. Maquininha/TEF: aprovado só com prova completa (código, NSU, autorização, valor batendo); NSU/autorização NUNCA inventados; resultado incerto vira revisão manual; sem cobrança dupla.
6. Fiscal (NFC-e modelo 65): ambiente explícito (homologação/produção), sem CSC/token de demonstração em produção, chave e QR Code consistentes, tributos.
7. Datas: fuso America/Sao_Paulo; "hoje", turno e virada do dia corretos; coluna DATE vs timestamp.
8. Estado salvo no aparelho: mudou o formato do Zustand persist? Precisa subir a versão e migrar sem perder vendas abertas, caixa aberto ou fila de sincronização.
9. Banco: SQL idempotente (IF NOT EXISTS), migração na ordem certa, triggers anti-fraude não enfraquecidos, nomes de campo iguais ao TypeScript.
10. Segurança: segredos/tokens fora do navegador e do diff, entrada validada, XSS em texto digitado pelo cliente (QR/totem/delivery), links de WhatsApp montados com encode.
11. Regressão e testes: o que já funcionava continua funcionando; regra crítica nova tem teste que falharia sem ela.

REGRAS:
- Não invente. Cada achado precisa de evidência no diff (arquivo, linha e trecho). Se não der para confirmar só com o diff, coloque em "A verificar", sem severidade de bloqueio.
- Não liste estilo, nomes ou preferências como achado.
- Severidade: P0 = perde dinheiro, vaza dado de outra loja, fraude possível ou nota fiscal errada; P1 = fluxo principal quebrado ou regra de negócio errada; P2 = caso de borda errado, erro silencioso ou regra crítica sem teste; P3 = melhoria sem efeito hoje.
- APROVADO = nenhum P0, P1 ou P2 (P3 não bloqueia). REPROVADO = pelo menos um P0, P1 ou P2.

FORMATO DA RESPOSTA (em português):
Primeira linha exatamente: VEREDITO: APROVADO  ou  VEREDITO: REPROVADO
Depois:
## Resumo (até 5 linhas)
## Achados
Para cada um:
- ID: P1-01 (severidade-número)
- Arquivo: caminho:linha
- Evidência: trecho do diff
- Cenário de falha: entrada/estado concreto -> resultado errado
- Correção sugerida
- Critério de aceite (teste objetivo)
## A verificar (pontos que dependem de código fora do diff)
## Pontos fortes confirmados`;

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${nome} precisa de um valor`);
  return v;
}

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const pr = arg("pr");
const titulo = arg("title", "");
const base = arg("base", "origin/main");
const head = arg("head", "HEAD");
const bodyFile = arg("body-file");
const out = arg("out");
const rodada = Number(arg("rodada", "1"));
const anterior = arg("anterior", "");
if (!pr) {
  console.error("uso: node scripts/auditoria-gpt.mjs --pr <n> [--title t] [--base ref] [--head ref] [--body-file f] [--out dir|arquivo] [--rodada n] [--anterior texto]");
  process.exit(1);
}

const headSha = git("rev-parse", head).trim();
const baseSha = git("merge-base", base, head).trim();
const arquivos = git("diff", "--name-status", baseSha, headSha)
  .trim()
  .split("\n")
  .filter(Boolean);
const binarios = arquivos.filter((l) => BINARIO.test(l.split("\t").pop()));
const exclBin = binarios.map((l) => `:(exclude)${l.split("\t").pop()}`);
const diff = git("diff", "--no-color", "-U5", baseSha, headSha, "--", ".", ...EXCLUIR, ...exclBin);
const stat = git("diff", "--shortstat", baseSha, headSha).trim();
const descricao = bodyFile
  ? readFileSync(bodyFile, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("<!-- claude-projects-attribution") && !/^_(Requested|Generated) by /.test(l))
      .join("\n")
      .trim()
  : "(sem descrição)";

const sha7 = headSha.slice(0, 7);
const partes = [
  `# Auditoria GPT — Tchê Food PR #${pr}${rodada > 1 ? ` (re-auditoria ${rodada})` : ""}`,
  "",
  INSTRUCOES,
  "",
  "---",
  "",
  `## Pull request`,
  `- PR #${pr}: ${titulo}`,
  `- Link: ${REPO_URL}/pull/${pr}`,
  `- Diff no GitHub: ${REPO_URL}/compare/${baseSha}...${headSha}`,
  `- SHA auditado (cabeça do PR): ${headSha}`,
  `- Base: ${baseSha}`,
  `- Tamanho: ${stat}`,
];
if (rodada > 1) {
  partes.push(
    "",
    `## Rodada anterior`,
    anterior || "(descreva o veredito anterior e o que foi corrigido)",
    "Confira se os achados anteriores foram resolvidos e se a correção não abriu outro problema.",
  );
}
partes.push(
  "",
  "## Descrição do PR (escrita por quem fez a mudança; confira, não confie)",
  descricao,
  "",
  "## Arquivos alterados",
  ...arquivos.map((l) => `- ${l.replace("\t", " ").replace(/\t/g, " -> ")}`),
);
if (binarios.length) partes.push("", `(${binarios.length} arquivo(s) binário(s) só listado(s), fora do diff abaixo; package-lock.json também fica fora)`);
partes.push("", "## Diff", "```diff", diff.trimEnd(), "```", "");
const texto = partes.join("\n");

let destino = null;
if (out) {
  let ehPasta = out.endsWith("/");
  try {
    ehPasta = ehPasta || statSync(out).isDirectory();
  } catch {}
  if (ehPasta) {
    mkdirSync(out, { recursive: true });
    destino = join(out, `PR-${pr}-${sha7}${rodada > 1 ? `-r${rodada}` : ""}.md`);
  } else destino = out;
  writeFileSync(destino, texto);
} else {
  process.stdout.write(texto);
}
const aviso = texto.length > LIMITE_COLAR ? " (grande: anexe o arquivo no GPT em vez de colar)" : "";
console.error(`PR #${pr} @ ${sha7}: ${texto.length} caracteres${aviso}${destino ? ` -> ${destino}` : ""}`);
