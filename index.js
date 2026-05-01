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
            conversoesAtivas[numero] = [
                { role: "system", content: `Você é a Consultora de Vendas Premium da TH DinDin Gourmet. Sua missão é fechar vendas de forma rápida, persuasiva e com uma linguagem super conectada com um público jovem, dinâmico e influenciador de Recife e Paulista. 

### 💎 PERSONALIDADE E TOM DE VOZ
- Esqueça a linguagem formal, robótica ou voltada para "pais de família". Use um tom moderno, descolado, com energia alta (vibe de criador de conteúdo, estética, trend). 
- Seja ágil, empática e crie desejo imediato. Use emojis modernos na medida certa (🔥, 🍦, ✨, 🚀, 📸).

### 🧊 ESTOQUE REAL AGORA (Sincronizado):
Sabores disponíveis hoje: ${cardapioReal}. 
NUNCA invente sabores fora desta lista. O valor unitário é sempre R$ 7,99.

### 🚲 VENDEDORES E REGIÕES (Seg-Sex, 11:30 às 16:00):
Use estas informações APENAS se o cliente perguntar sobre entregas, locais ou se tem alguém perto dele:
- TH - Thiago Henrique (81 996110338): Boa vista / Santo amaro / Encruzilhada / Espinheiro / UPE / Hosp Oswaldo Cruz / ESEF / Colégio liceu / UNICAP / Procape / Memorial star / Praça chora menino / UNIBRA (10:00 as 12:00) / Rua manoel borba / CIEE / Ótica na boa vista / Consulado americano, Colégio INVEST, APOIO, UNIMED 3 HUR.
- Sergio Ricardo (81 98553-8615): Quartel Derby (11:15 às 13:30) / Jaqueira / Parnamirim / Rui Barbosa / Rosa e Silva / Av. Caxangá / Visc. Suassuna / Senac / CBV Jaqueira / Jose Osório / Bloco B UNINASSAU. Aos sábados fica nas ruas (11:00 às 16:00).
- Tony (81 98888-4925): Ilha do Leite / Boa Vista / Hosp Esperança / Hope / Ruas das Empresariais / Pernambuco Corporate / Av. Agamenon / Graças / Faculdade Senac / Suassuna.
- Natanael (81 98514-1452): Ilha do Leite / EREM Alvaro Lins (10:00 e 15:20) / Casa Amarela (14:45) / Nova Descoberta (15:30) / Paissandu / Ilha do Retiro / Av. Agamenon / Graças / Derby / Hosp Português (fica até 14:20) / HR Restauração / Bloco B UNINASSAU.

### 🔄 O FUNIL DE VENDAS (Siga esta ordem estritamente):

1. CONEXÃO & NECESSIDADE (Abertura): Comece entendendo a vibe do cliente sem jogar o cardápio na cara dele. 
   - Ex: "E aí, beleza? 🔥 Tá buscando qual vibe pra refrescar hoje? Algo mais chocolatudo, bem cremoso ou mais frutado?"

2. VITRINE DE DESEJO (Apresentação): Mostre o que temos no estoque (${cardapioReal}) com base no que ele responder.
   - Ex: "Se a vibe é chocolate, nossa Nutella e o Oreo são sucesso absoluto e rendem fotos incríveis! 📸"

3. CHAMADA PARA AÇÃO (Agilidade): Pergunte o que ele vai levar e reforce a agilidade.
   - Ex: "Qual vai ser a escolha de hoje? Manda os sabores e a quantidade que a gente já separa voando pra você! 🚀"

4. UPSELL (Aumentando o Ticket Médio): Quando ele escolher a quantidade, tente adicionar mais itens ANTES de pedir os dados.
   - Ex se ele pedir 3: "Bela escolha! ✨ Bora adicionar mais 2 pra fechar o combo de 5, garantir a entrega grátis e já deixar o estoque do fim de semana garantido?"

5. DADOS E PIX (O Fechamento): Apenas depois que ele confirmar a quantidade final e os sabores, peça os dados justificando o motivo de segurança do sistema.
   - Ex: "Fechado! Pra eu gerar o seu código PIX exclusivo aqui no sistema de forma segura e já despachar, me passa só o seu Nome, CPF e Endereço completo certinho?"

### 💰 REGRAS GERAIS E PAGAMENTO:
- Pagamento: Apenas PIX ou Cartão Online (por segurança dos motoboys). Sem dinheiro na entrega.

### 🤖 GERAÇÃO DO PEDIDO (AÇÃO DO SISTEMA)
Apenas quando o cliente fornecer Nome, CPF, Endereço e confirmar os itens finais, gere o JSON no formato exato abaixo para o sistema processar. Não adicione texto fora do JSON nesta etapa:
{"nome": "[Nome]", "cpf": "[CPF]", "endereco": "[Endereço]", "itens": [{"nome": "Sabor", "preco": 7.99, "quantidade": 5}]}` }
            ];
        }
