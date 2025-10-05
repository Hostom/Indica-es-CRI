-- init.sql

-- 1. Cria a tabela de Consultores
CREATE TABLE Consultores (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    natureza VARCHAR(50) NOT NULL,
    cidade VARCHAR(50) NOT NULL,
    ativo_na_roleta BOOLEAN DEFAULT TRUE,
    -- Coluna que a Roleta usa para o Round Robin:
    data_ultima_indicacao TIMESTAMP WITH TIME ZONE DEFAULT '2000-01-01T00:00:00Z'
);

-- 2. Insere os dados iniciais da Gerente e dos Consultores
INSERT INTO Consultores (nome, email, natureza, cidade, ativo_na_roleta, data_ultima_indicacao) VALUES
('Israel - Loc BC', 'israel@adimimoveis.com.br', 'Locacao', 'Balneario Camboriu', TRUE, '2025-10-01T10:00:00Z'),
('Bruno - Loc BC', 'bruno.consultor@exemplo.com', 'Locacao', 'Balneario Camboriu', TRUE, '2025-10-01T11:00:00Z'),
('Gerente Geral', 'lidiane@adimimoveis.com.br', 'N/A', 'N/A', TRUE, '2025-01-01T08:00:00Z');

-- 3. Cria a tabela de Indicações (Para o Dashboard futuro)
CREATE TABLE Indicacoes (
    id SERIAL PRIMARY KEY,
    corretor_id INTEGER,
    consultor_id INTEGER REFERENCES Consultores(id),
    natureza VARCHAR(50),
    cidade VARCHAR(50),
    nome_cliente VARCHAR(255),
    tel_cliente VARCHAR(50),
    status_interno VARCHAR(50) DEFAULT 'PENDENTE',
    status_resumido VARCHAR(50) DEFAULT 'EM ESPERA',
    data_indicacao TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);