---
agentTools:
  projectIndex: https://connect-stone.stone.com.br/llms.txt
---

# Ambiente

Para esta integração, **não disponibilizamos um ambiente de sandbox ou simulador virtual**. Todas as etapas de desenvolvimento e validação devem ser realizadas **diretamente no Ambiente de Produção**.

### Orientações para Testes em Produção

Para validar sua integração de forma segura e eficiente, recomendamos seguir as boas práticas abaixo:

1. **Transações de Baixo Valor:** Utilize valores simbólicos (ex: R$ 1,00) para realizar os fluxos de teste. Isso minimiza o impacto financeiro e facilita a conferência nos logs.
2. **Cancelamento Imediato (Estorno):** Após a confirmação de uma transação bem-sucedida, realize o cancelamento (estorno) da operação diretamente pelo terminal. Isso garante que o valor seja devolvido ao cartão utilizado e não gere custos de taxas transacionais.
3. **Cartões Reais:** Utilize cartões de crédito/débito reais para os testes. Recomendamos o uso de cartões com tecnologia de aproximação (NFC) e chip para validar todos os métodos de entrada suportados pelo terminal.

> ❗️ Atenção: Como os testes ocorrem em produção, as transações aprovadas e não canceladas impactarão o domicílio bancário do estabelecimento e o limite do cartão utilizado. Certifique-se de que a equipe esteja ciente dos testes em andamento.