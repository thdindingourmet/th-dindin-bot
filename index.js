const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 CONFIGURAÇÕES (Railway cuidará das variáveis)
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

// 🔍 SINCRONIZAÇÃO COM A LOJA (BASE44)
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
            if (html.includes(sabor)) { disponiveis.push(sabor.charAt(0).toUpperCase() + sabor.slice(1)); }
        });
        estoqueCache = { texto: disponiveis.length > 0 ? disponiveis.join(", ") : "Sabores variados", lastUpdate: agora };
        return estoqueCache.texto;
    } catch (error) { return "Nutella, Oreo, Paçoca, Mousse de Limão, Ovomaltine"; }
}

// 📩 FUNÇÕES DE APOIO (WhatsApp e Asaas)
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

// 🚀 WEBHOOK COM CONSULTORIA DE VENDAS
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);
        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const cardapioReal = await sincronizarEstoque();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [{ role: "system", content: `Você é a Consultora Especialista da TH DinDin Gourmet. 
Seu atendimento é leve, moderno e usa persuasão sutil (sem pressionar).

### 🧊 ESTOQUE REAL (Sincronizado):
Sabores disponíveis: ${cardapioReal}. 
NUNCA invente sabores como Manga ou Mamão. Se não estiver na lista acima, diga que esgotou.

### 🌟 REGRAS DE NEGÓCIO
- Vendedores: TH (Boa Vista), Sergio (Derby), Tony (Ilha do Leite), Natanael (Portugues).
- Sutileza: "Muitos clientes garantem 5 unidades para ter entrega grátis e estoque no freezer".
- Revenda: Lucro alto! Acima de 70 unid o preço cai para R$ 3,90/cada.
- Pagamento: Apenas PIX ou Cartão Online (Não aceitamos dinheiro na entrega).

### 🤖 FECHAMENTO
Gere JSON apenas com dados completos:
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
            await enviarMensagem(numero,Pelo seu print **1002744312.png**, vi que a IA acabou se confundindo e listando sabores que não temos (como Mamão e Manga) na última mensagem. Isso acontece porque o `SYSTEM_PROMPT` no seu código ainda não foi atualizado com as regras de negócio reais que você me passou.

Para resolver isso e deixar ela com o atendimento sutil e "expert" em vendas que planejamos, vamos usar o código final abaixo. Ele já inclui a leitura do seu site **thdindingourmet.com/loja** para ela nunca mais inventar sabores.

### 🛠️ Código Final para o seu `index.js`:

Substitua **todo** o conteúdo do arquivo no GitHub por este bloco:
```javascript
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 CONFIGURAÇÕES (Railway cuidará das variáveis)
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;
const CATALOGO_URL = "[https://thdindingourmet.com/loja](https://thdindingourmet.com/loja)"; 
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

// 🔍 SINCRONIZAÇÃO COM A LOJA (BASE44)
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
            if (html.includes(sabor)) { disponiveis.push(sabor.charAt(0).toUpperCase() + sabor.slice(1)); }
        });
        estoqueCache = { texto: disponiveis.length > 0 ? disponiveis.join(", ") : "Sabores variados", lastUpdate: agora };
        return estoqueCache.texto;
    } catch (error) { return "Nutella, Oreo, Paçoca, Mousse de Limão, Ovomaltine"; }
}

// 📩 FUNÇÕES DE APOIO (WhatsApp e Asaas)
async function enviarMensagem(numero, mensagem) {
    try {
        await axios.post(`[https://api.z-api.io/instances/$](https://api.z-api.io/instances/$){INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
        { phone: numero, message: mensagem }, { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } });
    } catch (e) { console.error("Erro Zap:", e.message); }
}

async function obterOuCriarCliente(nome, telefone, cpfUsuario) {
    const response = await axios.post("[https://api.asaas.com/v3/customers](https://api.asaas.com/v3/customers)", 
    { name: nome, phone: telefone, cpfCnpj: cpfUsuario }, { headers: { access_token: ASAAS_API_KEY } });
    clientes[telefone] = response.data.id;
    await salvarClientes();
    return response.data.id;
}

// 🚀 WEBHOOK COM CONSULTORIA DE VENDAS
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);
        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const cardapioReal = await sincronizarEstoque();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [{ role: "system", content: `Você é a Consultora Especialista da TH DinDin Gourmet. 
Seu atendimento é leve, moderno e usa persuasão sutil (sem pressionar).

### 🧊 ESTOQUE REAL (Sincronizado):
Sabores disponíveis: ${cardapioReal}. 
NUNCA invente sabores como Manga ou Mamão. Se não estiver na lista acima, diga que esgotou.

### 🌟 REGRAS DE NEGÓCIO
- Vendedores: TH (Boa Vista), Sergio (Derby), Tony (Ilha do Leite), Natanael (Portugues).
- Sutileza: "Muitos clientes garantem 5 unidades para ter entrega grátis e estoque no freezer".
- Revenda: Lucro alto! Acima de 70 unid o preço cai para R$ 3,90/cada.
- Pagamento: Apenas PIX ou Cartão Online (Não aceitamos dinheiro na entrega).

### 🤖 FECHAMENTO
Gere JSON apenas com dados completos:
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
            const cobranca = await axios.post("[https://api.asaas.com/v3/payments](https://api.asaas.com/v3/payments)", { customer: clienteId, billingType: "PIX", value: valorTotal, dueDate: new Date().toISOString().split("T")[0] }, { headers: { access_token: ASAAS_API_KEY } });
            const qr = await axios.get(`[https://api.asaas.com/v3/payments/$](https://api.asaas.com/v3/payments/$){cobranca.data.id}/pixQrCode`, { headers: { access_token: ASAAS_API_KEY } });
            pedidos.push({ id: `WA-${Date.now()}`, telefone: numero, valor: valorTotal, status: "aguardando_pagamento", paymentId: cobranca.data.id });
            await salvarPedidos();
            await enviarMensagem(numero, `🚀 Tudo pronto! Aqui está seu PIX:\n\n${qr.data.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}`);
            delete conversoesAtivas[numero];
        } else { await enviarMensagem(numero, textoIA); }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

app.get('/', (req, res) => res.send("API TH DinDin V4.1 - Inteligência de Vendas Ativa! 🍦🚀"));
app.listen(process.env.PORT || 3000);
