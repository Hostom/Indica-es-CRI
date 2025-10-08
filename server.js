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
        const roletaQuery = `SELECT id, email, nome FROM Consultores WHERE natureza = $1 AND cidade = $2 AND ativo_na_roleta = TRUE ORDER BY data_ultima_indicacao ASC LIMIT 1;`;
        const consultorResult = await pool.query(roletaQuery, [natureza, cidade]);
        const consultorSorteado = consultorResult.rows[0];

        if (!consultorSorteado) {
            return res.status(503).json({ success: false, message: "Falha: Nenhum consultor ativo para esta fila." });
        }

        await pool.query('UPDATE Consultores SET data_ultima_indicacao = NOW() WHERE id = $1;', [consultorSorteado.id]);
        
        const insertIndicacaoQuery = `INSERT INTO Indicacoes (consultor_id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`;
        await pool.query(insertIndicacaoQuery, [consultorSorteado.id, nome_corretor, unidade_corretor, natureza, cidade, nome_cliente, tel_cliente, descricao_situacao]);

        // --- ETAPA 4: NOVA LÓGICA DE ENVIO DE E-MAIL (VIA SERVIDOR RELAY INTERNO) ---
        const relayUrl = process.env.RELAY_SERVER_URL;
        const relaySecret = process.env.RELAY_SECRET;
        
        // Determinar e-mail do gerente baseado na cidade
        let emailGerenteCC = process.env.EMAIL_GERENTE_CC; // E-mail geral (diretor)
        
        if (cidade === 'Itapema') {
            emailGerenteCC = process.env.EMAIL_GERENTE_ITAPEMA || emailGerenteCC;
        } else if (cidade === 'Balneario Camboriu' || cidade === 'Itajai') {
            emailGerenteCC = process.env.EMAIL_GERENTE_BC_ITAJAI || emailGerenteCC;
        }

        if (relayUrl && relaySecret) {
            const emailCorpoHtml = `
                <p>Nova Indicação Recebida!</p>
                <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
                <p><b>Cidade:</b> ${cidade}</p>
                <p><b>Natureza:</b> ${natureza}</p>
                <hr>
                <p><b>Dados do Corretor:</b> ${nome_corretor || 'N/A'} (${unidade_corretor || 'N/A'})</p>
                <p><b>Dados do Cliente:</b> ${nome_cliente} - ${tel_cliente || 'N/A'}</p>
                <p><b>Descrição:</b> ${descricao_situacao}</p>
            `;

            // Dados que serão enviados para o seu servidor relay
            const emailPayload = {
                to: consultorSorteado.email,
                cc: emailGerenteCC,
                subject: `[INDICAÇÃO] ${natureza} - ${cidade} - Cliente: ${nome_cliente}`,
                html: emailCorpoHtml
            };

            const response = await fetch(relayUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-relay-secret': relaySecret // Senha de segurança
                },
                body: JSON.stringify(emailPayload)
            });

            if (!response.ok) {
                console.error("Falha ao enviar e-mail pelo servidor relay:", await response.text());
            } else {
                console.log(`Pedido de e-mail enviado com sucesso para o servidor relay.`);
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
        
        // Filtrar consultores por cidade para gerentes
        let consultoresQuery = 'SELECT * FROM consultores';
        let consultoresParams = [];
        
        if (req.userRole.type === 'GERENTE') {
            consultoresQuery += ' WHERE cidade = ANY($1)';
            consultoresParams.push(req.userRole.cities);
        }
        consultoresQuery += ' ORDER BY nome ASC';
        
        const consultoresResult = await pool.query(consultoresQuery, consultoresParams);
        res.json({ 
            indicacoes: indicacoesResult.rows, 
            consultores: consultoresResult.rows,
            userRole: req.userRole // Enviar informações do usuário para o frontend
        });
    } catch (error) {
        console.error("Erro ao buscar dados para o dashboard:", error);
        res.status(500).json({ error: 'Erro interno ao buscar dados.' });
    }
});

// --- NOVA ROTA DE RELATÓRIOS ---
app.get('/api/relatorio', protectAndIdentify, async (req, res) => {
    try {
        const { dataInicio, dataFim, consultores, cidades, natureza, status } = req.query;
        
        let query = `
            SELECT 
                i.id,
                i.data_indicacao,
                c.nome as consultor_nome,
                i.nome_corretor,
                i.unidade_corretor,
                i.nome_cliente,
                i.tel_cliente,
                i.cidade,
                i.natureza,
                i.status_interno,
                i.descricao_situacao
            FROM Indicacoes i 
            LEFT JOIN Consultores c ON i.consultor_id = c.id
            WHERE 1=1
        `;
        
        const queryParams = [];
        let paramIndex = 1;

        // Filtro por data de início
        if (dataInicio) {
            query += ` AND i.data_indicacao >= $${paramIndex}`;
            queryParams.push(dataInicio + ' 00:00:00');
            paramIndex++;
        }

        // Filtro por data de fim
        if (dataFim) {
            query += ` AND i.data_indicacao <= $${paramIndex}`;
            queryParams.push(dataFim + ' 23:59:59');
            paramIndex++;
        }

        // Filtro por consultores (IDs separados por vírgula)
        if (consultores) {
            const consultorIds = consultores.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
            if (consultorIds.length > 0) {
                query += ` AND i.consultor_id = ANY($${paramIndex})`;
                queryParams.push(consultorIds);
                paramIndex++;
            }
        }

        // Filtro por cidades (nomes separados por vírgula)
        if (cidades) {
            const cidadesList = cidades.split(',').map(cidade => cidade.trim()).filter(cidade => cidade.length > 0);
            if (cidadesList.length > 0) {
                query += ` AND i.cidade = ANY($${paramIndex})`;
                queryParams.push(cidadesList);
                paramIndex++;
            }
        }

        // Filtro por natureza
        if (natureza) {
            query += ` AND i.natureza = $${paramIndex}`;
            queryParams.push(natureza);
            paramIndex++;
        }

        // Filtro por status
        if (status) {
            query += ` AND i.status_interno = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }

        // Aplicar filtro de permissão para gerentes
        if (req.userRole.type === 'GERENTE') {
            query += ` AND i.cidade = ANY($${paramIndex})`;
            queryParams.push(req.userRole.cities);
            paramIndex++;
        }

        query += ' ORDER BY i.data_indicacao DESC';

        const result = await pool.query(query, queryParams);
        
        res.json({
            success: true,
            data: result.rows,
            total: result.rows.length
        });

    } catch (error) {
        console.error("Erro ao gerar relatório:", error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro interno ao gerar relatório.',
            message: error.message 
        });
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

// Rota para adicionar novo consultor
app.post('/api/consultores', protectAndIdentify, async (req, res) => {
    try {
        const { nome, email, natureza, cidade } = req.body;
        
        // Verificar se o usuário tem permissão para adicionar consultor nesta cidade
        if (req.userRole.type === 'GERENTE' && !req.userRole.cities.includes(cidade)) {
            return res.status(403).json({ error: 'Sem permissão para adicionar consultor nesta cidade.' });
        }
        
        // Verificar se já existe consultor com este e-mail
        const existingConsultor = await pool.query('SELECT id FROM Consultores WHERE email = $1', [email]);
        if (existingConsultor.rows.length > 0) {
            return res.status(400).json({ error: 'Já existe um consultor com este e-mail.' });
        }
        
        const insertQuery = `
            INSERT INTO Consultores (nome, email, natureza, cidade, ativo_na_roleta, data_ultima_indicacao) 
            VALUES ($1, $2, $3, $4, true, '2000-01-01T00:00:00Z') 
            RETURNING *
        `;
        const result = await pool.query(insertQuery, [nome, email, natureza, cidade]);
        
        res.status(201).json({ 
            success: true, 
            message: 'Consultor adicionado com sucesso!',
            consultor: result.rows[0]
        });
    } catch (error) {
        console.error("Erro ao adicionar consultor:", error);
        res.status(500).json({ error: 'Erro interno ao adicionar consultor.' });
    }
});

// Rota para remover consultor
app.delete('/api/consultores/:id', protectAndIdentify, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Buscar o consultor para verificar permissões
        const consultorResult = await pool.query('SELECT cidade FROM Consultores WHERE id = $1', [id]);
        if (consultorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Consultor não encontrado.' });
        }
        
        const consultorCidade = consultorResult.rows[0].cidade;
        
        // Verificar se o usuário tem permissão para remover consultor desta cidade
        if (req.userRole.type === 'GERENTE' && !req.userRole.cities.includes(consultorCidade)) {
            return res.status(403).json({ error: 'Sem permissão para remover consultor desta cidade.' });
        }
        
        // Verificar se o consultor tem indicações associadas
        const indicacoesResult = await pool.query('SELECT COUNT(*) as count FROM Indicacoes WHERE consultor_id = $1', [id]);
        const temIndicacoes = parseInt(indicacoesResult.rows[0].count) > 0;
        
        if (temIndicacoes) {
            // Se tem indicações, apenas desativar
            await pool.query('UPDATE Consultores SET ativo_na_roleta = false WHERE id = $1', [id]);
            res.json({ 
                success: true, 
                message: 'Consultor desativado (possui indicações associadas).',
                action: 'deactivated'
            });
        } else {
            // Se não tem indicações, pode remover completamente
            await pool.query('DELETE FROM Consultores WHERE id = $1', [id]);
            res.json({ 
                success: true, 
                message: 'Consultor removido com sucesso.',
                action: 'deleted'
            });
        }
    } catch (error) {
        console.error("Erro ao remover consultor:", error);
        res.status(500).json({ error: 'Erro interno ao remover consultor.' });
    }
});


// --- INICIAR O SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
