const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// --- LÓGICA DE SEGURANÇA DO DASHBOARD ---
const protectAndIdentify = (req, res, next) => {
    const authHeader = req.header('Authorization');
    const passDiretor = process.env.DASHBOARD_PASS_DIRETOR;
    const passBcItajai = process.env.DASHBOARD_PASS_BC_ITAJAI;
    const passItapema = process.env.DASHBOARD_PASS_ITAPEMA;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acesso não autorizado' });
    }
    const providedPassword = authHeader.substring(7);

    if (passDiretor && providedPassword === passDiretor) {
        req.userRole = { type: 'DIRETOR', cities: [] };
    } else if (passBcItajai && providedPassword === passBcItajai) {
        req.userRole = { type: 'GERENTE', cities: ['Balneario Camboriu', 'Itajai'] };
    } else if (passItapema && providedPassword === passItapema) {
        req.userRole = { type: 'GERENTE', cities: ['Itapema'] };
    } else {
        return res.status(401).json({ error: 'Senha incorreta' });
    }
    next();
};


// --- ROTAS PÚBLICAS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ROTA PRINCIPAL DA ROLETA
app.post("/api/indicacoes", async (req, res) => {
    const dadosIndicacao = req.body;
    const { natureza, cidade, nome_cliente, tel_cliente, nome_corretor, unidade_corretor, descricao_situacao } = dadosIndicacao;

    try {
        // ETAPAS 1, 2 e 3: Lógica do Banco de Dados (sem alteração)
        const roletaQuery = `SELECT id, email, nome FROM Consultores WHERE natureza = $1 AND cidade = $2 AND ativo_na_roleta = TRUE ORDER BY data_ultima_indicacao ASC LIMIT 1;`;
        const consultorResult = await pool.query(roletaQuery, [natureza, cidade]);
        const consultorSorteado = consultorResult.rows[0];

        if (!consultorSorteado) {
            return res.status(503).json({ success: false, message: "Falha: Nenhum consultor ativo para esta fila." });
        }

        await pool.query('UPDATE Consultores SET data_ultima_indicacao = NOW() WHERE id = $1;', [consultorSorteado.id]);
        
        const insertIndicacaoQuery = `INSERT INTO Indicacoes (consultor_id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`;
        await pool.query(insertIndicacaoQuery, [consultorSorteado.id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao]);

        // --- ETAPA 4: NOVA LÓGICA DE ENVIO DE E-MAIL (MAILGUN API) ---
        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        const emailFrom = process.env.EMAIL_FROM; // Ex: noreply@seu-sandbox.mailgun.org
        const emailGerenteCC = process.env.EMAIL_GERENTE_CC;

        if (mailgunApiKey && mailgunDomain && emailFrom) {
            const emailCorpoHtml = `
                <p>Nova Indicação Recebida!</p>
                <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
                <hr>
                <p><b>Dados do Corretor:</b> ${nome_corretor || 'N/A'} (${unidade_corretor || 'N/A'})</p>
                <p><b>Dados do Cliente:</b> ${nome_cliente} - ${tel_cliente || 'N/A'}</p>
                <p><b>Descrição:</b> ${descricao_situacao}</p>
            `;

            const mailgunUrl = `https://api.mailgun.net/v3/${mailgunDomain}/messages`;
            
            const form = new URLSearchParams();
            form.append('from', emailFrom);
            form.append('to', consultorSorteado.email);
            if (emailGerenteCC) form.append('cc', emailGerenteCC);
            form.append('subject', `[INDICAÇÃO] ${natureza} - Cliente: ${nome_cliente}`);
            form.append('html', emailCorpoHtml);

            const response = await fetch(mailgunUrl, {
                method: 'POST',
                headers: {
                    // Autenticação para a API do Mailgun
                    'Authorization': 'Basic ' + Buffer.from(`api:${mailgunApiKey}`).toString('base64'),
                },
                body: form
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error("Falha ao enviar e-mail pelo Mailgun:", errorData);
            } else {
                console.log(`E-mail enviado com sucesso para ${consultorSorteado.nome} via Mailgun.`);
            }
        }
        
        return res.status(201).json({ success: true, message: "Indicação atribuída com sucesso!", consultor_sorteado: consultorSorteado.nome });

    } catch (error) {
        console.error("ERRO IRRECUPERÁVEL NA ROTA /API/INDICACOES:", error);
        return res.status(500).json({ success: false, message: "Erro interno no servidor." });
    }
});


// --- ROTAS DO DASHBOARD ---
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/api/dashboard-data', protectAndIdentify, async (req, res) => {
    try {
        let indicacoesQuery = `SELECT i.*, c.nome as consultor_nome FROM Indicacoes i LEFT JOIN Consultores c ON i.consultor_id = c.id`;
        const queryParams = [];

        if (req.userRole.type === 'GERENTE') {
            indicacoesQuery += ' WHERE i.cidade = ANY($1)';
            queryParams.push(req.userRole.cities);
        }
        indicacoesQuery += ' ORDER BY i.data_indicacao DESC;';

        const indicacoesResult = await pool.query(indicacoesQuery, queryParams);
        const consultoresResult = await pool.query('SELECT * FROM consultores ORDER BY nome ASC');
        res.json({ indicacoes: indicacoesResult.rows, consultores: consultoresResult.rows });
    } catch (error) {
        console.error("Erro ao buscar dados para o dashboard:", error);
        res.status(500).json({ error: 'Erro interno ao buscar dados.' });
    }
});

app.put('/api/indicacoes/:id', protectAndIdentify, async (req, res) => {
    try {
        const { id } = req.params;
        const { status_interno } = req.body;
        await pool.query('UPDATE Indicacoes SET status_interno = $1 WHERE id = $2', [status_interno, id]);
        res.status(200).json({ success: true, message: 'Status da indicação atualizado.' });
    } catch (error) {
        console.error("Erro ao atualizar indicação:", error);
        res.status(500).json({ error: 'Erro interno ao atualizar indicação.' });
    }
});

app.put('/api/consultores/:id', protectAndIdentify, async (req, res) => {
    try {
        const { id } = req.params;
        const { ativo_na_roleta } = req.body;
        await pool.query('UPDATE Consultores SET ativo_na_roleta = $1 WHERE id = $2', [ativo_na_roleta, id]);
        res.status(200).json({ success: true, message: 'Status do consultor atualizado.' });
    } catch (error) {
        console.error("Erro ao atualizar consultor:", error);
        res.status(500).json({ error: 'Erro interno ao atualizar consultor.' });
    }
});


// --- INICIAR O SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

