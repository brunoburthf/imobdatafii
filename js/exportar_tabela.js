// Export .xlsx das tabelas de listagem (fiis.html, agro.html, infra.html).
// Exporta o que está NA TELA: respeita busca, filtros e ordenação, porque
// recebe a mesma lista que a renderizarTabela acabou de desenhar.

// SheetJS carregado só na 1a chamada (mesmo padrão de resultado.js,
// simulador.js e relatorio_mensal.js). Evita ~500KB no load da página.
let _sheetJsExp = null;
async function _carregarSheetJsExp() {
  if (window.XLSX) return;
  if (_sheetJsExp) return _sheetJsExp;
  _sheetJsExp = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Falha ao carregar SheetJS"));
    document.head.appendChild(s);
  });
  return _sheetJsExp;
}

// Vai como número + formato do Excel, não como texto: assim dá pra somar,
// ordenar e graficar na planilha sem ter que limpar "R$ " e "%" antes.
const _FORMATO_COL = {
  "Preço Atual":            'R$ #,##0.00',
  "VP/cota":                'R$ #,##0.00',
  "Último Dividendo Pago":  'R$ #,##0.00',
  "P/VP":                   '0.00',
  "Variação Dia":           '0.00%',
  "DY a.a.":                '0.00%',
  "Retorno - MTD":          '0.00%',
  "Retorno - 12M":          '0.00%',
};

// "Variação Dia" vem em pontos percentuais (-1.25 = -1,25%); as outras
// percentuais vêm em decimal (0.0925). O Excel quer sempre decimal.
function _valorExcel(col, v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v;
  return col === "Variação Dia" ? n / 100 : n;
}

async function baixarTabelaExcel({ btn, titulo, aba, colunas, linhas, arquivo }) {
  if (!linhas || !linhas.length) { alert("Nada a exportar — a tabela está vazia."); return; }
  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Preparando..."; }

  try {
    await _carregarSheetJsExp();

    const CAB = 4;  // linha (0-based) do cabeçalho; 3 linhas de contexto + 1 vazia
    const aoa = [
      [titulo],
      [`Exportado em: ${new Date().toLocaleString("pt-BR")}`],
      [`${linhas.length} fundos — conforme busca, filtros e ordenação da tela`],
      [],
      colunas,
      ...linhas.map(f => colunas.map(c => _valorExcel(c, f[c]))),
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = colunas.map((_, i) => ({ wch: i <= 1 ? 26 : 15 }));
    ws["!merges"] = [0, 1, 2].map(r => (
      { s: { r, c: 0 }, e: { r, c: colunas.length - 1 } }
    ));

    // Formato numérico célula a célula (o aoa_to_sheet não carimba .z sozinho).
    linhas.forEach((_, i) => {
      colunas.forEach((col, j) => {
        const fmt = _FORMATO_COL[col];
        if (!fmt) return;
        const cel = ws[XLSX.utils.encode_cell({ r: CAB + 1 + i, c: j })];
        if (cel && typeof cel.v === "number") cel.z = fmt;
      });
    });

    // Congela o cabeçalho e liga o filtro, que é o que se quer numa listagem.
    ws["!freeze"] = { xSplit: 0, ySplit: CAB + 1 };
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({
      s: { r: CAB, c: 0 },
      e: { r: CAB + linhas.length, c: colunas.length - 1 },
    }) };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, aba);
    XLSX.writeFile(wb, `${arquivo}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    alert("Erro ao gerar Excel: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}
