// roleta.js - Contém apenas a função de cálculo, sem leitura de arquivo
// O server.js enviará os dados para esta função.

function distribuirIndicacao(natureza, cidade, consultoresData) {
    
    // 1 & 2. Filtrar a Fila e Pular Inativos
    const filaAtiva = consultoresData.filter(c => 
        c.natureza === natureza && 
        c.cidade === cidade && 
        c.ativo_na_roleta === true
    );

    // 3. Checar Falha
    if (filaAtiva.length === 0) {
        return null;
    }

    // 4. Aplicar Round Robin: Ordenar pela data mais antiga (ASC)
    filaAtiva.sort((a, b) => 
        new Date(a.data_ultima_indicacao) - new Date(b.data_ultima_indicacao)
    );

    // 5. Atribuição: O primeiro da lista é o sorteado
    const consultorSorteado = filaAtiva[0];
    
    return consultorSorteado; // Retorna o objeto completo do consultor
}

module.exports = {
    distribuirIndicacao
};