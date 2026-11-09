---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Autenticação

Para interagir com a nossa API e realizar transações via POS, é necessário entender a hierarquia de credenciais e como utilizá-las nos cabeçalhos de suas requisições.

## 1. O que são as Credenciais?

A estrutura de credenciais do Connect Stone é composta por dois ecossistemas que trabalham juntos: Pagar.me (gestão de contas e chaves) e Stone (processamento e terminais).

### Estrutura Hierárquica

* **Merchant (Parceiro):** É a entidade principal (você). Possui visão global de todos os clientes.
* **Account (Clientes):** Cada estabelecimento comercial abaixo do parceiro possui uma conta única.
* **Secret Key (SK):** Uma chave transacional exclusiva vinculada a cada Account. É ela que autoriza as operações.
* **Stonecode:** É a identificação do estabelecimento dentro da Stone. Ele está vinculado à Account e é o que conecta o software aos terminais físicos (POS).

![](https://files.readme.io/022013b-estrutura.JPG)

## 2. Como obter suas Chaves

As chaves de API são geradas após a conclusão do processo de Setup no Partner Hub! Você pode acessa-las tanto pelo próprio Partner Hub, quanto pela Dashboard Pagar.me.

Passo a Passo Partner Hub:

1. Acesse o[ Partner Hub](https://partnerhub.stone.com.br/) e faça login.
2. No menu lateral, navegue até Integração > Setup.
3. Selecione o Connect Stone e vá em Setup > Ativação Connect.

Passo a Passo Pagar.me:

1. Acesse este [**link**](https://id.pagar.me) e faça login com seu usuário.
2. Após acessar o Dash, navegue até a área de **Desenvolvimento** e em seguida clique em **Chaves**.

## 3. Autenticação nas Requisições

Utilizamos o padrão [Basic Auth](https://en.wikipedia.org/wiki/Basic_access_authentication) para garantir a segurança das chamadas de API. A sua Secret Key deve ser enviada no cabeçalho Authorization, com o padrão já aplicado.

```curl
curl --location --request POST  https://api.pagar.me/core/v5/orders' \
     -H 'Authorization: Basic c2tfdGVzdF9*Og==' \
     -H 'Content-Type: application/json' \
```
```javascript Node.js
var fs = require('fs');
const request = require("request");
var body = JSON.parse(fs.readFileSync('body.json', 'utf8'));

var options = {                 
    method: 'POST',             
    uri: 'https://api.pagar.me/core/v5/orders',                    
    headers: {               
      'Authorization': 'Basic ' + Buffer.from("sk_test_*:").toString('base64'),
      'Content-Type': 'application/json'              
    },
    json : body
};    

request(options, function(error, response, body) {  
    console.log(response.body);
});
```

> 📘 Como utilizar a SecretKey
>
> Para montar a requisição Basic Auth, você deve utilizar a SecretKey da seguinte maneira:\
> **User:** SecretKey\
> **Password:** *vazio*

> ❗️ SEGURANÇA DOS DADOS: Suas chaves secretas permitem a movimentação de transações reais. Nunca as inclua em repositórios públicos de código (como GitHub público) ou em códigos de front-end que fiquem visíveis ao usuário final, ou compartilhe com terceiros.