const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg'); 
require('dotenv').config(); 

const app = express();
const PORT = process.env.PORT || 3000;

// 1. CONFIGURAÇÃO DO BANCO DE DADOS (PostgreSQL)
// O pool de conexões será usado por nossas rotas
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    // A configuração SSL é importante para conexões com Vercel, Render, etc.
    ssl: { 
        rejectUnauthorized: false 
    } 
});

// 2. MIDDLEWARE (Configurações do Express)
// Permite que o servidor entenda JSON vindo do formulário
app.use(express.json()); 
// Habilita o CORS para evitar erros de bloqueio no navegador
app.use(cors()); 

// 3. ROTA PRINCIPAL (/)
// Serve o arquivo index.html quando alguém acessa a raiz do site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. ROTA DA API (/api/indicacoes) - O CORAÇÃO DO SISTEMA
app.post("/api/indicacoes", async (req, res) => {
    
    // Pega os dados enviados pelo formulário
    const dadosIndicacao = req.body;
    const { natureza, cidade, nome_cliente, nome_corretor } = dadosIndicacao;

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

        // Se a roleta não encontrar ninguém, envia um erro e para a execução
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

        // --- ETAPA 3: ENVIAR A NOTIFICAÇÃO POR E-MAIL (VIA RESEND API) ---
        const resendApiKey = process.env.RESEND_API_KEY;
        const emailFrom = process.env.EMAIL_FROM;
        const emailGerenteCC = process.env.EMAIL_GERENTE_CC;

        // Monta o corpo do e-mail em HTML para ficar mais bonito
        const emailCorpoHtml = `
            <p>Nova Indicação Recebida - Prioridade Máxima!</p>
            <p><b>Atribuído a:</b> ${consultorSorteado.nome}</p>
            <p><b>Detalhes:</b></p>
            <ul>
                <li><b>Corretor Indicador:</b> ${nome_corretor || 'Não Informado'}</li>
                <li><b>Natureza:</b> ${natureza}</li>
                <li><b>Cidade:</b> ${cidade}</li>
                <li><b>Cliente:</b> ${nome_cliente}</li>
                <li><b>Telefone:</b> ${dadosIndicacao.tel_cliente || 'N/A'}</li>
            </ul>
        `;
        
        // Só tenta enviar o e-mail se a chave da API do Resend existir
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
                    cc: emailGerenteCC, // Adiciona a gerente em cópia, se a variável existir
                    subject: `[INDICAÇÃO CRI/ADIM] ${natureza} - Cliente: ${nome_cliente}`,
                    html: emailCorpoHtml
                })
            });

            if (!response.ok) {
                // Se o Resend retornar um erro, mostra no log do servidor para depuração
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
            message: "Indicação atribuída com sucesso!",
            consultor_sorteado: consultorSorteado.nome,
        });

    } catch (error) {
        // Se qualquer etapa acima falhar (banco de dados, etc.), captura o erro
        console.error("ERRO IRRECUPERÁVEL NA ROTA /API/INDICACOES:", error);
        return res.status(500).json({ success: false, message: "Erro interno no servidor ao processar a Roleta." });
    }
});

// 5. INICIAR O SERVIDOR
app.listen(PORT, () => {
    console.log(`Servidor CRI/ADIM rodando na porta ${PORT}`);
});
