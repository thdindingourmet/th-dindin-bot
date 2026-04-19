const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;

const app = express();
app.use(express.json());

// 🔐 CONFIGURAÇÕES
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;

// 📂 FICHEIROS DE DADOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

let pedidos = [];
let clientes = {};

if (fs.existsSync(PEDIDOS_FILE)) {
    pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE));
}
if (fs.existsSync(CLIENTES_FILE)) {
    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE));
}

async function salvarPedidos() {
    await fsPromises.writeFile(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
}

async function salvarClientes() {
    await fsPromises.writeFile(CLIENTES_FILE, JSON.stringify(clientes, null, 2));
}

// 📩 ENVIO WHATSAPP (Z-API)
async function enviarMensagem(numero, mensagem) {
    try {
        await axios.post(
            `https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
            { phone: numero, message: mensagem },
            { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } }
        );
    } catch (error) {
        console.error("Erro ao enviar WhatsApp:", error.response?.data || error.message);
    }
}

// 👤 GESTÃO DE CLIENTES (Asaas) - Agora recebe o CPF real
async function obterOuCriarCliente(nome, telefone, cpfUsuario) {
    try {
        // Para este teste, vamos sempre criar no Sandbox
        console.log(`\nCriando cliente com CPF: ${cpfUsuario}`);
        
        const response = await axios.post(
            "https://sandbox.asaas.com/api/v3/customers",
            { 
                name: nome, 
                phone: telefone,
                cpfCnpj: cpfUsuario // 👈 Aqui entra o CPF que o cliente digitou no zap!
            },
            { headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" } }
        );

        clientes[telefone] = response.data.id;
        await salvarClientes();
        return response.data.id;
    } catch (error) {
        console.error(`🚨 Erro ao criar cliente:`, error.response?.data || error.message);
        throw error;
    }
}

// 💳 GERAÇÃO DE PIX
async function gerarPix(valor, clienteId) {
    try {
        const cobranca = await axios.post(
            "https://sandbox.asaas.com/api/v3/payments",
            {
                customer: clienteId,
                billingType: "PIX",
                value: valor,
                dueDate: new Date().toISOString().split("T")[0]
            },
            { headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" } }
        );

        const qrCode = await axios.get(
            `https://sandbox.asaas.com/api/v3/payments/${cobranca.data.id}/pixQrCode`,
            { headers: { access_token: ASAAS_API_KEY } }
        );

        return { id: cobranca.data.id, payload: qrCode.data.payload };
    } catch (error) {
        throw error;
    }
}

// 🚀 WEBHOOK WHATSAPP (O Cérebro da Conversa)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = (data?.text?.message || data?.message || data?.body)?.toLowerCase()?.trim();
        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        // 👋 INÍCIO
        if (mensagem === "oi" || mensagem === "olá") {
            await enviarMensagem(numero, "🍦 Bem-vindo à TH DinDin Gourmet!\n\nDigite *pedir* para fazer a sua encomenda.");
            return res.sendStatus(200);
        }

        // 🧾 PASSO 1: CLIENTE PEDE
        if (mensagem === "pedir") {
            // Criamos um pedido com status de "espera"
            const novoPedido = {
                id: `${Date.now()}`,
                telefone: numero,
                valor: 10.00,
                status: "aguardando_cpf", // 👈 O Bot sabe que o próximo passo é o CPF
                createdAt: new Date()
            };
            pedidos.push(novoPedido);
            await salvarPedidos();

            await enviarMensagem(numero, "📝 Para gerar o seu pagamento PIX de R$ 10,00, por favor, *digite o seu CPF* (apenas números):");
            return res.sendStatus(200);
        }

        // 🧾 PASSO 2: BOT RECEBE O CPF
        // Procura se este número de telemóvel tem algum pedido à espera de CPF
        const pedidoPendente = pedidos.find(p => p.telefone === numero && p.status === "aguardando_cpf");

        if (pedidoPendente) {
            // Limpa a mensagem (remove pontos e traços, deixa só os números)
            const cpfLimpo = mensagem.replace(/\D/g, '');

            // Validação simples para ver se tem 11 dígitos
            if (cpfLimpo.length !== 11) {
                await enviarMensagem(numero, "❌ CPF inválido. Por favor, digite os 11 números do seu CPF, sem pontos ou traços:");
                return res.sendStatus(200);
            }

            await enviarMensagem(numero, "⏳ Validando os dados e a gerar o seu PIX...");

            try {
                // Passa o CPF limpo para o Asaas
                const clienteId = await obterOuCriarCliente("Cliente WhatsApp", numero, cpfLimpo);
                const pagamento = await gerarPix(pedidoPendente.valor, clienteId);

                // Atualiza o pedido para "aguardando_pagamento"
                pedidoPendente.status = "aguardando_pagamento";
                pedidoPendente.paymentId = pagamento.id;
                await salvarPedidos();

                await enviarMensagem(
                    numero,
                    `💳 *PIX Copia e Cola:*\n\n${pagamento.payload}\n\n✅ O seu pedido será confirmado automaticamente assim que o pagamento cair na conta!`
                );
            } catch (err) {
                await enviarMensagem(numero, "❌ Ocorreu um erro ao gerar o pagamento com este CPF. Tente novamente mais tarde.");
            }
            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(200);
    }
});

// 💰 WEBHOOK ASAAS (Confirmação de Pagamento)
app.post('/asaas', async (req, res) => {
    try {
        const tokenRecebido = req.headers['asaas-access-token'];
        if (tokenRecebido !== ASAAS_WEBHOOK_TOKEN) return res.status(403).send("Não autorizado");

        const data = req.body;

        if (data.event === "PAYMENT_RECEIVED") {
            const paymentId = data.payment.id;
            const pedido = pedidos.find(p => p.paymentId === paymentId);

            if (pedido && pedido.status !== "pago") {
                pedido.status = "pago";
                await salvarPedidos();

                await enviarMensagem(pedido.telefone, "✅ *Pagamento Confirmado!*\n\nO seu dindin já está a ser preparado e será entregue em breve. Obrigado pela preferência! 🍦");
            }
        }
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(500);
    }
});

app.get('/pedidos', (req, res) => res.json(pedidos));
app.get('/', (req, res) => res.send("TH DinDin Bot Ativo! 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
