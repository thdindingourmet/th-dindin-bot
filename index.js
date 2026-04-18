const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 🔐 CONFIG
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

// 📩 Enviar mensagem WhatsApp
async function enviarMensagem(numero, mensagem) {
    await axios.post(`https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
        phone: numero,
        message: mensagem
    });
}

// 👤 Criar cliente no Asaas
async function criarCliente(nome, telefone) {
    const response = await axios.post(
        "https://sandbox.asaas.com/api/v3/customers",
        {
            name: nome,
            phone: telefone
        },
        {
          headers: {
    access_token: ASAAS_API_KEY,
    "Content-Type": "application/json"
}
            }
        }
    );

    return response.data.id;
}

// 💳 Gerar PIX
async function gerarPix(valor, clienteId) {
    const response = await axios.post(
        "https://sandbox.asaas.com/api/v3/payments",
        {
            customer: clienteId,
            billingType: "PIX",
            value: valor,
            dueDate: new Date().toISOString().split("T")[0]
        },
        {
          headers: {
    access_token: ASAAS_API_KEY,
    "Content-Type": "application/json"
}
            }
        }
    );

    return response.data;
}

// 🚀 WEBHOOK Z-API
app.post('/webhook', async (req, res) => {
    const data = req.body;

    const mensagem = data?.text?.message?.toLowerCase();
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

            await enviarMensagem(numero,
`💳 *PIX gerado*

💰 Valor: R$10

📌 Copia e cola:
${pagamento.pixQrCode}

Após pagar, aguarde confirmação automática`
            );

        } catch (erro) {
            console.log("Erro PIX:", erro.response?.data || erro.message);
            await enviarMensagem(numero, "❌ Erro ao gerar pagamento. Tente novamente.");
        }
    }

    res.sendStatus(200);
});

// 💰 WEBHOOK ASAAS
app.post('/asaas', async (req, res) => {
    const data = req.body;

    console.log("Asaas:", data);

    if (data.event === "PAYMENT_RECEIVED") {
        // Aqui você pode melhorar depois (mapear telefone)
        console.log("Pagamento confirmado!");

        // ⚠️ Aqui ainda falta mapear número corretamente
    }

    res.sendStatus(200);
});

// STATUS
app.post('/status', (req, res) => {
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
