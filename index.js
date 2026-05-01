const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const cors = require('cors');
const { OpenAI } = require('openai'); // 👈 IA adicionada aqui

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 CONFIGURAÇÕES
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const INSTANCE = process.env.INSTANCE;
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // 👈 Motor da IA

// 📂 FICHEIROS DE DADOS
const PEDIDOS_FILE = 'pedidos.json';
const CLIENTES_FILE = 'clientes.json';

let pedidos = [];
let clientes = {};
const conversoesAtivas = {}; // Memória para a IA lembrar de quem está conversando

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

// 📩 ENVIO WHATSAPP (Z-API) (INTACTO)
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

// 👤 GESTÃO DE CLIENTES ASAAS (INTACTO)
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

// 💳 GERAÇÃO DE PIX ASAAS (INTACTO)
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

// 🌐 ROTA DO SITE (INTACTA - FUNCIONA PERFEITAMENTE COMO ANTES)
app.post('/api/checkout-site', async (req, res) => {
    try {
        const { nome, telefone, cpf, valorTotal, pedidoId, endereco } = req.body;
        console.log(`🛒 Novo pedido recebido do site: ${pedidoId}`);

        if (!cpf || cpf.length < 11) {
            return res.status(400).json({ sucesso: false, erro: "CPF é obrigatório para gerar o PIX." });
        }

        const clienteId = await obterOuCriarCliente(nome, telefone, cpf.replace(/\D/g, ''));
        const pagamento = await gerarPix(valorTotal, clienteId);

        const novoPedido = {
            id: pedidoId,
            telefone: telefone.replace(/\D/g, ''),
            valor: valorTotal,
            status: "aguardando_pagamento",
            paymentId: pagamento.id,
            origem: "site",
            createdAt: new Date()
        };
        pedidos.push(novoPedido);
        await salvarPedidos();

        await enviarMensagem(novoPedido.telefone, `🍦 Olá ${nome}! Recebemos o seu pedido no site.\n\nCaso o PIX não tenha aparecido na tela, use este código abaixo:\n\n${pagamento.payload}`);

        res.json({ sucesso: true, pixCopiaECola: pagamento.payload, pedidoId: pedidoId });
    } catch (error) {
        console.error("🚨 ERRO DETALHADO DO ASAAS (SITE):", error.response?.data || error.message);
        res.status(500).json({ sucesso: false, erro: "Erro ao processar pagamento." });
    }
});

// 🔍 CONSULTA DE STATUS DO SITE (INTACTA)
app.get('/api/status-pedido/:pedidoId', (req, res) => {
    const pedidoId = req.params.pedidoId;
    const pedido = pedidos.find(p => p.id === pedidoId);
    if (pedido) {
        res.json({ sucesso: true, status: pedido.status });
    } else {
        res.status(404).json({ sucesso: false, erro: "Pedido não encontrado" });
    }
});

// 🚀 WEBHOOK WHATSAPP (AQUI ENTRA A INTELIGÊNCIA ARTIFICIAL)
app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data?.fromMe) return res.sendStatus(200);

        const mensagem = data?.text?.message || data?.message || data?.body;
        const numero = data?.phone || data?.from;

        if (!mensagem || !numero) return res.sendStatus(200);

        // Se já gerou o PIX, o robô para de falar e aguarda o pagamento
        const pedidoAguardando = pedidos.find(p => p.telefone === numero && p.status === "aguardando_pagamento");
        if (pedidoAguardando) {
            await enviarMensagem(numero, "⏳ Você já tem um pedido aguardando pagamento! Por favor, realize o PIX com o código enviado acima. Se precisar de algo, só chamar!");
            return res.sendStatus(200);
        }

        // Se é a primeira mensagem, injeta o Prompt Mestre na memória
        if (!conversoesAtivas[numero]) {
            conversoesAtivas[numero] = [
                { role: "system", content: `Você é o assistente virtual da TH DinDin Gourmet, a melhor marca de geladinhos cremosos. 
Sua linguagem deve ser energética, moderna e voltada para jovens influenciadores. Use emojis.
Sabores: Mousse de Limão (R$ 7.99), Nutella (R$ 7.99), Ovomaltine (R$ 7.99), Paçoca (R$ 7.99), Oreo (R$ 7.99).
Fluxo:
1. Cumprimente e anote os sabores.
2. Peça o Nome e o Endereço de entrega (Rua, Número, Bairro).
3. Por fim, peça o CPF (diga que é regra do sistema para gerar o PIX).
Ação Final: Apenas quando tiver TODOS os dados (Sabores, Nome, Endereço e CPF com 11 dígitos), gere APENAS um código JSON exato neste formato:
{"nome": "[Nome]", "cpf": "[CPF sem pontos]", "endereco": "[Endereço completo]", "itens": [{"nome": "Nutella", "preco": 7.99, "quantidade": 1}]}` }
            ];
        }

        // Salva o que o cliente disse
        conversoesAtivas[numero].push({ role: "user", content: mensagem });

        // Envia para o ChatGPT processar
        const respostaIA = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: conversoesAtivas[numero],
            temperature: 0.7
        });

        const textoIA = respostaIA.choices[0].message.content;
        conversoesAtivas[numero].push({ role: "assistant", content: textoIA });

        // Verifica se a IA cuspiu o JSON de fechamento de pedido
        if (textoIA.includes('"cpf"') && textoIA.includes('"itens"')) {
            try {
                // Extrai apenas o bloco JSON caso a IA tenha colocado algum texto em volta
                const inicioJson = textoIA.indexOf('{');
                const fimJson = textoIA.lastIndexOf('}') + 1;
                const jsonPedido = JSON.parse(textoIA.substring(inicioJson, fimJson));

                await enviarMensagem(numero, "🚀 Show! Tudo anotado, estou gerando a sua chave PIX...");

                // Calcula o total do carrinho
                const valorTotal = jsonPedido.itens.reduce((acc, item) => acc + (item.preco * item.quantidade), 0);
                const cpfLimpo = jsonPedido.cpf.replace(/\D/g, '');

                // Reaproveita a exata mesma lógica do seu site para o Asaas
                const clienteId = await obterOuCriarCliente(jsonPedido.nome, numero, cpfLimpo);
                const pagamento = await gerarPix(valorTotal, clienteId);

                const novoPedido = {
                    id: `WA-${Date.now()}`,
                    telefone: numero,
                    valor: valorTotal,
                    status: "aguardando_pagamento",
                    paymentId: pagamento.id,
                    origem: "whatsapp",
                    createdAt: new Date(),
                    itens: jsonPedido.itens,
                    endereco: jsonPedido.endereco
                };
                pedidos.push(novoPedido);
                await salvarPedidos();

                await enviarMensagem(numero, `💳 *PIX Copia e Cola:*\n\n${pagamento.payload}\n\n✅ Total: R$ ${valorTotal.toFixed(2).replace('.',',')}\nO seu pedido será confirmado automaticamente aqui no chat assim que o pagamento cair!`);
                
                // Limpa a memória para o cliente poder pedir novamente no futuro
                delete conversoesAtivas[numero];

            } catch (err) {
                console.error("Erro ao processar Venda via IA:", err);
                await enviarMensagem(numero, "❌ Opa, houve uma falha técnica ao gerar seu PIX. Pode confirmar seus dados novamente?");
            }
        } else {
            // Se não for JSON, o robô está apenas conversando, então mandamos a mensagem normal
            await enviarMensagem(numero, textoIA);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Erro no Webhook:", error);
        res.sendStatus(200);
    }
});

// 🚚 ATUALIZAR STATUS DE ENTREGA (INTACTO)
app.post('/api/atualizar-status', async (req, res) => {
    try {
        const { pedidoId, novoStatus, linkRastreio } = req.body;
        const pedido = pedidos.find(p => p.id === pedidoId);

        if (!pedido) return res.status(404).json({ sucesso: false, erro: "Pedido não encontrado" });
        if (pedido.status === novoStatus) return res.json({ sucesso: true, mensagem: "Status já atualizado." });

        pedido.status = novoStatus;
        await salvarPedidos();

        if (novoStatus === "saiu_entrega") {
            const linkValido = linkRastreio.startsWith('http') ? linkRastreio : `https://${linkRastreio}`;
            const msg = `🛵 *Boa notícia!* O seu dindin saiu para entrega.\n\n📍 Acompanhe em tempo real:\n${linkValido}`;
            await enviarMensagem(pedido.telefone, msg);
        }

        res.json({ sucesso: true });
    } catch (error) {
        res.status(500).json({ sucesso: false });
    }
});

// 💰 WEBHOOK ASAAS (INTACTO - FUNCIONA PARA O SITE E PARA A IA)
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
                await enviarMensagem(pedido.telefone, "✅ *Pagamento Confirmado!*\n\nO seu pedido foi pago com sucesso e já está sendo preparado pela nossa equipe! 🍦🚀");
            }
        }
        res.sendStatus(200);
    } catch (error) {
        res.sendStatus(500);
    }
});

app.get('/', (req, res) => res.send("API TH DinDin Ativa com IA! 🚀🤖"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
