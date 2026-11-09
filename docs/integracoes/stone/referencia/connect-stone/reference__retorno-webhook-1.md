---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Retorno Webhook

Exemplos de postback dos Webhooks do Connect Stone

```json charge.paid
{
	"id": "hook_j0R8BYh0dS123RQ34",
	"account": {
		"id": "acc_Wd46j1nsecRFDE12G",
		"name": "PARTNER TESTE"
	},
	"type": "charge.paid",
	"created_at": "2023-10-10T20:28:13.6201993Z",
	"data": {
		"id": "ch_NRPl6mouLuZ123FR4",
		"code": "38332544765625",
		"amount": 12500,
		"paid_amount": 12500,
		"status": "paid",
		"currency": "BRL",
		"payment_method": "cash",
		"paid_at": "2023-10-10T20:28:13.5135427Z",
		"created_at": "2023-10-10T20:28:13.4661957Z",
		"updated_at": "2023-10-10T20:28:13.5135427Z",
		"pending_cancellation": false,
		"customer": {
			"id": "cus_PMmJ5WPTKTL12345H",
			"name": "TONI STARK ",
			"delinquent": false,
			"created_at": "2023-10-10T20:26:59.95Z",
			"updated_at": "2023-10-10T20:26:59.95Z",
			"phones": {},
			"metadata": {}
		},
		"order": {
			"id": "or_bqopZVqtEtr123F45",
			"code": "D3MGIQI835",
			"amount": 12500,
			"closed": false,
			"created_at": "2023-10-10T20:26:59.963Z",
			"updated_at": "2023-10-10T20:26:59.98Z",
			"currency": "BRL",
			"status": "pending",
			"customer_id": "cus_PMmJ5WPTKTL12345H",
			"metadata": {}
		},
		"last_transaction": {
			"transaction_type": "cash",
			"id": "tran_P82DORmFyFg1234hj",
			"amount": 12500,
			"status": "paid",
			"success": true,
			"created_at": "2023-10-10T20:28:13.4823909Z",
			"updated_at": "2023-10-10T20:28:13.4823909Z",
			"gateway_response": {},
			"antifraud_response": {}
		},
		"metadata": {
			"scheme_name": "MasterCard",
			"account_holder_name": "TONI STARK        ",
			"account_funding_source": "debit",
			"authorization_code": "M21111",
			"initiator_transaction_key": "6N027946-4.0.0-S1BY3V-9977",
			"installment_quantity": "1",
			"installment_type": "None",
			"transaction_timestamp": "2023-10-10T20:28:11.515Z",
			"terminal_serial_number": "6N021234"
		}
	}
}
```