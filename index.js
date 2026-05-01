const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 CONFIGURAÇÕES
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 📂 FICHEIROS DE DADOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

let pedidos = [];
let clientes = {};
const conversoesAtivas = {}; 

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

// 👤 GESTÃO DE CLIENTES ASAAS
async function obterOuCriarCliente(nome, telefone, cpfUsuario) {
    try {
        const response = await axios.post(
            "https://api.asaas.com/v3/customers",
            { name: nome, phone: telefone, cpfCnpj: cpfUsuario },
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

// 💳 GERAÇÃO DE PIX ASAAS
async function gerarPix(valor, clienteId) {
    const cobranca = await axios.post(
        "https://api.asaas.com/v3/payments",
        {
            customer: clienteId,
            billingType: "PIX",
            value: valor,
            dueDate: new Date().toISOString().split("T")[0]
        },
        { headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" } }
    );
    const qrCode = await axios.get(
        `https://api.asaas.com/v3/payments/${cobranca.data.id}/pixQrCode`,
        { headers: { access_token: ASAAS_API_KEY } }
    );
    return { id: cobranca.data.id, payload: qrCode.data.payload };
}

// 🌐 ROTA DO SITE (BASE44) - INTACTA
app.post('/api/checkout-site', async (req, res) => {
    try {
        const { nome, telefone, cpf, valorTotal, pedidoId } = req.body;
        if (!cpf || cpf.length < 11) return res.status(400).json({ sucesso: false, erro: "CPF obrigatório." });

        const clienteId = await obterOuCriarCliente(nome, telefone, cpf.replace(/\D/g, ''));
        const pagamento = await gerarPix(valorTotal, clienteId);

        pedidos.push({
            id: pedidoId,
            telefone: telefone.replace(/\D/g, ''),
            valor: valorTotal,
            status: "aguardando_pagamento",
            paymentId: pagamento.id,
            origem: "site",
            createdAt: new Date()
        });
        await salvarPedidos();

        await enviarMensagem(telefone.replace(/\D/g, ''), `🍦 Olá ${nome}! Recebemos seu pedido. Caso o PIX não tenha aparecido, use o código:\n\n${pagamento.payload}`);
        res.json({ sucesso: true, pixCopiaECola: pagamento.payload, pedidoId });
    } catch (error) {
        res.status(500).json({ sucesso: false });
    }
});

// 🚀 WEBHOOK WHATSAPP COM IA DE ELITE
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const pedidoAguardando = pedidos.find(p => p.telefone === numero && p.status === "aguardando_pagamento");
        if (pedidoAguardando) {
            await enviarMensagem(numero, "⏳ Seu pedido está aguardando o PIX acima! Assim que pagar, eu te aviso aqui! 😉");
            return res.sendStatus(200);
        }

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [
                { role: "system", content: `Você é a Consultora de Vendas Especialista da TH DinDin Gourmet. Seu atendimento é leve, moderno (Recife/Paulista) e cheio de persuasão sutil.

### 🌟 PERSONALIDADE
- Atendimento humano: "E aí, beleza? No calor de Recife, nada melhor que um DinDin premium, né? 🔥"
- Sutileza: Nunca pressione. Use conveniência: "Muitos clientes pedem o combo de 5 unidades para garantir o frete grátis e o estoque do dia".

### 📘 CONHECIMENTO TÉCNICO
- Vendedores (Seg-Sex, 11:30-16:00): Indique TH (Boa Vista/Unicap), Sergio (Derby/Jaqueira), Tony (Ilha do Leite) ou Natanael (Hosp. Português) conforme o local.
- Revenda: Margem alta! 30 unid (R$ 135,70) até 100 unid (R$ 419). A partir de 70 unid, sai a R$ 3,90/cada.
- Eventos: Orçamentos com até 45% de desconto. Pedir com 2 dias de antecedência para isopor personalizado.
- Retirada: Em Paratibe (Paulista) sai por R$ 6,99 (consumo local).
- Sabores (R$ 7,99): Mousse de Limão, Nutella, Ovomaltine, Paçoca, Oreo.

### 💳 PAGAMENTO ONLINE
- Não aceitamos dinheiro na entrega (Uber Flash/99Entrega). Pagamento via PIX ou Link de Cartão.

### 🤖 FECHAMENTO
Apenas com Sabores, Nome, Endereço e CPF (11 dígitos), gere o JSON:
{"nome": "[Nome]", "cpf": "[CPF]", "endereco": "[Endereço]", "itens": [{"nome": "Sabor", "preco": 7.99, "quantidade": 5}]}` }
            ];
        }

        conversoesAtivas[numero].push({ role: "user", content: mensagem });

        const respostaIA = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: conversoesAtivas[numero],
            temperature: 0.6
        });

        const textoIA = respostaIA.choices[0].message.content;
        conversoesAtivas[numero].push({ role: "assistant", content: textoIA });

        if (textoIA.includes('"cpf"') && textoIA.includes('"itens"')) {
            try {
                const inicioJson = textoIA.indexOf('{');
                const fimJson = textoIA.lastIndexOf('}') + 1;
                const jsonPedido = JSON.parse(textoIA.substring(inicioJson, fimJson));

                const valorTotal = jsonPedido.itens.reduce((acc, item) => acc + (item.preco * item.quantidade), 0);
                const cpfLimpo = jsonPedido.cpf.replace(/\D/g, '');

                const clienteId = await obterOuCriarCliente(jsonPedido.nome, numero, cpfLimpo);
                const pagamento = await gerarPix(valorTotal, clienteId);

                pedidos.push({
                    id: `WA-${Date.now()}`,
                    telefone: numero,
                    valor: valorTotal,
                    status: "aguardando_pagamento",
                    paymentId: pagamento.id,
                    origem: "whatsapp",
                    createdAt: new Date(),
                    endereco: jsonPedido.endereco
                });
                await salvarPedidos();

                await enviarMensagem(numero, `🚀 Pedido anotado! Aqui está sua chave PIX:\n\n${pagamento.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}\nConfirmamos aqui no chat assim que o pagamento cair!`);
                delete conversoesAtivas[numero];
            } catch (err) {
                await enviarMensagem(numero, "❌ Houve um pequeno erro no sistema de PIX. Pode confirmar seus dados?");
            }
        } else {
            await enviarMensagem(numero, textoIA);
        }
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(200);
    }
});

// 💰 WEBHOOK ASAAS (INTACTO)
app.post('/asaas', async (req, res) => {
    try {
        if (req.headers['asaas-access-token'] !== ASAAS_WEBHOOK_TOKEN) return res.status(403).send("Não autorizado");
        if (req.body.event === "PAYMENT_RECEIVED") {
            const pedido = pedidos.find(p => p.paymentId === req.body.payment.id);
            if (pedido && pedido.status !== "pago") {
                pedido.status = "pago";
                await salvarPedidos();
                await enviarMensagem(pedido.telefone, "✅ *Pagamento Confirmado!* Já estamos preparando seu dindin gourmet! 🍦🚀");
            }
        }
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(500);
    }
});

app.get('/', (req, res) => res.send("API TH DinDin Ativa com IA de Elite! 🚀🤖"));
app.listen(process.env.PORT || 3000);
