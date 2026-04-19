const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// 🔐 CONFIG
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

// 🔥 URL ASAAS
const ASAAS_URL = "https://api.asaas.com/v3";

// 📂 ARQUIVOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

// 📦 DADOS
let pedidos = [];
let clientes = {};

if (fs.existsSync(PEDIDOS_FILE)) {
    pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE));
}

if (fs.existsSync(CLIENTES_FILE)) {
    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE));
}

// 💾 SALVAR
const salvarPedidos = () => {
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
};

const salvarClientes = () => {
    fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientes, null, 2));
};

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
    if (clientes[telefone]) return clientes[telefone];

    const response = await axios.post(
        `${ASAAS_URL}/customers`,
        { name: nome, phone: telefone },
        {
            headers: {
                access_token: ASAAS_API_KEY
            }
        }
    );

    clientes[telefone] = response.data.id;
    salvarClientes();

    return response.data.id;
}

// 💳 GERAR PIX
async function gerarPix(valor, clienteId) {
    const response = await axios.post(
        `${ASAAS_URL}/payments`,
        {
            customer: clienteId,
            billingType: "PIX",
            value: valor,
            dueDate: new Date().toISOString().split("T")[0]
        },
        {
            headers: {
                access_token: ASAAS_API_KEY
            }
        }
    );

    return response.data;
}

// 🚀 WEBHOOK WHATSAPP
app.post('/webhook', async (req, res) => {
    console.log("🔥 CHEGOU");

    const numero = req.body?.phone || req.body?.from;

    if (numero) {
        await axios.post(
            `https://api.z-api.io/instances/${process.env.INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
            {
                phone: numero,
                message: "TESTE OK 🚀"
            }
        );
    }

    res.sendStatus(200);
});

// 💰 WEBHOOK ASAAS
app.post('/asaas', async (req, res) => {
    const data = req.body;

    console.log("ASAAS EVENT:", data.event);

    if (data.event === "PAYMENT_CONFIRMED") {

        const paymentId = data.payment.id;

        const pedido = pedidos.find(p => p.paymentId === paymentId);

        if (pedido && pedido.status !== "pago") {

            pedido.status = "pago";
            salvarPedidos();

            await enviarMensagem(
                pedido.telefone,
                "✅ Pagamento confirmado! Pedido aceito 🍦"
            );
        }
    }

    res.sendStatus(200);
});

// 📦 API
app.get('/pedidos', (req, res) => res.json(pedidos));

app.patch('/pedidos/:id', (req, res) => {
    const pedido = pedidos.find(p => p.id === req.params.id);

    if (!pedido) {
        return res.status(404).json({ error: "Pedido não encontrado" });
    }

    Object.assign(pedido, req.body);
    salvarPedidos();

    res.json(pedido);
});

// 🌐 TESTE
app.get('/', (req, res) => {
    res.send("Servidor rodando 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
