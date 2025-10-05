const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg'); 
require('dotenv').config(); 

const app = express();
const PORT = process.env.PORT || 3000;

// 1. CONFIGURAÇÃO DO BANCO DE DADOS (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { 
        rejectUnauthorized: false 
    } 
});

// 2. MIDDLEWARE (Configurações do Express)
app.use(express.json()); 
app.use(cors()); 

// 3. ROTA PRINCIPAL (/)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. ROTA DA API (/api/indicacoes) - O CORAÇÃO DO SISTEMA
app.post("/api/indicacoes", async (req, res) => {
    
    // Pega os dados enviados pelo formulário
    const dadosIndicacao = req.body;
    // Adicionei 'nome_corretor' aqui para facilitar o acesso
    const { natureza, cidade, nome_cliente, tel_cliente, nome_corretor } = dadosIndicacao;

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

        // --- NOVA ETAPA 2.5: GRAVAR A INDICAÇÃO NA TABELA DE HISTÓRICO ---
        const insertIndicacaoQuery = `
            INSERT INTO Indicacoes (consultor_id, natureza, cidade, nome_cliente, tel_cliente, nome_corretor)
            VALUES ($1, $2, $3, $4, $5, $6);
        `;
        await pool.query(insertIndicacaoQuery, [
            consultorSorteado.id,
            natureza,
            cidade,
            nome_cliente,
            tel_cliente,
            nome_corretor // Adicionado para salvar quem indicou
        ]);
        console.log(`Indicação para o cliente ${nome_cliente} foi gravada com sucesso na tabela de histórico.`);

        // --- ETAPA 3: ENVIAR A NOTIFICAÇÃO POR E-MAIL (VIA RESEND API) ---
        const resendApiKey = process.env.RESEND_API_KEY;
        const emailFrom = process.env.EMAIL_FROM;
        const emailGerenteCC = process.env.EMAIL_GERENTE_CC;

        const emailCorpoHtml = `
            <p>Nova Indicação Recebida - Prioridade Máxima!</p>
            <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
            <p><b>Detalhes:</b></p>
            <ul>
                <li><b>Corretor Indicador:</b> ${nome_corretor || 'Não Informado'}</li>
                <li><b>Natureza:</b> ${natureza}</li>
                <li><b>Cidade:</b> ${cidade}</li>
                <li><b>Cliente:</b> ${nome_cliente}</li>
                <li><b>Telefone:</b> ${tel_cliente || 'N/A'}</li>
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
                    subject: `[INDICAÇÃO CRI/ADIM] ${natureza} - Cliente: ${nome_cliente}`,
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

// 5. INICIAR O SERVIDOR
app.listen(PORT, () => {
    console.log(`Servidor CRI/ADIM rodando na porta ${PORT}`);
});
    