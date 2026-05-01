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
const BASE44_MENU_URL = "https://thdindin.base44.com.br/api/products"; // 👈 Ajuste para o endpoint real da Base44
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 📂 FICHEIROS E CACHE
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';
let estoqueCache = { data: null, lastUpdate: 0 };

let pedidos = [];
let clientes = {};
const conversoesAtivas = {}; 

if (fs.existsSync(PEDIDOS_FILE)) { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE)); }
if (fs.existsSync(CLIENTES_FILE)) { clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE)); }

async function salvarPedidos() { await fsPromises.writeFile(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2)); }
async function salvarClientes() { await fsPromises.writeFile(CLIENTES_FILE, JSON.stringify(clientes, null, 2)); }

// 🔍 CONSULTA ESTOQUE REAL (BASE44)
async function obterEstoqueAtualizado() {
    const agora = Date.now();
    if (estoqueCache.data && (agora - estoqueCache.lastUpdate < 300000)) return estoqueCache.data; // Cache 5 min

    try {
        const response = await axios.get(BASE44_MENU_URL);
        // Filtra apenas produtos ativos/em estoque
        const disponiveis = response.data
            .filter(p => p.active && p.stock > 0)
            .map(p => `${p.name} (R$ ${p.price})`)
            .join(", ");
        
        estoqueCache = { data: disponiveis, lastUpdate: agora };
        return disponiveis;
    } catch (error) {
        console.error("Erro ao ler Base44:", error.message);
        return "Nutella, Oreo, Paçoca, Mousse de Limão, Ovomaltine"; // Fallback
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
    } catch (error) {
        console.error("Erro WhatsApp:", error.response?.data || error.message);
    }
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

// 💳 GERAÇÃO PIX
async function gerarPix(valor, clienteId) {
    const cobranca = await axios.post("https://api.asaas.com/v3/payments",
        { customer: clienteId, billingType: "PIX", value: valor, dueDate: new Date().toISOString().split("T")[0] },
        { headers: { access_token: ASAAS_API_KEY } }
    );
    const qr = await axios.get(`https://api.asaas.com/v3/payments/${cobranca.data.id}/pixQrCode`, { headers: { access_token: ASAAS_API_KEY } });
    return { id: cobranca.data.id, payload: qr.data.payload };
}

// 🚀 WEBHOOK WHATSAPP (A Inteligência Viva)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const statusEstoque = await obterEstoqueAtualizado();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [
                { role: "system", content: `Você é a Consultora Especialista da TH DinDin Gourmet. 
Seu tom é leve, humano e sutil (persuasão invisível).

### 🧊 ESTOQUE EM TEMPO REAL (BASE44)
Estes são os sabores disponíveis AGORA: ${statusEstoque}.
Se o cliente pedir algo fora desta lista, informe gentilmente que a produção daquele sabor acabou mas sugira o mais próximo.

### 📘 REGRAS DE OURO
- Vendedores: TH (Boa Vista), Sergio (Derby), Tony (Ilha do Leite), Natanael (Portugues).
- Promoção: A partir de 5 unid = Entrega Grátis (fale disso como conveniência).
- Revenda: Lucro alto! 70+ unid sai a R$ 3,90/cada.
- Pagamento: Apenas PIX/Cartão Online (Segurança Uber Flash).

### 🤖 FECHAMENTO
Gere JSON apenas com dados completos:
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
            const inicioJson = textoIA.indexOf('{');
            const fimJson = textoIA.lastIndexOf('}') + 1;
            const jsonPedido = JSON.parse(textoIA.substring(inicioJson, fimJson));

            const valorTotal = jsonPedido.itens.reduce((acc, item) => acc + (item.preco * item.quantidade), 0);
            const clienteId = await obterOuCriarCliente(jsonPedido.nome, numero, jsonPedido.cpf.replace(/\D/g, ''));
            const pagamento = await gerarPix(valorTotal, clienteId);

            pedidos.push({ id: `WA-${Date.now()}`, telefone: numero, valor: valorTotal, status: "aguardando_pagamento", paymentId: pagamento.id, endereco: jsonPedido.endereco });
            await salvarPedidos();

            await enviarMensagem(numero, `🚀 Pedido fechado! Use o PIX abaixo:\n\n${pagamento.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}`);
            delete conversoesAtivas[numero];
        } else {
            await enviarMensagem(numero, textoIA);
        }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

// Rotas de Status e Asaas (Iguais ao original para manter compatibilidade)
app.get('/', (req, res) => res.send("API TH DinDin V3 - Inteligência de Estoque Ativa! 🍦🚀"));
app.listen(process.env.PORT || 3000);
