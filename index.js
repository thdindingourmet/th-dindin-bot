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

// 📂 BANCO DE DADOS LOCAL
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

// 🔍 SINCRONIZAÇÃO COM A LOJA REAL (BASE44)
async function sincronizarEstoque() {
    const agora = Date.now();
    if (estoqueCache.texto !== "Carregando sabores..." && (agora - estoqueCache.lastUpdate < 300000)) {
        return estoqueCache.texto;
    }
    try {
        const response = await axios.get(CATALOGO_URL);
        const html = response.data.toLowerCase();
        // Lista oficial de sabores que monitoramos no seu site
        const listaSabores = ["nutella", "ovomaltine", "limão", "paçoca", "oreo", "ninho", "ameixa"];
        let disponiveis = [];
        listaSabores.forEach(sabor => {
            if (html.includes(sabor)) { disponiveis.push(sabor.charAt(0).toUpperCase() + sabor.slice(1)); }
        });
        estoqueCache = { texto: disponiveis.length > 0 ? disponiveis.join(", ") : "Sabores variados", lastUpdate: agora };
        return estoqueCache.texto;
    } catch (error) { return "Nutella, Oreo, Paçoca, Mousse de Limão, Ovomaltine"; }
}

// 📩 FUNÇÕES DE COMUNICAÇÃO
async function enviarMensagem(numero, mensagem) {
    try {
        await axios.post(`https://api.z-api.io/instances/${INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
        { phone: numero, message: mensagem }, { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } });
    } catch (e) { console.error("Erro Zap:", e.message); }
}

async function obterOuCriarCliente(nome, telefone, cpfUsuario) {
    const response = await axios.post("https://api.asaas.com/v3/customers", 
    { name: nome, phone: telefone, cpfCnpj: cpfUsuario }, { headers: { access_token: ASAAS_API_KEY } });
    clientes[telefone] = response.data.id;
    await salvarClientes();
    return response.data.id;
}

// 🚀 WEBHOOK PRINCIPAL (FILTRO DE GRUPO + IA DE VENDAS)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        
        // 🛑 BLOQUEIO DE GRUPOS: Evita que a IA responda em grupos públicos
        const isGroup = (data?.phone && data.phone.includes('@g.us')) || (data?.from && data.from.includes('@g.us'));
        if (data?.fromMe || isGroup) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const cardapioReal = await sincronizarEstoque();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [{ role: "system", content: `Você é a Consultora de Vendas da TH DinDin Gourmet. 
Seu tom é leve, moderno e sutil. Você foca em Recife e Paulista.

### 🧊 ESTOQUE REAL AGORA:
Estes são os únicos sabores disponíveis: ${cardapioReal}. 
NUNCA mencione Manga, Mamão ou sabores fora desta lista.

### 🚲 VENDEDORES E REGIÕES (Seg-Sex, 11:30 às 16:00):
- TH (Thiago): Boa Vista, Santo Amaro, Unicap, Unibra, Oswaldo Cruz.
- Sergio Ricardo: Derby, Jaqueira, Parnamirim, Caxangá.
- Tony: Ilha do Leite, Agamenon, Graças, Senac.
- Natanael: Hosp. Português (até 14:20), HR, Casa Amarela (14:45).

### 💰 REGRAS SUTIS:
- Unidade: R$ 7,99.
- Promoção: "Muitos clientes levam 5 unidades para garantir a entrega grátis".
- Pagamento: Apenas PIX ou Cartão Online (por segurança dos motoboys).

### 🤖 FECHAMENTO DE PEDIDO:
Gere JSON somente com Nome, CPF, Endereço e Sabores:
{"nome": "[Nome]", "cpf": "[CPF]", "endereco": "[Endereço]", "itens": [{"nome": "Sabor", "preco": 7.99, "quantidade": 5}]}` }];
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
            const cobranca = await axios.post("https://api.asaas.com/v3/payments", { customer: clienteId, billingType: "PIX", value: valorTotal, dueDate: new Date().toISOString().split("T")[0] }, { headers: { access_token: ASAAS_API_KEY } });
            const qr = await axios.get(`https://api.asaas.com/v3/payments/${cobranca.data.id}/pixQrCode`, { headers: { access_token: ASAAS_API_KEY } });
            pedidos.push({ id: `WA-${Date.now()}`, telefone: numero, valor: valorTotal, status: "aguardando_pagamento", paymentId: cobranca.data.id });
            await salvarPedidos();
            await enviarMensagem(numero, `🚀 Pedido fechado com sucesso! Aqui está o seu PIX:\n\n${qr.data.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}`);
            delete conversoesAtivas[numero];
        } else { await enviarMensagem(numero, textoIA); }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

app.get('/', (req, res) => res.send("API TH DinDin V4.5 - Inteligência de Vendas Privada! 🍦🚀"));
app.listen(process.env.PORT || 3000);
