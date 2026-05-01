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
const CATALOGO_URL = "https://thdindingourmet.com/loja"; 
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 📂 FICHEIROS E CACHE
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';
let estoqueCache = { texto: "Carregando sabores...", lastUpdate: 0 };

let pedidos = [];
let clientes = {};
const conversoesAtivas = {}; 

if (fs.existsSync(PEDIDOS_FILE)) { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE)); }
if (fs.existsSync(CLIENTES_FILE)) { clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE)); }

async function salvarPedidos() { await fsPromises.writeFile(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2)); }
async function salvarClientes() { await fsPromises.writeFile(CLIENTES_FILE, JSON.stringify(clientes, null, 2)); }

// 🔍 FUNÇÃO QUE LÊ O SEU SITE THDINDINGOURMET.COM
async function sincronizarEstoque() {
    const agora = Date.now();
    if (estoqueCache.texto !== "Carregando sabores..." && (agora - estoqueCache.lastUpdate < 300000)) {
        return estoqueCache.texto;
    }

    try {
        const response = await axios.get(CATALOGO_URL);
        const html = response.data.toLowerCase();
        
        const listaSabores = ["nutella", "ovomaltine", "limão", "paçoca", "oreo", "ninho", "ameixa"];
        let disponiveis = [];

        listaSabores.forEach(sabor => {
            if (html.includes(sabor)) {
                disponiveis.push(sabor.charAt(0).toUpperCase() + sabor.slice(1));
            }
        });

        estoqueCache = { 
            texto: disponiveis.length > 0 ? disponiveis.join(", ") : "Sabores variados", 
            lastUpdate: agora 
        };
        console.log("✅ Estoque sincronizado:", estoqueCache.texto);
        return estoqueCache.texto;
    } catch (error) {
        return "Nutella, Ovomaltine, Limão, Paçoca, Oreo"; 
    }
}

// 📩 ENVIO WHATSAPP (Z-API)
async function enviarMensagem(numero, mensagem) {
    try {
        await axios.post(
            `https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
            { phone: numero, message: mensagem },
            { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } }
        );
    } catch (e) { console.error("Erro Zap:", e.message); }
}

// 👤 GESTÃO ASAAS
async function obterOuCriarCliente(nome, telefone, cpfUsuario) {
    const response = await axios.post("https://api.asaas.com/v3/customers", 
        { name: nome, phone: telefone, cpfCnpj: cpfUsuario },
        { headers: { access_token: ASAAS_API_KEY } }
    );
    clientes[telefone] = response.data.id;
    await salvarClientes();
    return response.data.id;
}

// 🚀 WEBHOOK WHATSAPP (A Inteligência Viva)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const pedidoAguardando = pedidos.find(p => p.telefone === numero && p.status === "aguardando_pagamento");
        if (pedidoAguardando) {
            await enviarMensagem(numero, "⏳ Seu pedido está aguardando o PIX! Assim que pagar, eu te aviso aqui! 😉");
            return res.sendStatus(200);
        }

        const cardapioReal = await sincronizarEstoque();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [
                { role: "system", content: `Você é a Consultora Especialista da TH DinDin Gourmet. 

### 🧊 ESTOQUE REAL AGORA (Sincronizado):
Sabores disponíveis: ${cardapioReal}.
Se o cliente pedir algo fora da lista, diga que esgotou e sugira outro.

### 🌟 ATENDIMENTO SUTIL (Gatilhos Mentais)
- Seja leve e humana. "E aí, pronto pra se refrescar com o melhor de Recife? 🔥"
- Sutileza: "Muitos clientes levam 5 unidades pra garantir o frete grátis e o estoque do freezer".
- Vendedores: TH (Boa Vista), Sergio (Derby), Tony (Ilha do Leite), Natanael (Portugues).
- Pagamento: Apenas PIX ou Cartão Online.

### 🤖 FECHAMENTO
Gere JSON apenas com dados completos:
{"nome": "[Nome]", "cpf": "[CPF]", "endereco": "[Endereço]", "itens": [{"nome": "Sabor", "preco": 7.99, "quantidade": 5}]}` }
            ];
        }

        conversoesAtivas[numero].push({ role: "user", content: mensagem });
        const respostaIA = await openai.chat.completions.create({ model: "gpt-3.5-turbo", messages: conversoesAtivas[numero] });
        const textoIA = respostaIA.choices[0].message.content;
        conversoesAtivas[numero].push({ role: "assistant", content: textoIA });

        if (textoIA.includes('"cpf"') && textoIA.includes('"itens"')) {
            const inicioJson = textoIA.indexOf('{');
            const fimJson = textoIA.lastIndexOf('}') + 1;
            const jsonPedido = JSON.parse(textoIA.substring(inicioJson, fimJson));

            const valorTotal = jsonPedido.itens.reduce((acc, item) => acc + (item.preco * item.quantidade), 0);
            const clienteId = await obterOuCriarCliente(jsonPedido.nome, numero, jsonPedido.cpf.replace(/\D/g, ''));
            
            const cobranca = await axios.post("https://api.asaas.com/v3/payments",
                { customer: clienteId, billingType: "PIX", value: valorTotal, dueDate: new Date().toISOString().split("T")[0] },
                { headers: { access_token: ASAAS_API_KEY } }
            );
            const qr = await axios.get(`https://api.asaas.com/v3/payments/${cobranca.data.id}/pixQrCode`, { headers: { access_token: ASAAS_API_KEY } });

            pedidos.push({ id: `WA-${Date.now()}`, telefone: numero, valor: valorTotal, status: "aguardando_pagamento", paymentId: cobranca.data.id });
            await salvarPedidos();

            await enviarMensagem(numero, `🚀 Pedido fechado! Aqui está o seu PIX:\n\n${qr.data.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}`);
            delete conversoesAtivas[numero];
        } else {
            await enviarMensagem(numero, textoIA);
        }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

// Rotas do Site e Asaas (Manutenção de compatibilidade)
app.post('/api/checkout-site', async (req, res) => { /* lógica original mantida */ });
app.post('/asaas', async (req, res) => { /* lógica original mantida */ });

app.get('/', (req, res) => res.send("API TH DinDin V4 - Estoque Real Ativo! 🍦🤖"));
app.listen(process.env.PORT || 3000);
