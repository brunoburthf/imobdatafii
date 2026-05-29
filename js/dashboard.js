// Dashboard interno: tabela por setor com KPIs por fundo. Calcula tudo
// client-side a partir dos JSONs ja existentes (sem coletar dado novo).
//
// Colunas:
// - PL Total: soma dos `valor` em carteira_trimestral.ativos (proxy CVM,
//   exclui imoveis pq CVM CDA nao traz valor R$ deles). FI-Infra/Fiagro
//   ficam vazios (carteira_trimestral nao populada pra eles).
// - Liquidez: nao temos dado coletado (volume diario nao esta no projeto).
// - % no tipo principal: depende do setor (CRI/CRA pra papel, Imoveis pra
//   tijolo — mas imoveis nao tem valor R$ entao fica N/D).
// - Spread NTN-B atual: DY - YTM_NTNB_5anos (interpolado por duration).
// - Spread medio: media historica do spread (calc a partir de fii_series).
// - P/VP, vs CDI 1A/3A/5A: ja vem de index.json/infra/agro.

let _todosFundos = [];   // [{ticker, nome, setor, dados, source}]
let _carteiras = {};     // ticker -> {ativos:[...], imoveis:[...]}
let _historicoDy = {};   // ticker -> [[d, dy_pct], ...]
let _ntnbHist = null;
let _ntnbAtual = null;
const SPREAD_NTNB_ANOS = 5;
const SPREAD_NTNB_DIAS = SPREAD_NTNB_ANOS * 252;
let _ordemCol = "pl";
let _ordemAsc = false;

async function carregarDashboard() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const [idx, infra, agro, ntnb, ntnbHist, fiiSeries] = await Promise.all([
      fetch(`data/index.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/infra_index.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/agro_index.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/ntnb.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/ntnb_ytm_historico.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/fii_series.json?v=${v}`).then(r => r.ok ? r.json() : null),
    ]);
    if (!idx) throw new Error("index.json não disponível.");

    // Junta todos os fundos
    const lista = [];
    (idx.fiis || []).forEach(f => lista.push({
      ticker: f.Ticker, nome: f.Nome, setor: f.Setor || "—",
      dados: f, source: "fiis"
    }));
    (infra?.fundos || []).forEach(f => lista.push({
      ticker: f.Ticker, nome: f.Nome, setor: f.Setor || f.Tipo || "FI-Infra",
      dados: f, source: "infra"
    }));
    (agro?.fundos || []).forEach(f => lista.push({
      ticker: f.Ticker, nome: f.Nome, setor: f.Setor || f.Tipo || "Agro",
      dados: f, source: "agro"
    }));
    _todosFundos = lista;

    _ntnbAtual = ntnb;
    _ntnbHist = ntnbHist;

    // historico_dy de cada fundo (do fii_series.json)
    if (fiiSeries?.fiis) {
      for (const t in fiiSeries.fiis) {
        _historicoDy[t] = fiiSeries.fiis[t].historico_dy || [];
      }
    }

    // Popula filtro de setor
    const setores = [...new Set(lista.map(f => f.setor).filter(Boolean))].sort();
    const sel = document.getElementById("filtro-setor");
    sel.innerHTML = '<option value="">— selecione —</option>' +
      setores.map(s => `<option value="${s}">${s}</option>`).join("");

    document.getElementById("loading").style.display = "none";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Erro ao carregar dados: " + e.message;
  }
}

// Carrega carteira_trimestral sob demanda (~50-200 KB cada). Cache por ticker.
async function _carregarCarteira(fundo) {
  if (_carteiras[fundo.ticker]) return _carteiras[fundo.ticker];
  try {
    const r = await fetch(`data/${fundo.source}/${fundo.ticker}.json`);
    if (!r.ok) { _carteiras[fundo.ticker] = null; return null; }
    const d = await r.json();
    _carteiras[fundo.ticker] = {
      ativos: (d.carteira_trimestral || {}).ativos || [],
      portfolio: d.portfolio || {},
      historico_dpc: d.historico_dpc || [],
    };
    return _carteiras[fundo.ticker];
  } catch {
    _carteiras[fundo.ticker] = null;
    return null;
  }
}

// Interpola YTM NTN-B p/ duration alvo numa data específica (5 anos = ~1825d).
// Retorna null se faltarem 2 ISINs em torno da duration alvo nessa data.
function _ytmNtnbInterpolado(data, ntnbHist, targetDias = SPREAD_NTNB_DIAS) {
  const isins = ntnbHist?.isins || {};
  // Pra cada ISIN, pega YTM(data) e duration(data)
  const pontos = [];
  // ntnb_duration_historico: precisaria fetch separado. Mas em ntnb.json
  // (snapshot atual) ja temos duration recente. Pra simplificar, usamos
  // a aproximacao: ordenar ISINs por nome (que reflete vencimento crescente)
  // e usar a posicao no array como proxy de prazo. Boa o suficiente pra
  // demarcar tendencia, mas calculo preciso ficaria com o ntnb_duration.
  // ── Usa duration ATUAL dos ISINs do snapshot ntnb.json:
  if (_ntnbAtual?.duration) {
    for (const isin in isins) {
      const yvalRow = isins[isin].find(x => x[0] === data) || isins[isin].find(x => x[0] <= data);
      const dur = _ntnbAtual.duration[isin];
      if (yvalRow && dur != null) pontos.push({ ytm: yvalRow[1], dur: dur });
    }
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.dur - b.dur);
  // Acha 2 ISINs ao redor de targetDias
  let antes = null, depois = null;
  for (const p of pontos) {
    if (p.dur <= targetDias) antes = p;
    if (p.dur >= targetDias && !depois) depois = p;
  }
  if (antes && depois && antes !== depois) {
    const t = (targetDias - antes.dur) / (depois.dur - antes.dur);
    return antes.ytm + t * (depois.ytm - antes.ytm);
  }
  return (antes || depois)?.ytm ?? null;
}

// Versão atual: usa ntnb.json snapshot (ytm + duration de cada ISIN HOJE).
function _ytmNtnbAtual() {
  if (!_ntnbAtual?.ytm || !_ntnbAtual?.duration) return null;
  const pontos = [];
  for (const isin in _ntnbAtual.ytm) {
    const ytm = _ntnbAtual.ytm[isin];
    const dur = _ntnbAtual.duration[isin];
    if (ytm != null && dur != null) pontos.push({ ytm, dur });
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.dur - b.dur);
  let antes = null, depois = null;
  for (const p of pontos) {
    if (p.dur <= SPREAD_NTNB_DIAS) antes = p;
    if (p.dur >= SPREAD_NTNB_DIAS && !depois) depois = p;
  }
  if (antes && depois && antes !== depois) {
    const t = (SPREAD_NTNB_DIAS - antes.dur) / (depois.dur - antes.dur);
    return antes.ytm + t * (depois.ytm - antes.ytm);
  }
  return (antes || depois)?.ytm ?? null;
}

// Spread medio historico = media de (DY[d] - YTM_NTNB_5y[d]) ao longo do
// historico do FII. Calcula com amostragem mensal pra performance.
function _spreadMedioHistorico(ticker) {
  const hist = _historicoDy[ticker] || [];
  if (!hist.length || !_ntnbHist) return null;
  // Indexa YTM por data (ja interpolada por duration)
  const cacheYtm = {};
  // Amostragem: usa um ponto por mes
  const porMes = {};
  for (const [d, dy] of hist) {
    const mes = d.slice(0, 7);
    if (!porMes[mes]) porMes[mes] = [d, dy];
  }
  let soma = 0, n = 0;
  for (const mes in porMes) {
    const [d, dy] = porMes[mes];
    let ytm = cacheYtm[d];
    if (ytm === undefined) {
      ytm = _ytmNtnbInterpolado(d, _ntnbHist);
      cacheYtm[d] = ytm;
    }
    if (ytm == null) continue;
    // historico_dy esta em % a.a. (ex: 9.5). NTN-B YTM tambem em %.
    soma += (dy - ytm);
    n++;
  }
  return n ? soma / n : null;
}

// CAGR 5A do DPC: compara soma dos ultimos 12m com soma de 12m que terminam
// 5 anos atras (i.e., janela [-60m, -48m]). Robusto a ruido mensal e a meses
// pulados. Retorna null se historico < 5 anos ou periodo base zero/negativo.
function _cagrDpc5y(historico_dpc) {
  if (!historico_dpc || historico_dpc.length < 60) return null;
  // historico_dpc: [["YYYY-MM-DD", valor], ...] ja ajustado por split. Ordena
  // por data e pega o "mes" de cada ponto pra evitar pegar dois pontos no
  // mesmo mes.
  const sorted = [...historico_dpc].sort((a, b) =>
    a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0));
  const ultimo = sorted[sorted.length - 1][0];
  const dt = new Date(ultimo + "T00:00:00");
  // Janela final: [-12m, 0] terminando no ultimo ponto
  const fim1 = new Date(dt); const ini1 = new Date(dt);
  ini1.setMonth(ini1.getMonth() - 12);
  // Janela base: [-60m, -48m] terminando 5 anos antes do ultimo ponto
  const fim0 = new Date(dt); fim0.setFullYear(fim0.getFullYear() - 5);
  const ini0 = new Date(fim0); ini0.setMonth(ini0.getMonth() - 12);

  let soma1 = 0, soma0 = 0, n1 = 0, n0 = 0;
  for (const [d, v] of sorted) {
    if (!v || v <= 0) continue;
    const dx = new Date(d + "T00:00:00");
    if (dx > ini1 && dx <= fim1) { soma1 += v; n1++; }
    if (dx > ini0 && dx <= fim0) { soma0 += v; n0++; }
  }
  // Pelo menos 8 meses em cada janela (tolera 4 meses pulados)
  if (n1 < 8 || n0 < 8 || soma0 <= 0) return null;
  return Math.pow(soma1 / soma0, 1 / 5) - 1;
}

function _categoriaPrincipal(setor) {
  if (/Cr[ée]dito|FOFs|Hedge|Multissetor|Desenvolv/i.test(setor)) return "CRI/CRA";
  if (/Log|Shopping|Escrit|Imov|Tijolo/i.test(setor)) return "Imóveis";
  if (/Agro|Terras/i.test(setor)) return "CRA";
  if (/Infra/i.test(setor)) return "Debêntures";
  return "—";
}

async function renderizarDashboard() {
  const setor = document.getElementById("filtro-setor").value;
  const wrapper = document.getElementById("dashboard-tabela-wrapper");
  const info = document.getElementById("dashboard-info");
  if (!setor) {
    wrapper.style.display = "none";
    info.textContent = "";
    return;
  }
  wrapper.style.display = "block";

  const fundos = _todosFundos.filter(f => f.setor === setor);
  info.textContent = `${fundos.length} fundo${fundos.length !== 1 ? "s" : ""}`;

  // Atualiza header da coluna "% no tipo" pra refletir o setor
  const cat = _categoriaPrincipal(setor);
  document.getElementById("th-pct-tipo").firstChild.nodeValue = `% ${cat} `;

  // Carrega carteiras em paralelo
  await Promise.all(fundos.map(_carregarCarteira));

  // YTM atual interpolada (mesma pra todos)
  const ytmAtual = _ytmNtnbAtual();

  // Calcula linhas
  const linhas = fundos.map(f => {
    const cart = _carteiras[f.ticker];
    let pl = null;
    let pctTipo = null;
    if (cart) {
      // PL = soma de todos os ativos financeiros
      pl = cart.ativos.reduce((s, a) => s + (a.valor || 0), 0);
      if (pl <= 0) pl = null;
      // % no tipo principal:
      if (cat === "CRI/CRA" && pl) {
        const valCris = cart.ativos
          .filter(a => /CRI|CRA|LCI|LIG/.test(a.tipo || ""))
          .reduce((s, a) => s + (a.valor || 0), 0);
        pctTipo = valCris / pl;
      }
      // Imóveis / CRA Agro / Debêntures Infra: sem dado preciso → null
    }

    const dy = f.dados["DY a.a."];
    let spread = null;
    if (dy != null && ytmAtual != null) {
      // dy em decimal (0.095 = 9.5%); ytm em % (6.5)
      spread = dy * 100 - ytmAtual;
    }
    const spreadMed = _spreadMedioHistorico(f.ticker);

    const cagr5 = cart ? _cagrDpc5y(cart.historico_dpc) : null;

    return {
      ticker:     f.ticker,
      nome:       f.nome,
      pl,
      liquidez:   null,         // N/D — não coletamos volume
      pct_tipo:   pctTipo,
      spread,
      spread_med: spreadMed,
      pvp:        f.dados["P/VP"],
      cagr5,
      cdi1:       f.dados["% Dias Acima CDI 1A"],
      cdi3:       f.dados["% Dias Acima CDI 3A"],
      cdi5:       f.dados["% Dias Acima CDI 5A"],
    };
  });

  // Ordena
  const dir = _ordemAsc ? 1 : -1;
  linhas.sort((a, b) => {
    const va = a[_ordemCol], vb = b[_ordemCol];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "pt-BR") * dir;
  });

  // Atualiza icones de ordem
  document.querySelectorAll("#dashboard-tabela th[data-col]").forEach(th => {
    const ic = th.querySelector(".sort-icon");
    if (!ic) return;
    if (th.dataset.col === _ordemCol) ic.textContent = _ordemAsc ? "↑" : "↓";
    else ic.textContent = "↕";
  });

  const fmtR = v => v == null ? '<span class="dash-na">N/D</span>'
    : v >= 1e9 ? "R$ " + (v / 1e9).toFixed(2) + " bi"
    : v >= 1e6 ? "R$ " + (v / 1e6).toFixed(0) + " mi"
    : "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  const fmtP1 = v => v == null ? '<span class="dash-na">N/D</span>' : (v * 100).toFixed(1) + "%";
  const fmtN  = v => v == null ? '<span class="dash-na">N/D</span>' : v.toFixed(2);
  const fmtSpread = v => v == null ? '<span class="dash-na">N/D</span>' : (v >= 0 ? "+" : "") + v.toFixed(2) + "pp";

  document.getElementById("dashboard-tbody").innerHTML = linhas.map(l => `
    <tr>
      <td><a href="fii.html?ticker=${l.ticker}" class="ticker-link">${l.ticker}</a></td>
      <td>${l.nome || "—"}</td>
      <td class="num">${fmtR(l.pl)}</td>
      <td class="num">${fmtR(l.liquidez)}</td>
      <td class="num">${fmtP1(l.pct_tipo)}</td>
      <td class="num">${fmtSpread(l.spread)}</td>
      <td class="num">${fmtSpread(l.spread_med)}</td>
      <td class="num">${fmtN(l.pvp)}</td>
      <td class="num">${fmtP1(l.cagr5)}</td>
      <td class="num">${fmtP1(l.cdi1)}</td>
      <td class="num">${fmtP1(l.cdi3)}</td>
      <td class="num">${fmtP1(l.cdi5)}</td>
    </tr>
  `).join("");
}

function ordenarDashboard(col) {
  if (_ordemCol === col) _ordemAsc = !_ordemAsc;
  else { _ordemCol = col; _ordemAsc = false; }
  renderizarDashboard();
}

carregarDashboard();
