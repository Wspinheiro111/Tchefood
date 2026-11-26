# APK assinado (release) do Tchê Food

O `scripts/build-apk.sh` gera dois tipos de APK:

- **debug** (sem chave): `tchefood-<variante>-debug.apk`. A chave de debug é criada em cada máquina, então um
  APK gerado em outra máquina não instala por cima: o Android pede para desinstalar, e desinstalar apaga os dados
  do aparelho. Serve só para teste rápido.
- **release** (com a chave do Tchê Food): `tchefood-<variante>.apk`. Todo APK assinado com a mesma chave instala
  por cima do anterior, em qualquer máquina que gere. É o que vai para as lojas.

## Gerar o release

```bash
TCHEFOOD_KEYSTORE=/caminho/tchefood-release.jks \
TCHEFOOD_KEYSTORE_PASSWORD='senha do arquivo' \
bash scripts/build-apk.sh
```

Opcionais: `TCHEFOOD_KEY_ALIAS` (padrão `tchefood`) e `TCHEFOOD_KEY_PASSWORD` (padrão: a senha do arquivo).
O script passa as senhas ao Gradle pelo ambiente (`ORG_GRADLE_PROJECT_*`), nunca pela linha de comando, e não as
imprime. No fim ele mostra a versão e o SHA-256 do certificado: o número tem de ser o mesmo em todo release; se
mudar, o APK foi assinado com outra chave e não vai instalar por cima.

O build para (e `apk/` fica como estava) se o APK sair sem assinatura válida, ou se um release sair com a chave de
debug. Pelo Gradle direto, `assemble*Release` sem as quatro propriedades `TCHEFOOD_KEYSTORE_FILE`,
`TCHEFOOD_KEYSTORE_PASSWORD`, `TCHEFOOD_KEY_ALIAS` e `TCHEFOOD_KEY_PASSWORD` falha antes de empacotar.

## Guardar a chave

- O arquivo `.jks` e a senha **nunca** vão para o repositório (`*.jks` e `*.keystore` estão no `.gitignore`), nem
  para o chat.
- Guarde duas cópias fora do computador (por exemplo, um pendrive e uma pasta privada na nuvem), com a senha
  separada do arquivo.
- **Perder a chave impede atualizar os aparelhos**: um APK com chave nova só instala depois de desinstalar o antigo,
  o que apaga os dados locais de cada aparelho.

## Versão

`versionCode` é a quantidade de commits até o `HEAD` (`git rev-list --count HEAD`) e `versionName` é
`0.1.<versionCode>-<commit>`. O Android recusa instalar um APK com `versionCode` menor que o instalado, então gere
sempre a partir da `main` atualizada. Clone raso (`git clone --depth`) faz o build parar com uma mensagem; rode
`git fetch --unshallow` ou passe `-PTCHEFOOD_VERSION_CODE=N`.

A versão aparece em Configurações > Apps > Tchê Food no aparelho.

## Downloads conferidos

O script confere o SHA-256 das ferramentas do Android (commandline-tools) e do Gradle antes de descompactar. Os
valores ficam no topo do script, junto da versão; trocar a versão exige trocar o SHA-256 pelo publicado em
developer.android.com/studio ou gradle.org/release-checksums.
