const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg'); // Cliente PostgreSQL
const fs = require('fs'); // Usado para funções auxiliares
require('dotenv').config(); // Carrega as variáveis do seu arquivo .env

// ----------------------------------------------------
// ❗ LÓGICA DA ROLETA & CONFIGURAÇÃO ❗
// ----------------------------------------------------
const { distribuirIndicacao } = require('./roleta'); 
const app = express();
const PORT = process.env.PORT || 3000; // Usa a porta que o Railway fornecer
// ----------------------------------------------------

// 1. CONFIGURAÇÃO DO BANCO DE DADOS (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});


// --- 3. ENVIO DE E-MAIL (Usando a API do Resend via HTTPS) ---
        const resendApiKey = process.env.RESEND_API_KEY; // Nova variável!

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

        if (resendApiKey) {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${resendApiKey}`
                },
                body: JSON.stringify({
                    from: process.env.EMAIL_FROM, // Ex: 'onboarding@resend.dev'
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
        }

// ----------------------------------------------------------------------
// 4. ROTA POST /api/indicacoes (O Coração do Sistema - TOTALMENTE ASYNC COM DB)
// ----------------------------------------------------------------------
app.post("/api/indicacoes", async (req, res) => {
    
    const dadosIndicacao = req.body;
    const { natureza, cidade, nome_cliente, nome_corretor } = dadosIndicacao;

    // 🚨 CORREÇÃO CRÍTICA: E-mail da Gerente para CC lido do .env, eliminando a função problemática.
    const emailGerenteCC = process.env.EMAIL_GERENTE_CC || process.env.EMAIL_FROM; 

    try {
        // --- 1. LEITURA DO DB (SQL: Sorteio da Roleta) ---
        const roletaQuery = `
            SELECT id, email, nome, data_ultima_indicacao 
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

        // --- 2. ATUALIZAÇÃO DO DB (SQL: Gravação) ---
        const updateQuery = `
            UPDATE Consultores 
            SET data_ultima_indicacao = NOW() 
            WHERE id = $1;
        `;
        await pool.query(updateQuery, [consultorSorteado.id]); 

        // --- 3. ENVIO DE E-MAIL (Usando credenciais seguras) ---
        const emailCorpo = `
            Nova Indicação Recebida - Prioridade Máxima!
            Atribuído a: ${consultorSorteado.nome}
            Detalhes: Corretor Indicador: ${nome_corretor || 'Não Informado'}
            Natureza: ${natureza} / Cidade: ${cidade}
            Dados do Cliente: Nome: ${nome_cliente}, Telefone: ${dadosIndicacao.tel_cliente || 'N/A'}.
        `;

        const mailOptions = {
            from: process.env.EMAIL_FROM || emailGerenteCC, 
            to: consultorSorteado.email, 
            cc: emailGerenteCC, // E-mail da Gerente para cópia
            subject: `[INDICAÇÃO CRI/ADIM] ${natureza} - Cliente: ${nome_cliente} (Atribuído: ${consultorSorteado.nome})`,
            text: emailCorpo,
        };
        await transporter.sendMail(mailOptions);
        console.log(`E-mail de Atribuição Enviado com sucesso para ${consultorSorteado.nome}.`);


        // 4. Resposta de Sucesso FINAL (Garantida pelo fluxo assíncrono)
        return res.status(201).json({ 
            success: true,
            message: "Indicação atribuída com sucesso!",
            consultor_sorteado: consultorSorteado.nome,
        });

    } catch (error) {
        // Resposta de Erro Garantida
        console.error("ERRO IRRECUPERÁVEL NA ROTA /API/INDICACOES:", error);
        return res.status(500).json({ success: false, message: "Erro interno no servidor ao processar a Roleta." });
    }
});


// 6. INICIAR O SERVIDOR
app.listen(PORT, () => {
    console.log(`Servidor CRI/ADIM rodando na porta ${PORT}`);
    console.log('Sistema de Indicação 100% Assíncrono e Pronto para o Deploy!');
});