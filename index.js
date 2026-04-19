app.post('/webhook', async (req, res) => {
    const data = req.body;

    console.log("BODY COMPLETO:", JSON.stringify(data, null, 2));

    const mensagem = (
        data?.text?.message ||
        data?.message ||
        data?.body
    )?.toLowerCase();

    const numero = data?.phone;

    if (!mensagem || !numero) return res.sendStatus(200);

    console.log("Mensagem:", mensagem);

    // INÍCIO
    if (mensagem === "oi") {
        await enviarMensagem(numero, "🍦 Bem-vindo!\nDigite *pedir* para fazer seu pedido");
    }

    // PEDIDO
    if (mensagem === "pedir") {
        await enviarMensagem(numero, "💰 Gerando pagamento PIX...");

        try {
            const clienteId = await criarCliente("Cliente Dindin", numero);
            const pagamento = await gerarPix(10, clienteId);

            const pixCode = pagamento?.pix?.payload;

            if (!pixCode) {
                throw new Error("PIX não gerado");
            }

            await enviarMensagem(
                numero,
                `💳 PIX gerado:\n${pixCode}\n\nApós pagar, aguarde confirmação automática`
            );

        } catch (erro) {
            console.error("ERRO ASAAS:", erro.response?.data || erro.message);

            await enviarMensagem(numero, "❌ Erro ao gerar pagamento. Tente novamente.");
        }
    }

    res.sendStatus(200);
});
