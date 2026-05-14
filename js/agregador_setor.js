// Agregador setorial client-side. Le data/fii_series.json (espelho dos
// data/fiis/*.json com so historico_pvp + historico_dy + Setor) e
// data/pesos_ifix.json (pesos mensais), e agrega ponderado pelo IFIX
// com filtro de cobertura minima — mesma logica de agregar_historico_*_setor
// em scripts/gerar_dados.py.
//
// Razao de existir: o agregado pre-computado em data/setores.json pode
// ficar stale quando reprocessamos outliers em data/fiis/*.json. Aqui
// o gráfico sempre reflete o estado corrente da fonte por-FII.
let _fiiSeriesCache = null;
let _pesosIfixCache = null;
let _carregamentoPromise = null;

async function carregarFontesSetor() {
  if (_fiiSeriesCache && _pesosIfixCache) return [_fiiSeriesCache, _pesosIfixCache];
  if (_carregamentoPromise) return _carregamentoPromise;

  const v = Math.floor(Date.now() / 60000);  // cache-bust por minuto
  _carregamentoPromise = Promise.all([
    fetch(`data/fii_series.json?v=${v}`).then(r => {
      if (!r.ok) throw new Error("fii_series.json não encontrado");
      return r.json();
    }),
    fetch(`data/pesos_ifix.json?v=${v}`).then(r => {
      if (!r.ok) throw new Error("pesos_ifix.json não encontrado");
      return r.json();
    })
  ]).then(([s, p]) => {
    _fiiSeriesCache = s;
    _pesosIfixCache = p;
    return [s, p];
  });
  return _carregamentoPromise;
}

// Agrega historico de um setor.
// tipo: "pvp" -> retorna pvp em escala "x" (ex: 0.95)
//       "dy"  -> retorna dy em decimal (ex: 0.09 = 9%)
// coverageMin: fração mínima de FIIs com peso IFIX > 0 que precisam ter
//   ponto naquela data pra ela entrar no agregado. Default 0.8 = "quase todos".
function agregarSerieSetor(setor, tipo, coverageMin = 0.8) {
  if (!_fiiSeriesCache || !_pesosIfixCache) return [];

  const campo = tipo === "pvp" ? "historico_pvp" : "historico_dy";
  // tickers do setor (em qualquer das categorias - FII tijolo, Infra, Agro)
  const tickers = Object.entries(_fiiSeriesCache.fiis)
    .filter(([, info]) => info.Setor === setor)
    .map(([t]) => t);
  if (!tickers.length) return [];

  // Acumula soma*peso e tickers contribuintes por data
  const acc = new Map();
  for (const t of tickers) {
    const hist = _fiiSeriesCache.fiis[t][campo] || [];
    for (const [d, v] of hist) {
      const mes = d.slice(0, 7);
      const peso = _pesosIfixCache[t]?.[mes];
      if (!peso || peso <= 0) continue;
      let e = acc.get(d);
      if (!e) { e = { soma: 0, peso: 0, tickers: new Set() }; acc.set(d, e); }
      e.soma += v * peso;
      e.peso += peso;
      e.tickers.add(t);
    }
  }

  // Cache de elegíveis por mês pra evitar recomputar
  const elegPorMes = new Map();
  function getElegMes(mes) {
    let s = elegPorMes.get(mes);
    if (s) return s;
    s = tickers.filter(t => (_pesosIfixCache[t]?.[mes] ?? 0) > 0);
    elegPorMes.set(mes, s);
    return s;
  }

  const out = [];
  for (const [d, e] of acc) {
    if (e.peso <= 0) continue;
    const eleg = getElegMes(d.slice(0, 7));
    if (!eleg.length) continue;
    if (e.tickers.size / eleg.length < coverageMin) continue;
    let valor = e.soma / e.peso;
    // DY é gravado em % no per-FII (ex: 9.5), agregado vai em decimal (0.095)
    if (tipo === "dy") valor = valor / 100;
    out.push([d, parseFloat(valor.toFixed(tipo === "pvp" ? 4 : 6))]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
