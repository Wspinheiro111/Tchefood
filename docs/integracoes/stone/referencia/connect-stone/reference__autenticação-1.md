---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Autenticação

> Antes de começar, você precisa obter suas chaves de API.\
> Para isso, siga os seguintes passos:\
> **1** - Acesse este [**link**](https://id.pagar.me) e faça login com seu usuário,\
> **2** - Após acessar o Dash, acesse a Account ID que foi ativa para a sua integração e navegue até a área de **Configurações** e em seguida clique em **Chaves**, nesse [**link**](https://stone-partnerprogram.helpjuice.com/pt_BR/connect-stone1/criar-sk-para-integra%C3%A7%C3%A3o) detalhamos esse processo.

> 🚧 Ambiente de Sandbox
>
> O ambiente de testes é aplicável somente no ambiente de criação de pedidos na API do Pagar.me.
>
> Dado que não possuímos ambiente de testes na Stone, os pedidos criados no Pagar.me em ambiente de Sandbox não serão refletidos no POS.
>
> Com isso, **não possuímos um ambiente de Sandbox para realizar testes de ponta a ponta no Connect Pagar.me.** e os pedidos devem ser criados diretamente no ambiente de produção.

[block:html]
{
  "html": "</br>"
}
[/block]

## Autorização Basic Auth

Para se autenticar conosco você deve enviar a **Chave de API** no cabeçalho **Authorization**, seguindo o padrão da [HTTP Basic Authentication](https://en.wikipedia.org/wiki/Basic_access_authentication).

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

> ❗️ NÃO COMPARTILHE SUAS CHAVES DE API
>
> A sua chave da API é **SECRETA** e não deve ser compartilhada com terceiros.
>
> **Nese [link](https://pagarme.helpjuice.com/p2-manual-da-dashboard/4-configura%C3%A7%C3%B5es-como-consultar-a-chave-secreta-e-a-chave-p%C3%BAblica) detalhamos mais sobre as chaves e como consultar e criar novas chaves.**