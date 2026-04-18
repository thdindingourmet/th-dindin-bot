const express = require('express');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Servidor rodando 🚀');
});

app.post('/webhook', (req, res) => {
    const data = req.body;
    console.log("Mensagem recebida:", data);
    res.sendStatus(200);
});

app.post('/status', (req, res) => {
    console.log("Status:", req.body);
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Servidor rodando...');
});
