const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 🔐 CONFIG
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

// 📦 Armazenamento de pedidos em memória
const pedidos = [];

// 📩 Enviar mensagem WhatsApp
async function enviarMensagem(numero, mensagem) {
    await axios.post(
        `https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        {
            phone: numero,
            message: mensagem
        }
    );
}

// 👤 Criar cliente
async function criarCliente(nome, telefone) {
    const response = await axios.post(
        "https://api.asaas.com/v3/customers",
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
    );

    return response.data.id;
}

// 💳 Gerar PIX
async function gerarPix(valor, clienteId) {
    const response = await axios.post(
        "https://api.asaas.com/v3/payments",
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
    );

    return response.data;
}

// 🚀 WEBHOOK
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;

        console.log("BODY:", JSON.stringify(data, null, 2));

        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = (
            data?.text?.message ||
            data?.message ||
            data?.body
        )?.toLowerCase()?.trim();

        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        if (mensagem === "oi") {
            await enviarMensagem(numero, "🍦 Bem-vindo!\nDigite *pedir*");
        }

        if (mensagem === "pedir") {
            await enviarMensagem(numero, "💰 Gerando PIX...");

            try {
                const clienteId = await criarCliente("Cliente", numero);
                const pagamento = await gerarPix(10, clienteId);

                const pix = pagamento?.pix?.payload;

                if (!pix) throw new Error("PIX não gerado");

                // 📦 Salvar pedido
                const novoPedido = {
                    id: Date.now(),
                    telefone: numero,
                    status: "pendente",
                    total: 10,
                    itens: [],
                    created_at: new Date().toISOString()
                };
                pedidos.push(novoPedido);

                await enviarMensagem(
                    numero,
                    `💳 PIX:\n${pix}\n\nApós pagar, aguarde confirmação`
                );

            } catch (erro) {
                console.error("Erro PIX:", erro.response?.data || erro.message);
                await enviarMensagem(numero, "❌ Erro ao gerar PIX");
            }
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("Erro webhook:", error);
        res.sendStatus(200);
    }
});

// 📦 Listar pedidos (usado pelo Base44 para sincronização)
app.get('/pedidos', (req, res) => {
    res.json(pedidos);
});

// 📥 Criar pedido via API
app.post('/pedidos', (req, res) => {
    const novoPedido = {
        id: Date.now(),
        ...req.body,
        created_at: new Date().toISOString()
    };
    pedidos.push(novoPedido);
    console.log("Novo pedido criado:", novoPedido);
    res.json(novoPedido);
});

// 🔄 Atualizar status do pedido
app.patch('/pedidos/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const pedido = pedidos.find(p => p.id === id);
    
    if (!pedido) {
        return res.status(404).json({ error: "Pedido não encontrado" });
    }

    Object.assign(pedido, req.body);
    console.log("Pedido atualizado:", pedido);
    res.json(pedido);
});

// 🌐 TESTE
app.get('/', (req, res) => {
    res.send("Servidor rodando 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
