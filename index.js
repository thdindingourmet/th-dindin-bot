const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises; // Usado para não travar o Node.js ao salvar

const app = express();
app.use(express.json());

// 🔐 CONFIG
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

// 📂 ARQUIVOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

// 📦 CARREGAR DADOS (Rodado apenas ao iniciar o servidor)
let pedidos = [];
let clientes = {};

if (fs.existsSync(PEDIDOS_FILE)) {
    pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE));
}

if (fs.existsSync(CLIENTES_FILE)) {
    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE));
}

// 💾 SALVAR (Modo assíncrono para evitar lentidão e travamentos)
async function salvarPedidos() {
    await fsPromises.writeFile(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
}

async function salvarClientes() {
    await fsPromises.writeFile(CLIENTES_FILE, JSON.stringify(clientes, null, 2));
}

// 📩 WHATSAPP
async function enviarMensagem(numero, mensagem) {
    await axios.post(
        `https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        {
            phone: numero,
            message: mensagem
        }
    );
}

// 👤 CLIENTE ASAAS
async function obterOuCriarCliente(nome, telefone) {
    if (clientes[telefone]) {
        return clientes[telefone];
    }

    const response = await axios.post(
        "https://api.asaas.com/v3/customers",
        { name: nome, phone: telefone },
        {
            headers: {
                access_token: ASAAS_API_KEY,
                "Content-Type": "application/json"
            }
        }
    );

    clientes[telefone] = response.data.id;
    await salvarClientes(); // Adicionado await

    return response.data.id;
}

// 💳 PIX (CORRIGIDO: Agora faz 2 requisições para pegar o Copia e Cola)
async function gerarPix(valor, clienteId) {
    // 1. Cria a cobrança no Asaas
    const cobranca = await axios.post(
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

    // 2. Busca o QR Code e o Copia e Cola da cobrança gerada
    const qrCode = await axios.get(
        `https://api.asaas.com/v3/payments/${cobranca.data.id}/pixQrCode`,
        {
            headers: {
                access_token: ASAAS_API_KEY
            }
        }
    );

    return {
        id: cobranca.data.id,
        payload: qrCode.data.payload // Código Copia e Cola final
    };
}

// 🚀 WEBHOOK WHATSAPP
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;

        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = (
            data?.text?.message ||
            data?.message ||
            data?.body
        )?.toLowerCase()?.trim();

        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        // 👋 INICIO
        if (mensagem === "oi") {
            await enviarMensagem(numero, "🍦 Bem-vindo!\nDigite *pedir* para iniciar seu pedido.");
        }

        // 🧾 PEDIDO
        if (mensagem === "pedir") {
            await enviarMensagem(numero, "💰 Gerando pagamento PIX...");

            try {
                const pedido = {
                    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    cliente: "Cliente Dindin",
                    telefone: numero,
                    valor: 10,
                    status: "aguardando_pagamento",
                    paymentId: null,
                    createdAt: new Date()
                };

                pedidos.push(pedido);
                await salvarPedidos(); // Adicionado await

                // Integração
                const clienteId = await obterOuCriarCliente("Cliente Dindin", numero);
                const pagamento = await gerarPix(10, clienteId);

                // Validação do novo retorno
                if (!pagamento?.payload) {
                    throw new Error("Payload do PIX não gerado pelo Asaas.");
                }

                pedido.paymentId = pagamento.id;
                await salvarPedidos();

                await enviarMensagem(
                    numero,
                    `💳 *PIX Copia e Cola:*\n\n${pagamento.payload}\n\nApós pagar, aguarde a confirmação automática do nosso sistema 🍦`
                );

            } catch (erro) {
                console.error("ERRO Geração PIX:", erro.response?.data || erro.message);
                await enviarMensagem(numero, "❌ Erro ao gerar pagamento. Tente novamente em alguns minutos.");
            }
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("Erro webhook Z-API:", error);
        res.sendStatus(200);
    }
});

// 💰 WEBHOOK ASAAS
app.post('/asaas', async (req, res) => {
    try {
        const data = req.body;
        console.log("Evento ASAAS Recebido:", data.event);

        // Opcional: Adicionar validação do Header asaas-access-token aqui no futuro

        if (data.event === "PAYMENT_RECEIVED") {
            const paymentId = data.payment.id;
            const pedido = pedidos.find(p => p.paymentId === paymentId);

            if (pedido && pedido.status !== "pago") {
                pedido.status = "pago";
                await salvarPedidos();

                await enviarMensagem(
                    pedido.telefone,
                    "✅ Pagamento confirmado! Seu pedido foi aceito e já estamos separando seu dindin 🍦"
                );
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Erro webhook ASAAS:", error);
        res.sendStatus(500);
    }
});

// 📦 API PEDIDOS
app.get('/pedidos', (req, res) => {
    res.json(pedidos);
});

app.patch('/pedidos/:id', async (req, res) => {
    const pedido = pedidos.find(p => p.id === req.params.id);

    if (!pedido) {
        return res.status(404).json({ error: "Pedido não encontrado" });
    }

    Object.assign(pedido, req.body);
    await salvarPedidos();

    res.json(pedido);
});

// 🌐 TESTE
app.get('/', (req, res) => {
    res.send("Servidor rodando 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
