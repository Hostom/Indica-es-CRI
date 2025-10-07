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
app.use(express.static(__dirname)); // Permite servir arquivos estáticos como a Logo.png

// --- NOVO MIDDLEWARE DE SEGURANÇA COM NÍVEIS DE ACESSO ---
const protectAndIdentify = (req, res, next) => {
    const authHeader = req.header('Authorization');
    
    // Senhas lidas do ambiente
    const passDiretor = process.env.DASHBOARD_PASS_DIRETOR;
    const passBcItajai = process.env.DASHBOARD_PASS_BC_ITAJAI;
    const passItapema = process.env.DASHBOARD_PASS_ITAPEMA;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acesso não autorizado' });
    }

    const providedPassword = authHeader.substring(7); // Remove "Bearer "

    // Determina o papel do usuário com base na senha fornecida
    if (passDiretor && providedPassword === passDiretor) {
        req.userRole = { type: 'DIRETOR', cities: [] }; // Vazio significa todas as cidades
    } else if (passBcItajai && providedPassword === passBcItajai) {
        req.userRole = { type: 'GERENTE', cities: ['Balneario Camboriu', 'Itajai'] };
    } else if (passItapema && providedPassword === passItapema) {
        req.userRole = { type: 'GERENTE', cities: ['Itapema'] };
    } else {
        return res.status(401).json({ error: 'Senha incorreta' });
    }

    next(); // Se a senha for válida, continua para a rota
};


// --- ROTAS PÚBLICAS ---

// Rota para o formulário de indicação
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota que recebe os dados do formulário de indicação
app.post("/api/indicacoes", async (req, res) => {
    const dadosIndicacao = req.body;
    const { natureza, cidade, nome_cliente, tel_cliente, nome_corretor, unidade_corretor, descricao_situacao } = dadosIndicacao;

    try {
        // ETAPA 1: SORTEAR O CONSULTOR
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
            return res.status(503).json({ success: false, message: "Falha: Nenhum consultor ativo para esta fila." });
        }

        // ETAPA 2: ATUALIZAR A DATA DO CONSULTOR SORTEADO
        await pool.query('UPDATE Consultores SET data_ultima_indicacao = NOW() WHERE id = $1;', [consultorSorteado.id]); 

        // ETAPA 3: GRAVAR A INDICAÇÃO NO HISTÓRICO
        const insertIndicacaoQuery = `
            INSERT INTO Indicacoes (consultor_id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `;
        await pool.query(insertIndicacaoQuery, [consultorSorteado.id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao]);
        
        // ETAPA 4: ENVIAR NOTIFICAÇÃO POR E-MAIL
        const resendApiKey = process.env.RESEND_API_KEY;
        const emailFrom = process.env.EMAIL_FROM;
        const emailGerenteCC = process.env.EMAIL_GERENTE_CC;

        const emailCorpoHtml = `
            <p>Nova Indicação Recebida!</p>
            <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
            <hr>
            <p><b>Dados do Corretor:</b> ${nome_corretor || 'Não Informado'} (${unidade_corretor || 'N/A'})</p>
            <p><b>Dados do Cliente:</b> ${nome_cliente} - ${tel_cliente || 'N/A'}</p>
            <p><b>Descrição:</b> ${descricao_situacao}</p>
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
                console.error("Falha ao enviar e-mail pelo Resend:", await response.json());
            } else {
                console.log(`E-mail de Atribuição enviado com sucesso para ${consultorSorteado.nome} via Resend.`);
            }
        }

        // ETAPA 5: RESPOSTA DE SUCESSO
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

// Rota para fornecer os dados para o dashboard (agora com filtro por permissão)
app.get('/api/dashboard-data', protectAndIdentify, async (req, res) => {
    try {
        let indicacoesQuery = `
            SELECT i.*, c.nome as consultor_nome 
            FROM Indicacoes i
            LEFT JOIN Consultores c ON i.consultor_id = c.id
        `;
        const queryParams = [];

        // Se o usuário não for Diretor, filtra pelas cidades permitidas
        if (req.userRole.type === 'GERENTE' && req.userRole.cities.length > 0) {
            indicacoesQuery += ' WHERE i.cidade = ANY($1)';
            queryParams.push(req.userRole.cities);
        }

        indicacoesQuery += ' ORDER BY i.data_indicacao DESC;';

        const indicacoesResult = await pool.query(indicacoesQuery, queryParams);
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

// Rota para atualizar o status de um consultor na roleta
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
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

