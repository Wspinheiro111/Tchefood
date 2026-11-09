---
agentTools:
  projectIndex: https://online.stone.com.br/llms.txt
---

# Pré Autorização

O funcionamento da pré-autorização é semelhante ao da captura posterior, mas oferece um prazo maior para capturar a transação.

É muito muito comum para hotéis durante a reserva da estádia. A seguir detalhamos um pouco mais o fluxo da reserva de um quarto de hotel:

* O cliente acessa o site, escolhe o hotel, o quarto e o número de diárias, realizando a reserva.
* Ao receber essa solicitação, o site do hotel pede à Stone que autorize o valor da reserva, mas a captura não é realizada até que o cliente faça o check-in no hotel.

Para diferenciar as duas mensagens, a mensagem de Pré-Autorização o campo `operation_type` deve ser enviado com o valor **pre\_auth**. Para mais informações da mensageria, veja a sessão [pré autorização](https://dash.readme.com/project/stone-online/v4.1/refs/pr%C3%A9-autoriza%C3%A7%C3%A3o)

> ⚠️ Atenção
>
> O valor da confirmação da transação pode ser até 100% do valor da pré-autorização.
>
> Para valores acima de 100%, deve ser realizada uma nova pré-autorização ou uma autorização com captura automática com o valor desejado.
>
> O prazo para a captura da transação é de 30 DIAS. Se o propósito não for mais capturar é preciso enviar uma mensagem de cancelamento dentro desse prazo.

Para mais informações sobre como enviar pedidos com pré autorização, consulte a documentação da nossa API - [Pré Autorização](doc:pré-autorização-incompleta)