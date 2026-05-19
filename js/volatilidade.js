// volatilidade.js — calcula vol anualizada e retorno do periodo por setor,
// renderiza tabela ordenavel + scatter (Chart.js).
//
// Fonte: data/volatilidade_base.json (gerado por gerar_volatilidade_base.py).
// Cada fundo tem serie [[YYYY-MM-DD, preco_ajustado], ...] em dias com pregao.

const DIAS_UTEIS_ANO = 252;
// Paleta harmonizada com o navy + laranja do site. Ordem aproximada por
// representatividade (maiores setores recebem os tons mais fortes).
const PALETA_SETORES = {
  "Crédito Imobiliário":   "#001f4d",  // navy principal
  "FOFs/Hedge Funds":      "#5b4b8a",  // roxo navy
  "Escritórios":           "#1d6e42",  // verde escuro
  "Logística":             "#ef6300",  // laranja do site
  "Tijolo Multissetorial": "#0c6e8a",  // ciano escuro
  "Shoppings":             "#a13a5a",  // vinho
  "Agro":                  "#7aa14d",  // verde claro
  "Terras agrícolas":      "#a07a2c",  // dourado
  "Desenvolvimento":       "#9a2828",  // vermelho terroso
};
const COR_DEFAULT = "#6b7a8d";

let _baseFundos = [];          // fundos do JSON (com series)
let _resultados = [];          // [{setor, vol, retorno, n}] do periodo aplicado
let _ordem = { campo: "vol", direcao: "desc" };
let _scatter = null;            // chart instance setores
let _scatterFiis = null;        // chart instance FIIs do setor selecionado
let _setorSelecionado = null;   // setor atualmente em foco no detalhe

async function carregar() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const r = await fetch("data/volatilidade_base.json?v=" + v);
    if (!r.ok) throw new Error("Base nao encontrada. Rode scripts/gerar_volatilidade_base.py primeiro.");
    const doc = await r.json();
    _baseFundos = doc.fundos || [];

    // Range global: min e max de TODAS as series, pra preencher os datepickers
    let dataMin = null, dataMax = null;
    for (const f of _baseFundos) {
      if (!f.serie || !f.serie.length) continue;
      const ini = f.serie[0][0], fim = f.serie[f.serie.length - 1][0];
      if (!dataMin || ini < dataMin) dataMin = ini;
      if (!dataMax || fim > dataMax) dataMax = fim;
    }

    // Default: ultimos 12 meses ate dataMax
    const fimDate = new Date(dataMax);
    const iniDefault = new Date(fimDate);
    iniDefault.setFullYear(iniDefault.getFullYear() - 1);
    const iniStr = iniDefault.toISOString().slice(0, 10);

    const inputIni = document.getElementById("vol-data-ini");
    const inputFim = document.getElementById("vol-data-fim");
    inputIni.min = dataMin;
    inputIni.max = dataMax;
    inputFim.min = dataMin;
    inputFim.max = dataMax;
    inputIni.value = iniStr < dataMin ? dataMin : iniStr;
    inputFim.value = dataMax;

    document.getElementById("vol-btn-aplicar").addEventListener("click", aplicar);
    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "";

    aplicar();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function aplicar() {
  const ini = document.getElementById("vol-data-ini").value;
  const fim = document.getElementById("vol-data-fim").value;
  if (!ini || !fim || ini >= fim) {
    document.getElementById("vol-info").textContent = "Selecione um intervalo válido.";
    return;
  }
  _resultados = calcularPorSetor(ini, fim);
  ordenarTabela(_ordem.campo, true);
  renderScatter();
  const total = _resultados.reduce((acc, r) => acc + r.n, 0);
  document.getElementById("vol-info").textContent =
    `${_resultados.length} setores, ${total} FIIs com dados suficientes no período.`;
  // Se ja havia um setor selecionado, re-renderiza o detalhe com o novo periodo.
  if (_setorSelecionado && _resultados.some(r => r.setor === _setorSelecionado)) {
    renderScatterFiis(_setorSelecionado);
  } else {
    _setorSelecionado = null;
    document.getElementById("vol-detalhe").style.display = "none";
  }
}

// Filtra a serie de um fundo pra [ini, fim] e devolve so os precos.
function recortarSerie(serie, ini, fim) {
  const pontos = [];
  for (const [d, p] of serie) {
    if (d < ini) continue;
    if (d > fim) break;
    pontos.push(p);
  }
  return pontos;
}

// Log-returns diarios + vol anualizada (sqrt(252) × stdev) + retorno total
// do periodo. Retorna null se a serie tem < 20 pontos (pra evitar vol ruim).
function calcularFundo(serie, ini, fim) {
  const precos = recortarSerie(serie, ini, fim);
  if (precos.length < 20) return null;

  const logRet = [];
  for (let i = 1; i < precos.length; i++) {
    if (precos[i - 1] <= 0) continue;
    logRet.push(Math.log(precos[i] / precos[i - 1]));
  }
  if (!logRet.length) return null;

  const media = logRet.reduce((a, b) => a + b, 0) / logRet.length;
  const variancia = logRet.reduce((a, b) => a + (b - media) ** 2, 0) / (logRet.length - 1 || 1);
  const volDiaria = Math.sqrt(variancia);
  const volAnual = volDiaria * Math.sqrt(DIAS_UTEIS_ANO);

  const retornoTotal = precos[precos.length - 1] / precos[0] - 1;

  return { vol: volAnual, retorno: retornoTotal, n_obs: precos.length };
}

function calcularPorSetor(ini, fim) {
  const porSetor = new Map();
  for (const f of _baseFundos) {
    if (!f.setor) continue;
    const m = calcularFundo(f.serie, ini, fim);
    if (!m) continue;
    if (!porSetor.has(f.setor)) porSetor.set(f.setor, []);
    porSetor.get(f.setor).push(m);
  }
  const linhas = [];
  for (const [setor, fundos] of porSetor.entries()) {
    if (!fundos.length) continue;
    const vol = fundos.reduce((a, b) => a + b.vol, 0) / fundos.length;
    const retorno = fundos.reduce((a, b) => a + b.retorno, 0) / fundos.length;
    linhas.push({ setor, vol, retorno, n: fundos.length });
  }
  return linhas;
}

window.ordenarTabela = function(campo, manterDirecao = false) {
  if (!manterDirecao) {
    if (_ordem.campo === campo) {
      _ordem.direcao = _ordem.direcao === "asc" ? "desc" : "asc";
    } else {
      _ordem.campo = campo;
      _ordem.direcao = (campo === "setor") ? "asc" : "desc";
    }
  }
  _resultados.sort((a, b) => {
    const va = a[campo], vb = b[campo];
    if (typeof va === "string") return _ordem.direcao === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    return _ordem.direcao === "asc" ? va - vb : vb - va;
  });
  renderTabela();
};

function fmtPct(x) {
  return (x * 100).toFixed(2) + "%";
}

function renderTabela() {
  const tbody = document.getElementById("vol-tabela-body");
  tbody.innerHTML = "";
  for (const r of _resultados) {
    const tr = document.createElement("tr");
    const cor = PALETA_SETORES[r.setor] || COR_DEFAULT;
    tr.style.cursor = "pointer";
    if (r.setor === _setorSelecionado) tr.classList.add("selecionado");
    tr.innerHTML = `
      <td><span class="vol-dot" style="background:${cor}"></span>${r.setor}</td>
      <td class="num">${fmtPct(r.vol)}</td>
      <td class="num ${r.retorno >= 0 ? "positivo" : "negativo"}">${fmtPct(r.retorno)}</td>
      <td class="num">${r.n}</td>
    `;
    tr.addEventListener("click", () => selecionarSetor(r.setor));
    tbody.appendChild(tr);
  }
}

function selecionarSetor(setor) {
  _setorSelecionado = setor;
  // Re-render pra aplicar a classe .selecionado na linha clicada
  renderTabela();
  renderScatterFiis(setor);
}

// Scatter de TODOS os FIIs do setor selecionado: cada ponto = 1 fundo.
// 1 dataset por FII pra que a legend do Chart.js mostre ticker + cor.
// Cores vivas e contrastantes: rainbow HSL varrendo 360 graus + alternancia
// de luminosidade (50% / 38%) pra dobrar a separacao visual entre vizinhos.
function renderScatterFiis(setor) {
  const ini = document.getElementById("vol-data-ini").value;
  const fim = document.getElementById("vol-data-fim").value;
  if (!ini || !fim) return;

  const fundos = [];
  for (const f of _baseFundos) {
    if (f.setor !== setor) continue;
    const m = calcularFundo(f.serie, ini, fim);
    if (!m) continue;
    fundos.push({ ticker: f.ticker, vol: m.vol, retorno: m.retorno, n: m.n_obs });
  }
  fundos.sort((a, b) => a.ticker.localeCompare(b.ticker));

  // Cor por quadrante. Cruzamento = MEDIA de vol e retorno dos FIIs do setor.
  const vols = fundos.map(f => f.vol);
  const rets = fundos.map(f => f.retorno);
  const volMed = vols.reduce((s, v) => s + v, 0) / vols.length;
  const retMed = rets.reduce((s, v) => s + v, 0) / rets.length;

  const COR = {
    verde:    "rgb(14, 159, 110)",   // retorno alto, vol baixa
    amarelo:  "rgb(202, 138, 4)",    // retorno alto, vol alta
    vermelho: "rgb(220, 38, 38)",    // retorno baixo, vol alta
    cinza:    "rgb(100, 116, 139)",  // retorno baixo, vol baixa
  };
  const corQuadrante = (vol, ret) => {
    if (ret >= retMed && vol <  volMed) return COR.verde;
    if (ret >= retMed && vol >= volMed) return COR.amarelo;
    if (ret <  retMed && vol >= volMed) return COR.vermelho;
    return COR.cinza;
  };

  const datasets = fundos.map((f) => {
    const cor = corQuadrante(f.vol, f.retorno);
    return {
      label: f.ticker,
      data: [{ x: f.vol * 100, y: f.retorno * 100, ticker: f.ticker }],
      backgroundColor: cor,
      borderColor: cor,
      pointRadius: 7,
      pointHoverRadius: 10,
    };
  });

  document.getElementById("vol-detalhe-titulo").textContent = `${setor} — ${fundos.length} FIIs`;
  document.getElementById("vol-detalhe").style.display = "";

  const canvas = document.getElementById("vol-scatter-fiis");
  const ctx = canvas.getContext("2d");
  if (_scatterFiis) _scatterFiis.destroy();

  _scatterFiis = new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 40 } },   // espaco pro ticker do ponto mais a direita
      plugins: {
        legend: { display: false },          // ticker ja aparece no ponto
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.ticker}: vol ${p.x.toFixed(2)}%, retorno ${p.y.toFixed(2)}%`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "Volatilidade anualizada (%)" }, beginAtZero: true },
        y: { title: { display: true, text: "Retorno do período (%)" } },
      },
    },
    plugins: [quadrantesPlugin, tickerLabelsPlugin],
  });
}

// Plugin que apenas desenha as linhas tracejadas das MEDIAS de vol e retorno
// (divisorias dos 4 quadrantes — as cores dos pontos identificam o quadrante).
const quadrantesPlugin = {
  id: "quadrantes",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { x, y } } = chart;
    if (!chartArea) return;

    const pts = chart.data.datasets.flatMap(ds => ds.data || []);
    if (pts.length < 2) return;

    const xs = pts.map(p => p.x).filter(v => Number.isFinite(v));
    const ys = pts.map(p => p.y).filter(v => Number.isFinite(v));
    if (xs.length < 2 || ys.length < 2) return;

    const media = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    const xC = media(xs);
    const yC = media(ys);
    const xPx = x.getPixelForValue(xC);
    const yPx = y.getPixelForValue(yC);

    ctx.save();
    ctx.strokeStyle = "rgba(0, 9, 60, 0.25)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (xPx >= chartArea.left && xPx <= chartArea.right) {
      ctx.moveTo(xPx, chartArea.top);
      ctx.lineTo(xPx, chartArea.bottom);
    }
    if (yPx >= chartArea.top && yPx <= chartArea.bottom) {
      ctx.moveTo(chartArea.left,  yPx);
      ctx.lineTo(chartArea.right, yPx);
    }
    ctx.stroke();
    ctx.restore();
  },
};

// Plugin que desenha o ticker ao lado de cada ponto (afterDatasetsDraw pra
// ficar por cima do circle). Pequeno offset pra direita e leve cima.
const tickerLabelsPlugin = {
  id: "tickerLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "600 10.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "rgba(28, 43, 58, 0.92)";
    ctx.textBaseline = "middle";
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      const pt = meta.data && meta.data[0];
      if (!pt) return;
      const ticker = ds.label || "";
      ctx.fillText(ticker, pt.x + 10, pt.y);
    });
    ctx.restore();
  },
};

// Cores vivas e contrastantes pra N pontos. Estrategia:
//   1) Hue distribuido com golden angle (137.508°) pra maximizar separacao
//      entre vizinhos sequenciais (melhor que step linear 360/N pra qualquer N)
//   2) Saturacao alta (78%) e luminosidade alternada (48%/35%) pra dobrar a
//      separacao visual sem perder contraste com fundo branco
function corContrastante(i, total) {
  const GOLDEN = 137.508;
  const hue = (i * GOLDEN) % 360;
  const sat = 78;
  const lum = (i % 2 === 0) ? 48 : 35;
  return `hsl(${hue.toFixed(1)}, ${sat}%, ${lum}%)`;
}

function renderScatter() {
  const canvas = document.getElementById("vol-scatter");
  const ctx = canvas.getContext("2d");
  if (_scatter) _scatter.destroy();

  const pontos = _resultados.map(r => ({
    x: r.vol * 100,
    y: r.retorno * 100,
    setor: r.setor,
    n: r.n,
  }));
  const cores = _resultados.map(r => PALETA_SETORES[r.setor] || COR_DEFAULT);

  _scatter = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [{
        data: pontos,
        backgroundColor: cores,
        borderColor: cores,
        pointRadius: 10,
        pointHoverRadius: 14,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.setor}: vol ${p.x.toFixed(2)}%, retorno ${p.y.toFixed(2)}% (${p.n} FIIs)`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Volatilidade anualizada (%)" },
          beginAtZero: true,
        },
        y: {
          title: { display: true, text: "Retorno do período (%)" },
        },
      },
    },
  });
}

document.addEventListener("DOMContentLoaded", carregar);
