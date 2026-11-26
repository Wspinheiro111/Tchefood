# APK assinado (release) do Tchê Food

O `scripts/build-apk.sh` gera dois tipos de APK:

- **debug** (sem chave): `tchefood-<variante>-debug.apk`. A chave de debug é criada em cada máquina, então um
  APK gerado em outra máquina não instala por cima: o Android pede para desinstalar, e desinstalar apaga os dados
  do aparelho. Serve só para teste rápido.
- **release** (com a chave oficial do Tchê Food): `tchefood-<variante>.apk`. Todo APK assinado com a chave
  oficial instala por cima do anterior, em qualquer máquina que gere. É o que vai para as lojas.

## Gerar o release

```bash
TCHEFOOD_KEYSTORE=/caminho/tchefood-release.jks bash scripts/build-apk.sh
```

O script pergunta `Senha da chave do Tchê Food (não aparece na tela):`. Espere a pergunta aparecer e só então
digite (ou cole) a senha e aperte Enter. Nada do que você digita aparece na tela nem fica no histórico do terminal.

Sem terminal (automação), a senha vem de um arquivo:

```bash
TCHEFOOD_KEYSTORE=/caminho/tchefood-release.jks \
TCHEFOOD_KEYSTORE_PASSWORD_FILE=/caminho/senha.txt \
bash scripts/build-apk.sh
```

O arquivo tem só a senha, na primeira linha. Crie com um editor de texto (nunca com um comando que leve a senha
escrita), fora do repositório, e de preferência longe do `.jks`. Deixe o arquivo legível só para você
(`chmod 600 /caminho/senha.txt`): o script não confere as permissões.

**A senha nunca vai num comando nem numa variável de ambiente.** Se `TCHEFOOD_KEYSTORE_PASSWORD` ou
`TCHEFOOD_KEY_PASSWORD` existirem no ambiente, o script para antes de fazer qualquer coisa: variável de ambiente
é herdada por todo programa que o build chama (npm, Gradle e as dependências deles) e, digitada no comando, fica
no histórico do terminal. O release também não roda com `bash -x`, que mostraria a senha no rastro.

Se a senha já foi digitada num comando alguma vez, apague a linha do histórico do terminal e troque a senha da
chave: `keytool -storepasswd -keystore /caminho/tchefood-release.jks` pergunta a senha atual e a nova, sem
mostrar. O certificado não muda com a troca de senha, então os APKs continuam instalando por cima.

Opcionais: `TCHEFOOD_KEY_ALIAS` (padrão `tchefood`), `TCHEFOOD_VERSION_CODE` e `TCHEFOOD_PRIMEIRO_RELEASE`
(os dois explicados em "Registro de releases"). A chave é um arquivo PKCS12 com uma senha só (o padrão do
`keytool`).

## O que o script confere, e em que ordem

1. **Antes de compilar**: abre a chave com a senha e compara o certificado dela com o da chave oficial. Senha
   errada ou chave que não é a oficial param o build em segundos, e nada é compilado.
2. **Compila sem assinar**: o Gradle gera `app-<variante>-release-unsigned.apk`. A assinatura não passa pelo
   Gradle: nem o Gradle, nem o npm, nem o download do SDK recebem a senha, o caminho da chave ou o caminho do
   arquivo da senha.
3. **Assina**: o `apksigner` (do SDK Android) assina cada APK. Só dois programas recebem a senha, e só pela
   entrada padrão: o `keytool` (passo 1) e o `apksigner` (este passo). A assinatura é a v2, a mesma dos releases
   já publicados.
4. **Confere cada APK pronto, antes de publicar**: assinatura válida, exatamente um signatário, certificado igual
   ao oficial, esquema v2 presente e nenhum v3 ou v3.1 (que poderiam trazer uma troca de chave embutida),
   alinhamento, pacote da variante (`food.tche.smartpos` no pagbank, `food.tche.smartpos.tablet` no tablet),
   `versionCode` e `versionName` legíveis e iguais nas duas variantes, e APK não depurável. O script assina sem
   o esquema v1 (o app exige Android 7.1 ou mais novo, que usa o v2); a conferência não tem como provar a
   ausência do v1, porque o `apksigner` não o avalia para essa versão mínima do Android.
5. **Registro de releases**: o número da versão tem de subir (seção abaixo).
6. **Publica**: só então `apk/` troca, de uma vez, para os APKs novos.

Se qualquer conferência falhar, `apk/` fica exatamente como estava. Depois que `apk/` trocou, nada mais muda o
resultado: o que vem depois é só arrumação e texto na tela.

No fim o script mostra a versão, o certificado e o SHA-256 de cada APK.

## A chave oficial

O certificado da chave oficial tem o SHA-256

```
a247689aa296179b31e45b67679c8194609c4d93f41e554bc6644b28896ab64f
```

Esse número está fixo no script (`CERT_OFICIAL_SHA256`) e o certificado inteiro, que é público, está em
`android/tchefood-release-cert.pem`. Não existe variável que troque esse valor: release com outra chave não é
assinado nem publicado, tenha o nome que tiver no certificado.

Para conferir qualquer APK (os dois publicados em 26/11/2026, versão 0.1.364, mostram esse mesmo número):

```bash
~/.cache/tchefood-android/sdk/build-tools/34.0.0/apksigner verify --print-certs apk/tchefood-tablet.apk
# Signer #1 certificate SHA-256 digest: a247689a...6ab64f
```

O `apksigner` e o `aapt2` não ficam no `PATH`: o script os baixa para
`~/.cache/tchefood-android/sdk/build-tools/34.0.0/` (ou para a pasta de `ANDROID_HOME`, se você usa a sua).

Para conferir o arquivo do certificado contra o número do script:

```bash
openssl x509 -in android/tchefood-release-cert.pem -outform DER | sha256sum
```

No macOS, onde não existe `sha256sum`, use `shasum -a 256` no lugar (vale para todos os comandos desta página).

A constante nunca é editada para fazer um build passar. Trocar de chave exige um PR que troque a constante e o
certificado, e obriga a desinstalar o app de todos os aparelhos (desinstalar apaga os dados locais).

## Registro de releases (o número da versão só sobe)

O Android recusa instalar por cima um APK com `versionCode` menor que o instalado. Para isso nunca acontecer, o
script mantém um registro ao lado da chave: `<arquivo da chave>.releases.tsv`. É um arquivo de texto com uma
linha por APK publicado, com os campos separados por tabulação:

```
variante    versionCode    versionName    SHA-256 do APK    data (UTC)
```

Por exemplo (uma tabulação entre os campos, a data sempre no formato `AAAA-MM-DDTHH:MM:SSZ`):

```
pagbank	364	0.1.364-ef717e6	c5f9891d7491d18239182cfce1330ec5a68a5877db8012fc82cc26a44af47795	2026-11-26T01:20:00Z
tablet	364	0.1.364-ef717e6	fdde390fe9bece3a0ee69dbf0f0143bb6cf42512a31f987130e9813ca7c6b25d	2026-11-26T01:20:00Z
```

A cada release, para cada APK:

- número **menor** que o maior já registrado (de qualquer variante): recusa;
- número **igual** a um já registrado para a variante: só passa se o APK for idêntico ao registrado, byte a byte
  (o build é reprodutível: o mesmo commit, na mesma máquina, dá o mesmo arquivo). Conteúdo diferente com o mesmo
  número: recusa. Essa é uma regra do Tchê Food, para cada número identificar um único APK (o Android em si
  aceitaria instalar um por cima do outro);
- o mesmo número com outro `versionName` (outro commit): recusa;
- número **novo**: tem de ser maior que 364 (o último publicado antes de o registro existir), e a linha é gravada
  antes da publicação.

Quando o script recusar por causa do número, ele diz qual usar. Para escolher o número à mão:

```bash
TCHEFOOD_VERSION_CODE=401 TCHEFOOD_KEYSTORE=/caminho/tchefood-release.jks bash scripts/build-apk.sh
```

O que você precisa saber:

- **O registro é guardado junto da chave.** Toda cópia de segurança da chave leva o registro junto, refeita depois
  de cada release. Gere releases sempre a partir da mesma cópia da chave, numa máquina de cada vez: duas cópias
  da chave em lugares diferentes têm dois registros, e um não sabe do outro.
- **Dois releases com a mesma chave não publicam ao mesmo tempo.** Ao lado da chave fica também
  `<arquivo da chave>.releases.lock`, um arquivo vazio que o script cria e nunca apaga: é a trava dos releases
  dessa chave. Quem a tem confere o número, grava a linha e troca `apk/`; outro release com a mesma chave, mesmo em
  outra cópia do projeto, espera até 30 segundos e, se o primeiro não terminar, para sem gravar nem publicar (rode
  de novo). A compilação não segura a trava. Esse arquivo não precisa de cópia de segurança: se sumir, o script
  cria outro.
- **A pasta da chave precisa aceitar escrita e trava de arquivo.** O script testa a trava antes de compilar: se a
  pasta (uma pasta de rede, por exemplo) não travar de verdade, o release para e pede para usar a chave numa
  pasta do próprio computador. O teste vale para processos da mesma máquina; ele não prova que a trava funciona
  entre duas máquinas que abrem a mesma pasta de rede, por isso a regra de gerar numa máquina de cada vez continua.
- **Se a publicação falhar depois de a linha ser gravada** (ou o processo for morto nesse instante), a linha
  fica: o número está amarrado àquele APK. Rodar de novo no mesmo commit publica normalmente; para publicar outro
  conteúdo, use um número maior.
- **Se o registro se perder**, o script para e avisa. Recupere o arquivo da cópia de segurança. Se não houver
  cópia, refaça o registro à mão com uma linha para cada APK do último release publicado (`versionCode` e
  `versionName` saem de `aapt2 dump badging <apk>`, o SHA-256 de `sha256sum <apk>`, a data pode ser a de hoje),
  no formato do exemplo acima, com uma tabulação entre os campos e sem linha em branco. Um registro refeito
  errado (com um número menor que o do APK que está nos aparelhos) deixa passar um release que o Android vai
  recusar: confira o número no aparelho, em Configurações > Apps > Tchê Food.
- `TCHEFOOD_PRIMEIRO_RELEASE=1` existe para o primeiro release de um registro novo, e é recusado quando o
  registro já tem releases. Mesmo com ele, o número tem de ser maior que 364.
- O arquivo não é para editar. Linha fora do formato, fim de linha do Windows, linha em branco ou números fora de
  ordem fazem o script parar antes de compilar.
- O registro protege contra engano de quem gera o release (branch errado, número repetido). Não protege contra
  quem tem a chave e edita o arquivo de propósito.

## Guardar a chave

- O arquivo `.jks`, a senha e o arquivo da senha **nunca** vão para o repositório (`*.jks`, `*.keystore`,
  `*.releases.tsv` e `*.releases.lock` estão no `.gitignore`), nem para o chat.
- Guarde duas cópias fora do computador (por exemplo, um pendrive e uma pasta privada na nuvem), com a senha
  separada do arquivo, e o registro de releases junto da chave.
- **Perder a chave impede atualizar os aparelhos**: um APK com chave nova só instala depois de desinstalar o antigo,
  o que apaga os dados locais de cada aparelho.

## Versão

`versionCode` é a quantidade de commits até o `HEAD` (`git rev-list --count HEAD`) e `versionName` é
`0.1.<versionCode>-<commit>`. Gere sempre a partir da `main` atualizada. Clone raso (`git clone --depth`) faz o
build parar com uma mensagem; rode `git fetch --unshallow`.

A contagem de commits sozinha não garante que o número suba (outro branch pode ter menos commits): quem garante é
o registro de releases.

A versão aparece em Configurações > Apps > Tchê Food no aparelho.

## Pelo Gradle direto e pelo GitHub Actions

`gradle -p android assemble*Release` gera só o APK sem assinatura (`app-<variante>-release-unsigned.apk`), que o
Android não instala. Quem assina, confere e publica é o `scripts/build-apk.sh`.

O workflow manual `APK Android` gera só os APKs de debug e não usa a chave nem segredo nenhum.

## Downloads conferidos

O script confere o SHA-256 das ferramentas do Android (commandline-tools) e do Gradle antes de descompactar. Se
o arquivo baixado não confere, ele é apagado e o build para. Os valores ficam no topo do script, junto da versão.
De onde vem cada um:

| Arquivo | SHA-256 fixado no script | Procedência |
| --- | --- | --- |
| `gradle-8.7-bin.zip` | `544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d` | Publicado pelo Gradle em https://gradle.org/release-checksums/#8.7, linha "Binary-only (-bin) ZIP". O arquivo baixado de services.gradle.org dá o mesmo valor (conferido em 26/11/2026). |
| `commandlinetools-linux-11076708_latest.zip` | `2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258` | Calculado por nós em 26/11/2026 sobre o arquivo de https://dl.google.com/android/repository/. Desta versão o Google publica só o tamanho e o SHA-1, em https://dl.google.com/android/repository/repository2-3.xml (pacote `cmdline-tools;12.0`): 153607504 bytes, SHA-1 `d313adb7aedccf6cf0cfca51ec180f0059f5f8f8`. O arquivo confere com os dois. |
| `commandlinetools-mac-11076708_latest.zip` | `7bc5c72ba0275c80a8f19684fb92793b83a6b5c94d4d179fc5988930282d7e64` | Como o de cima: 153607488 bytes, SHA-1 `37fb7dd41005b3b4ca6ea48ac27074b6fc4e3236` no mesmo índice do Google. O arquivo confere com os dois. |

O índice e os arquivos do Google foram baixados pela mesma rede. Quem quiser uma confirmação independente pode
repetir, de outra rede, `curl -L <endereço> | sha256sum` para cada arquivo e comparar com a tabela.

Trocar a versão de uma ferramenta exige trocar o SHA-256 no script e a linha desta tabela, com a procedência.
