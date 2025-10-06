-- Limpa o banco de dados antes de criar tudo de novo
DROP TABLE IF EXISTS Indicacoes;
DROP TABLE IF EXISTS Consultores;

-- 1. Cria a tabela de Consultores
CREATE TABLE Consultores (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    natureza VARCHAR(50) NOT NULL,
    cidade VARCHAR(50) NOT NULL,
    ativo_na_roleta BOOLEAN DEFAULT TRUE,
    data_ultima_indicacao TIMESTAMP WITH TIME ZONE DEFAULT '2000-01-01T00:00:00Z'
);

-- 2. Insere os dados iniciais
INSERT INTO Consultores (nome, email, natureza, cidade) VALUES
('Israel - Loc BC', 'israel@adimimoveis.com.br', 'Locacao', 'Balneario Camboriu'),
('Bruno - Loc BC', 'bruno.consultor@exemplo.com', 'Locacao', 'Balneario Camboriu'),
('Gerente Geral', 'lidiane@adimimoveis.com.br', 'N/A', 'N/A');

-- 3. Cria a tabela de Indicações (com os novos campos)
CREATE TABLE Indicacoes (
    id SERIAL PRIMARY KEY,
    consultor_id INTEGER REFERENCES Consultores(id),
    nome_corretor VARCHAR(255),
    unidade_corretor VARCHAR(50), -- NOVO CAMPO
    natureza VARCHAR(50),
    cidade VARCHAR(50),
    nome_cliente VARCHAR(255),
    tel_cliente VARCHAR(50),
    descricao_situacao TEXT, -- NOVO CAMPO
    status_interno VARCHAR(50) DEFAULT 'PENDENTE',
    data_indicacao TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
