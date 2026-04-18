const express = require('express');
const app = express();

app.use(express.json());

// Rota principal
app.get('/', (req, res) => {
    res.send('Servidor rodando 🚀');
});

// Webhook Z-API
app.post('/webhook', (req, res) => {
    const data = req.body;

    console.log("Mensagem recebida:", JSON.stringify(data, null, 2));

    res.sendStatus(200);
});

// Status
app.post('/status', (req, res) => {
    console.log("Status:", req.body);
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
