---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# POI payment settings

Contem as informações detalhadas dos campos do objeto POI PAYMENT SETTINGS.

```json
"poi_payment_settings": {
        "visible": true,
        "display_name": "Mesa 3",
        "print_order_receipt": true,
        "devices_serial_number": ["6C582505"],
        "payment_setup": {
            "type": "credit",
            "installments": 1,
            "installment_type": "issuer"
        }        
```

[block:parameters]
{
  "data": {
    "h-0": "Nome",
    "h-1": "Descrição",
    "0-0": "poi_payment_setting `objeto`",
    "0-1": "Informações da transação `obrigatório`",
    "1-0": "display_name `string`",
    "1-1": "Nome que constará da transação no POS",
    "2-0": "print_order_receipt `boolean`",
    "2-1": "Define se o POS fará impressão de uma Nota Fiscal para o pedido `obrigatório`",
    "3-0": "devices_serial_number `int`",
    "3-1": "Define o serial number (máquininha) que receberá a requisição do pedido. `obrigatório`",
    "4-0": "paymnte_setup",
    "4-1": "Define todas as informações da transação. (apenas para pedido direto)",
    "5-0": "type `string`",
    "5-1": "Tipo de transação (\"Crédito\", \"débito\", \"voucher\", \"pix (Disponível versão 6.4 do app de pagamentos)\") `obrigatório`",
    "6-0": "installments `int`",
    "6-1": "Quantidade de parcelas. `Obrigatório para modalidade crédito`",
    "7-0": "installment_type `string`",
    "7-1": "Tipo de parcelamento: estabelecimento (merchant) ou emissor (issuer).  \nPara mais informações [acesso aqui](https://ajuda.stone.com.br/maquininha-e-tef/parcelado-com-juros-emissor?from_search=109092964)"
  },
  "cols": 2,
  "rows": 8,
  "align": [
    "left",
    "left"
  ]
}
[/block]