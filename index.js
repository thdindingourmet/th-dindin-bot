const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;

const app = express();
app.use(express.json());

// 🔐 CONFIGURAÇÕES (Certifica-te de que estas variáveis estão no teu .env)
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN; // O token que configuraste no painel do Asaas

// 📂 FICHEIROS DE DADOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

let pedidos = [];
let clientes = {};

// Carregamento inicial
if (fs.existsSync(PEDIDOS_FILE)) {
    pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE));
}
if (fs.existsSync(CLIENTES_FILE)) {
    clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE));
}

// 💾 FUNÇÕES DE SALVAMENTO (Assíncronas)
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
            { 
                phone: numero, 
                message: mensagem 
            },
            {
                headers: {
                    // 👇 Enviando a senha extra exigida pela Z-API
                    "Client-Token": process.env.ZAPI_CLIENT_TOKEN 
                }
            }
        );
    } catch (error) {
        console.error("Erro ao enviar WhatsApp:", error.response?.data || error.message);
    }
}

// 👤 GESTÃO DE CLIENTES (Asaas) - Versão com CPF Falso para Teste 🕵️‍♂️
async function obterOuCriarCliente(nome, telefone) {
    try {
        console.log(`\n[ETAPA 1] Tentando criar cliente no Asaas. Número: ${telefone}`);
        
        const response = await axios.post(
            "https://sandbox.asaas.com/api/v3/customers",
            { 
                name: nome, 
                phone: telefone,
                cpfCnpj: "45564811029" // 👈 INJETAMOS UM CPF FALSO (porém válido matematicamente) SÓ PARA O TESTE PASSAR
            },
            { headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" } }
        );

        console.log(`[ETAPA 2] Sucesso! Cliente criado. ID: ${response.data.id}\n`);
        return response.data.id;

    } catch (error) {
        console.error(`\n🚨 [ERRO FATAL] Falha ao criar cliente:`, error.response?.data || error.message);
        throw error;
    }
}
// 💳 GERAÇÃO DE PIX (Com Logs de Investigação)
async function gerarPix(valor, clienteId) {
    try {
        // 1. Criar a cobrança no Sandbox
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

        console.log("✅ Cobrança criada com ID:", cobranca.data.id);

        // 2. Obter o código PIX Copia e Cola
        const qrCode = await axios.get(
            `https://sandbox.asaas.com/api/v3/payments/${cobranca.data.id}/pixQrCode`,
            { headers: { access_token: ASAAS_API_KEY } }
        );

        console.log("🔍 Resposta do Asaas para o Pix:", qrCode.data); // A nossa lupa!

        return {
            id: cobranca.data.id,
            payload: qrCode.data?.payload || "Erro: Payload não encontrado no Asaas"
        };
    } catch (error) {
        console.error("🚨 Erro na função gerarPix:", error.response?.data || error.message);
        throw error;
    }
}
// 🚀 WEBHOOK WHATSAPP (Entrada de mensagens)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = (data?.text?.message || data?.message || data?.body)?.toLowerCase()?.trim();
        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        if (mensagem === "oi" || mensagem === "olá") {
            await enviarMensagem(numero, "🍦 Bem-vindo à nossa loja!\nDigite *pedir* para comprar o seu dindin.");
        }

        if (mensagem === "pedir") {
            await enviarMensagem(numero, "⏳ A gerar o seu pagamento PIX... Por favor, aguarde.");

            try {
                const clienteId = await obterOuCriarCliente("Cliente WhatsApp", numero);
                const pagamento = await gerarPix(10.00, clienteId);

                const novoPedido = {
                    id: `${Date.now()}`,
                    telefone: numero,
                    valor: 10.00,
                    status: "pendente",
                    paymentId: pagamento.id,
                    createdAt: new Date()
                };

                pedidos.push(novoPedido);
                await salvarPedidos();

                await enviarMensagem(
    numero,
    `💳 *PIX Copia e Cola:*\n\n${pagamento.payload}\n\nApós pagar, aguarde a confirmação automática do nosso sistema 🍦`
);

            } catch (err) {
                console.error("Erro ao processar pedido:", err.message);
                await enviarMensagem(numero, "❌ Desculpe, ocorreu um erro ao gerar o seu pagamento. Tente novamente mais tarde.");
            }
        }

        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(200);
    }
});

// 💰 WEBHOOK ASAAS (Confirmação de Pagamento Segura)
app.post('/asaas', async (req, res) => {
    try {
        // 🛡️ VALIDAÇÃO DE SEGURANÇA
        const tokenRecebido = req.headers['asaas-access-token'];
        if (tokenRecebido !== ASAAS_WEBHOOK_TOKEN) {
            console.error("🚨 Alerta: Tentativa de acesso não autorizado ao Webhook do Asaas!");
            return res.status(403).send("Não autorizado");
        }

        const data = req.body;
        console.log(`Evento recebido do Asaas: ${data.event}`);

        if (data.event === "PAYMENT_RECEIVED") {
            const paymentId = data.payment.id;
            const pedido = pedidos.find(p => p.paymentId === paymentId);

            if (pedido && pedido.status !== "pago") {
                pedido.status = "pago";
                await salvarPedidos();

                await enviarMensagem(
                    pedido.telefone,
                    "✅ *Pagamento Confirmado!*\n\nO seu dindin já está a ser preparado e sairá em breve para entrega. Obrigado! 🍦"
                );
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Erro no processamento do Webhook Asaas:", error.message);
        res.sendStatus(500);
    }
});

// 📊 ROTAS AUXILIARES
app.get('/pedidos', (req, res) => res.json(pedidos));

app.get('/', (req, res) => res.send("Servidor do Bot de Vendas Ativo! 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor a correr na porta ${PORT}`));
