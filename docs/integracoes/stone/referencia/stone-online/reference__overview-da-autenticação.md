---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Overview da Autenticação

A autenticação para o Stone Online 4.0 está amplamente ligada com o modelo de negócio do integrador à nossa API.

# **Gateways**

Caso o seu modelo de negócio seja um Gateway será necessário que o lojista responsável pela afiliação Stone faça a geração de uma chave transacional. Isso é necessário para garantir a autorização explícita do lojista à sua integração.

**Como gerar as credenciais (SecretKey)?**

O processo de geração de credenciais está detalhado [aqui](https://online.stone.com.br/docs/gerando-a-secret-key-stone) . O cliente terá acesso as chaves do ambiente de produção:

Exemplo de prefixo da **SecretKey** de Produção: `sk_xxxxxx`

**Como utilizar a SecretKey?**

Para se autenticar conosco você deve enviar a SecretKey no **Header**`Authorization`, seguindo o padrão da [HTTP Basic Authentication](https://en.wikipedia.org/wiki/Basic_access_authentication), seguindo conforme abaixo:

**username:** SecretKey em Basic Auth\
**password:** vazio

**Basic Auth**

```node
var fs = require('fs');
const request = require("request");

var authorization = 'Basic '+ Buffer.from("sk_xxxxxx:").toString('base64');

console.log(authorization);
```

Caso você seja um emissor de transações ou seja, transacione como uma **subadquirente** e seu cliente não possua uma afiliação própria com a Stone, você deve entrar em contato com o nosso time de parcerias para desenvolvimento da sua integração.

# **Subadquirentes**

Para utilizar nossa API, como subadquirente, é necessário realizar a autenticação através de um token de acesso. Este token é gerado pelo nosso Identity Provider (IDP) e identifica unicamente cada cliente (StoneCode).

## **Como funciona:**

**Obtenção das credenciais:** Entre em contato com seu comercial para solicitar as credenciais de acesso.

**Geração do token:** Utilize as credenciais fornecidas para gerar um token de acesso através do nosso IDP de acordo com o [guia](https://online.stone.com.br/reference/cria%C3%A7%C3%A3o-de-token).

**Envio do token:** Inclua o token em cada requisição à API, no cabeçalho da requisição

O token possui um tempo de validade. Após expirar, será necessário gerar um novo token.

Mantenha suas credenciais de acesso em segurança e siga as melhores práticas de segurança para proteger o token de acesso.