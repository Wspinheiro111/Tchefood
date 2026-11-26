# CI no CircleCI

O GitHub Actions da conta está travado por cobrança, então o CI do Tchê Food roda no CircleCI
(`.circleci/config.yml`).

## O que roda

- **verificar**: `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
- **apk-debug**: `bash scripts/build-apk.sh` gera os APKs de **debug** (pagbank e tablet). Baixe em
  *Artifacts* do job (pasta `apk/`). Não usa chave nem segredo.

## Ligar o projeto (uma vez, Will)

CircleCI > Projects > Tchefood > **Set Up Project** > usar o `.circleci/config.yml` já existente no branch.

## O que fica fora

O APK de **release assinado** não sai do CircleCI: a chave oficial nunca vai para um serviço de CI.
O release continua sendo gerado à mão, como descrito em `scripts/build-apk.sh`.
Os testes do Postgres (`db/tests/*.pg.test.ts`) ficam ignorados aqui, como no ambiente local sem banco.
