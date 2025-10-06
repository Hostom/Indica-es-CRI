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
    ssl: {
        rejectUnauthorized: false
    }
});

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());

// --- MIDDLEWARE DE SEGURANÇA PARA AS ROTAS DO DASHBOARD ---
const protectRoute = (req, res, next) => {
    const authHeader = req.header('Authorization');
    const expectedPassword = process.env.DASHBOARD_PASSWORD;

    if (!authHeader || !authHeader.startsWith('Bearer ') || !expectedPassword) {
        return res.status(401).json({ error: 'Acesso não autorizado' });
    }

    const providedPassword = authHeader.substring(7); // Remove "Bearer "
    if (providedPassword !== expectedPassword) {
        return res.status(401).json({ error: 'Senha incorreta' });
    }

    next(); // Se a senha estiver correta, continua para a rota
};


// --- ROTAS PÚBLICAS ---

// Rota para o formulário de indicação
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota que recebe os dados do formulário de indicação (O CORAÇÃO DO SISTEMA)
app.post("/api/indicacoes", async (req, res) => {
    
    const dadosIndicacao = req.body;
    const { natureza, cidade, nome_cliente, tel_cliente, nome_corretor, unidade_corretor, descricao_situacao } = dadosIndicacao;

    try {
        // --- ETAPA 1: SORTEAR O CONSULTOR NO BANCO DE DADOS ---
        const roletaQuery = `
            SELECT id, email, nome 
            FROM Consultores 
            WHERE natureza = $1 AND cidade = $2 AND ativo_na_roleta = TRUE
            ORDER BY data_ultima_indicacao ASC
            LIMIT 1;
        `;
        const consultorResult = await pool.query(roletaQuery, [natureza, cidade]);
        
        const consultorSorteado = consultorResult.rows[0];

        if (!consultorSorteado) {
            console.error("ROTA /api/indicacoes: Nenhum consultor encontrado para a fila.", { natureza, cidade });
            return res.status(503).json({ success: false, message: "Falha: Nenhum consultor ativo para esta fila." });
        }

        // --- ETAPA 2: ATUALIZAR A DATA DO CONSULTOR SORTEADO ---
        const updateQuery = `
            UPDATE Consultores 
            SET data_ultima_indicacao = NOW() 
            WHERE id = $1;
        `;
        await pool.query(updateQuery, [consultorSorteado.id]); 

        // --- ETAPA 2.5: GRAVAR A INDICAÇÃO NA TABELA DE HISTÓRICO ---
        const insertIndicacaoQuery = `
            INSERT INTO Indicacoes (consultor_id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `;
        await pool.query(insertIndicacaoQuery, [
            consultorSorteado.id,
            nome_corretor,
            unidade_corretor,
            natureza,
            cidade,
            nome_cliente,
            tel_cliente,
            descricao_situacao
        ]);
        console.log(`Indicação para o cliente ${nome_cliente} foi gravada com sucesso na tabela de histórico.`);

        // --- ETAPA 3: ENVIAR A NOTIFICAÇÃO POR E-MAIL (VIA RESEND API) ---
        const resendApiKey = process.env.RESEND_API_KEY;
        const emailFrom = process.env.EMAIL_FROM;
        const emailGerenteCC = process.env.EMAIL_GERENTE_CC;

        const emailCorpoHtml = `
            <p>Nova Indicação Recebida!</p>
            <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
            <hr>
            <p><b>Dados do Corretor:</b></p>
            <ul>
                <li><b>Nome:</b> ${nome_corretor || 'Não Informado'}</li>
                <li><b>Unidade:</b> ${unidade_corretor || 'Não Informada'}</li>
            </ul>
            <p><b>Dados da Indicação:</b></p>
            <ul>
                <li><b>Natureza:</b> ${natureza}</li>
                <li><b>Cidade:</b> ${cidade}</li>
            </ul>
            <p><b>Dados do Cliente:</b></p>
            <ul>
                <li><b>Nome:</b> ${nome_cliente}</li>
                <li><b>Telefone:</b> ${tel_cliente || 'N/A'}</li>
                <li><b>Descrição:</b> ${descricao_situacao}</li>
            </ul>
        `;
        
        if (resendApiKey && emailFrom) {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${resendApiKey}`
                },
                body: JSON.stringify({
                    from: emailFrom,
                    to: consultorSorteado.email,
                    cc: emailGerenteCC,
                    subject: `[INDICAÇÃO] ${natureza} - Cliente: ${nome_cliente}`,
                    html: emailCorpoHtml
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error("Falha ao enviar e-mail pelo Resend:", errorData);
            } else {
                console.log(`E-mail de Atribuição enviado com sucesso para ${consultorSorteado.nome} via Resend.`);
            }
        } else {
            console.warn("Aviso: RESEND_API_KEY ou EMAIL_FROM não configurados. E-mail não enviado.");
        }

        // --- ETAPA 4: ENVIAR A RESPOSTA DE SUCESSO PARA O SITE ---
        return res.status(201).json({ 
            success: true,
            message: "Indicação atribuída e gravada com sucesso!",
            consultor_sorteado: consultorSorteado.nome,
        });

    } catch (error) {
        console.error("ERRO IRRECUPERÁVEL NA ROTA /API/INDICACOES:", error);
        return res.status(500).json({ success: false, message: "Erro interno no servidor." });
    }
});


// --- ROTAS PROTEGIDAS DO DASHBOARD ---

// Rota para servir a página do dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Rota para fornecer os dados para o dashboard
app.get('/api/dashboard-data', protectRoute, async (req, res) => {
    try {
        const indicacoesQuery = `
            SELECT i.*, c.nome as consultor_nome 
            FROM Indicacoes i
            LEFT JOIN Consultores c ON i.consultor_id = c.id
            ORDER BY i.data_indicacao DESC;
        `;
        const indicacoesResult = await pool.query(indicacoesQuery);
        const consultoresResult = await pool.query('SELECT * FROM consultores ORDER BY nome ASC');

        res.json({
            indicacoes: indicacoesResult.rows,
            consultores: consultoresResult.rows
        });
    } catch (error) {
        console.error("Erro ao buscar dados para o dashboard:", error);
        res.status(500).json({ error: 'Erro interno ao buscar dados.' });
    }
});

// Rota para atualizar o status de uma indicação
app.put('/api/indicacoes/:id', protectRoute, async (req, res) => {
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

// Rota para atualizar o status de um consultor na roleta
app.put('/api/consultores/:id', protectRoute, async (req, res) => {
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
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

