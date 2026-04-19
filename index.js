app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;

        console.log("BODY COMPLETO:", JSON.stringify(data, null, 2));

        // 🧠 FILTRO IMPORTANTE (evita loop e eventos inválidos)
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = (
            data?.text?.message ||
            data?.message ||
            data?.body
        )?.toLowerCase()?.trim();

        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        console.log("Mensagem:", mensagem);

        // 🟢 INÍCIO
        if (mensagem === "oi") {
            await enviarMensagem(
                numero,
                "🍦 Bem-vindo à TH Dindin Gourmet!\nDigite *pedir* para fazer seu pedido"
            );
        }

        // 💰 PEDIDO
        else if (mensagem === "pedir") {

            await enviarMensagem(numero, "💰 Gerando pagamento PIX...");

            try {
                const clienteId = await criarCliente("Cliente Dindin", numero);

                // 🔥 valor preparado pra futuro
                const valorPedido = 10;

                const pagamento = await gerarPix(valorPedido, clienteId);

                const pixCode = pagamento?.pix?.payload;

                if (!pixCode) {
                    throw new Error("PIX não retornou payload");
                }

                await enviarMensagem(
                    numero,
                    `💳 *PIX gerado*

💰 Valor: R$${valorPedido}

📌 Copia e cola:
${pixCode}

Após pagar, aguarde confirmação automática.`
                );

            } catch (erro) {
                console.error("ERRO ASAAS:", erro.response?.data || erro.message);

                await enviarMensagem(
                    numero,
                    "❌ Erro ao gerar pagamento. Tente novamente em instantes."
                );
            }
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("ERRO WEBHOOK:", error);
        res.sendStatus(200);
    }
});
