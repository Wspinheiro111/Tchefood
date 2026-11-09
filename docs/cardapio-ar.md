# Cardápio em realidade aumentada (3D na mesa)

O cliente lê o QR da mesa, toca no prato que tem o selo **3D** e:

1. vê o prato em 3D, girando com o dedo;
2. toca em **Ver na minha mesa** e o prato aparece sobre a mesa, pela câmera, **no tamanho real**;
3. toca em **Ver os itens** e as camadas se separam com uma etiqueta em cada item (massa, molho, queijo…);
4. toca em **Quero este** e segue para o pedido normal (adicionais, ponto da carne, observações).

Não precisa instalar app. Funciona no navegador:

| Aparelho | Como abre a câmera | Observação |
| --- | --- | --- |
| Android com Google Play Services for AR (quase todos os modelos de 2019 em diante) | WebXR no Chrome; se não der, Scene Viewer | No WebXR as etiquetas aparecem junto do prato na mesa |
| iPhone/iPad (iOS 12+) | Quick Look | Usa o `.usdz` enviado; sem ele, o iPhone gera um a partir do `.glb` (sem a animação dos itens) |
| Computador ou celular sem AR | Só 3D na tela | O botão da câmera não aparece |

## O que é preciso para cada prato: um modelo 3D de verdade

Foto não vira 3D sozinha. Cada prato do cardápio precisa de um arquivo **.glb** (o formato padrão da web). Caminhos, do mais barato ao mais caprichado:

1. **Fotogrametria pelo celular (recomendado para começar).** Apps como **Polycam**, **Luma AI**, **KIRI Engine** ou **RealityScan** montam o 3D a partir de um vídeo ou de 50 a 150 fotos dando a volta no prato. Dicas:
   - prato montado como sai para o salão, em cima de uma mesa fosca e bem iluminada, sem sol direto nem reflexo;
   - dê duas voltas completas: uma na altura do prato e outra de cima, a uns 45°;
   - exporte em **GLB**, com textura de até 2048 px (o arquivo fica entre 2 e 8 MB e abre rápido no 4G);
   - iPhone com LiDAR (Pro) dá medida certa automaticamente; nos outros, informe a medida real na Retaguarda.
2. **Artista 3D (Fiverr, Workana, 99Freelas).** Melhor para pratos brilhantes, transparentes (drinks, chopp) ou quando se quer a vista **Ver os itens** animada: peça o `.glb` em metros com uma animação chamada `explodir` que levanta cada ingrediente.
3. **Pacote pronto** (bancos de modelos 3D de comida): rápido, mas não é o prato da casa. Use só para bebidas em lata/garrafa.

> Os itens só se separam (vista explodida) quando o arquivo tem uma animação para isso. Sem animação, o botão **Ver os itens** mostra só as etiquetas sobre o prato montado.

## Cadastro na Retaguarda

**Retaguarda > Cardápio > 3D / Realidade aumentada** (precisa da permissão de editar o cardápio):

1. **+ 3D** no prato e escolha o `.glb` (ou cole um link https para ele). Opcional: o `.usdz` para iPhone.
2. **Maior medida real do prato (cm)**: ex. 35 para uma pizza de 35 cm. O sistema mede o arquivo e ajusta a escala, então tanto faz se o app exportou em metros ou centímetros.
3. Se o arquivo tiver animação, escolha qual separa os itens.
4. **Adicionar item** → escreva o nome (ex.: "Mussarela") e toque no ponto do modelo onde a etiqueta fica. Até 12 itens.
5. **Salvar 3D**. Com a loja ligada à nuvem, o arquivo sobe para o bucket `product-models` e já abre no celular dos clientes. Sem nuvem, fica marcado **só neste aparelho** até você tocar em **Enviar**.

A demonstração já vem com uma **Pizza Calabresa de 35 cm** (código 401) gerada por `scripts/gerar-pizza-ar.mjs`, com formas simples e a animação dos itens. Serve para mostrar o fluxo; não é a foto do prato.

## Métricas de engajamento

Na mesma tela, por prato e nos últimos 30 dias: **aberturas do 3D**, **colocaram na mesa (AR)**, **viram os itens** e **pediram depois de ver** (com a % de conversão). Cada ação vira uma linha em `ar_engagement_events`. O celular do cliente (sem login) registra pela função `tchefood_ar_track(token_do_qr, produto, ação)`, que só aceita mesa ativa e produto com 3D ativo da mesma loja.

## Banco (db/schema_ar.sql)

- `product_ar_models`: um modelo por produto; `glb_url`/`usdz_url` só aceitam `https://` (ou `ar/…` da demonstração); medidas entre 1 e 150 cm; até 12 etiquetas.
- `ar_engagement_events`: só INSERT (o banco recusa editar ou apagar).
- Bucket `product-models` (leitura pública, até 15 MB, gravação só na pasta `<tenant_id>/` da própria loja).

## Limites conhecidos

- Scene Viewer (Android sem WebXR) lê o arquivo direto do link e não aplica o ajuste de escala da Retaguarda: para esses aparelhos o `.glb` precisa já estar em metros (os apps de fotogrametria exportam assim).
- O iPhone não toca a animação dos itens dentro da câmera; no 3D da tela funciona.
