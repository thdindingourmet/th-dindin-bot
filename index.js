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
    if (estoqueCache.texto !== "Carregando sabores..." && (agora - estoqueCache.lastUpdate < 300000)) return estoqueCache.texto;
    try {
        const response = await axios.get(CATALOGO_URL);
        const html = response.data.toLowerCase();
        const listaSabores = ["nutella", "ovomaltine", "limão", "paçoca", "oreo", "ninho", "ameixa"];
        let disponiveis = [];
        listaSabores.forEach(sabor => { if (html.includes(sabor)) disponiveis.push(sabor.charAt(0).toUpperCase() + sabor.slice(1)); });
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

// 🚀 WEBHOOK PRINCIPAL (IA MATADORA + ASSAS)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        const isGroup = (data?.phone?.includes('@g.us')) || (data?.from?.includes('@g.us'));
        if (data?.fromMe || isGroup) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;
        if (!mensagem || !numero) return res.sendStatus(200);

        const cardapioReal = await sincronizarEstoque();

        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [{ role: "system", content: `Você é a Consultora Premium da TH DinDin Gourmet. Foco: fechar vendas rápido com público jovem e influenciador de Recife/Paulista.

### 💎 PERSONALIDADE
- Use tom moderno, descolado e com energia (vibe trend/aesthetic). Use emojis (🔥, 🍦, ✨, 🚀).
- NUNCA seja formal ou burocrática no início.

### 🚲 VENDEDORES E REGIÕES (Seg-Sex, 11:30 às 16:00):
Use estas informações APENAS se o cliente perguntar sobre entregas, locais ou se tem alguém perto dele:
- TH - Thiago Henrique (81 996110338): Boa vista / Santo amaro / Encruzilhada / Espinheiro / UPE / Hosp Oswaldo Cruz / ESEF / Colégio liceu / UNICAP / Procape / Memorial star / Praça chora menino / UNIBRA (10:00 as 12:00) / Rua manoel borba / CIEE / Ótica na boa vista / Consulado americano, Colégio INVEST, APOIO, UNIMED 3 HUR.
- Sergio Ricardo (81 98553-8615): Quartel Derby (11:15 às 13:30) / Jaqueira / Parnamirim / Rui Barbosa / Rosa e Silva / Av. Caxangá / Visc. Suassuna / Senac / CBV Jaqueira / Jose Osório / Bloco B UNINASSAU. Aos sábados fica nas ruas (11:00 às 16:00).
- Tony (81 98888-4925): Ilha do Leite / Boa Vista / Hosp Esperança / Hope / Ruas das Empresariais / Pernambuco Corporate / Av. Agamenon / Graças / Faculdade Senac / Suassuna.
- Natanael (81 98514-1452): Ilha do Leite / EREM Alvaro Lins (10:00 e 15:20) / Casa Amarela (14:45) / Nova Descoberta (15:30) / Paissandu / Ilha do Retiro / Av. Agamenon / Graças / Derby / Hosp Português (fica até 14:20) / HR Restauração / Bloco B UNINASSAU.

### 🔄 FUNIL MATADOR:
1. CONEXÃO: Entenda a vibe (doce ou frutado?).
2. VITRINE: Mostre os sabores reais (${cardapioReal}).
3. AÇÃO: "Manda os sabores que já separo voando!".
4. UPSELL: Se pedir menos de 5, sugira fechar o combo pra ganhar frete grátis.
5. FECHAMENTO: Só peça Nome, CPF e Endereço APÓS confirmar os itens.

### 🤖 SISTEMA:
Ao fechar, gere APENAS o JSON:
{"nome": "...", "cpf": "...", "endereco": "...", "itens": [{"nome": "Sabor", "preco": 7.99, "quantidade": 5}]}` }];
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
            await enviarMensagem(numero, `🚀 Pedido fechado! Aqui está seu PIX:\n\n${qr.data.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}`);
            delete conversoesAtivas[numero];
        } else {
            await enviarMensagem(numero, textoIA);
        }
        res.sendStatus(200);
    } catch (e) { res.sendStatus(200); }
});

app.get('/', (req, res) => res.send("🚀 TH DinDin V4.5 - Online!"));
app.listen(process.env.PORT || 3000);
