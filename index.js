const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 CONFIGURAÇÕES (Z-API e Asaas mantidos)
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const CATALOGO_URL = "https://thdindingourmet.com/loja"; 

// 📂 BANCO DE DADOS LOCAL
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';
let estoqueCache = { texto: "", lastUpdate: 0 };
let pedidos = [];
let clientes = {};

if (fs.existsSync(PEDIDOS_FILE)) { pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE)); }
if (fs.existsSync(CLIENTES_FILE)) { clientes = JSON.parse(fs.readFileSync(CLIENTES_FILE)); }

async function salvarPedidos() { await fsPromises.writeFile(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2)); }
async function salvarClientes() { await fsPromises.writeFile(CLIENTES_FILE, JSON.stringify(clientes, null, 2)); }

// 🔍 SINCRONIZAÇÃO DO ESTOQUE (Para uso em logs ou consultas manuais)
async function sincronizarEstoque() {
    const agora = Date.now();
    if (estoqueCache.texto && (agora - estoqueCache.lastUpdate < 300000)) return estoqueCache.texto;

    try {
        const response = await axios.get(CATALOGO_URL, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
            },
            timeout: 10000
        });

        const htmlLimpo = response.data.toLowerCase().replace(/<[^>]*>?/gm, ' ');
        const listaMestre = ["nutella", "ovomaltine", "limão", "paçoca", "oreo", "ninho", "ameixa", "pavê", "morango", "chocolate", "maracujá", "abacaxi"];
        
        let disponiveis = [];
        listaMestre.forEach(sabor => {
            if (htmlLimpo.includes(sabor)) {
                disponiveis.push(sabor.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
            }
        });
        
        const resultadoFinal = disponiveis.length > 0 ? disponiveis.join(", ") : "Consulte o cardápio no site.";
        estoqueCache = { texto: resultadoFinal, lastUpdate: agora };
        return resultadoFinal;
    } catch (error) {
        return "Erro ao carregar sabores.";
    }
}

// 📩 FUNÇÕES DE COMUNICAÇÃO (Z-API)
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

// 🚀 WEBHOOK (Apenas processamento de dados, sem resposta automática da IA)
app.post('/webhook', async (req, res) => {
    try {
        // Agora o servidor apenas recebe os dados. 
        // Como você usará a Meta IA, este código não deve enviar mensagens automáticas de chat.
        // Ele servirá apenas se você quiser integrar botões ou comandos específicos no futuro.
        res.sendStatus(200);
    } catch (e) { 
        res.sendStatus(200); 
    }
});

app.get('/', (req, res) => res.send("🚀 TH DinDin V5.0 - Servidor de Pagamentos Ativo (Sem ChatGPT)!"));
app.listen(process.env.PORT || 3000, '0.0.0.0');
