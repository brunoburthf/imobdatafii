/* spread.js — NTN-B Duration Constante + DY do FII selecionado */

const COR_NTNB  = "rgba(239,99,0,1)";
const COR_FUNDO = "rgba(239,99,0,0.07)";
const COR_FII   = "rgb(0,9,60)";
const COR_NAVY  = "rgb(0,9,60)";

let dadosNtnb    = [];   // [{date, ytm}] completo
let dadosFii     = [];   // [{date, dy}] completo do FII selecionado
let fiiSelecionado = null;
let grafico      = null;
let graficoDiff  = null;
let periodoAtivo = "1A";
let targetDuration = 5;

let todosOsFiis  = [];   // [{ticker, nome}] para busca
let indiceSugestao = -1;

// ─── Inicialização ────────────────────────────────────────────────────────────

async function inicializar() {
  const loadEl    = document.getElementById("loading");
  const erroEl    = document.getElementById("erro");
  const conteudoEl = document.getElementById("conteudo");

  try {
    const [respNtnb, respIndex] = await Promise.all([
      fetch("data/ntnb.json"),
      fetch("data/index.json")
    ]);
    if (!respNtnb.ok) throw new Error("ntnb.json não encontrado.");
    if (!respIndex.ok) throw new Error("index.json não encontrado.");

    const ntnb  = await respNtnb.json();
    const index = await respIndex.json();

    window._ntnbDados = ntnb;
    todosOsFiis = (index.fiis || []).map(f => ({
      ticker: f["Ticker"] || f.ticker || "",
      nome:   f["Nome"]   || f.nome   || ""
    })).filter(f => f.ticker);

    loadEl.style.display    = "none";
    conteudoEl.style.display = "block";
    selecionarDuration(5);
  } catch (e) {
    loadEl.style.display = "none";
    erroEl.style.display = "block";
    erroEl.textContent   = "Erro ao carregar dados: " + e.message;
  }
}

// ─── Duration ─────────────────────────────────────────────────────────────────

function selecionarDuration(anos) {
  targetDuration = anos;
  document.querySelectorAll(".btn-duration").forEach(b => {
    b.classList.toggle("ativo", parseInt(b.dataset.anos) === anos);
  });
  calcularNtnb(anos);
}

function calcularNtnb(target) {
  const dados = window._ntnbDados;
  if (!dados) return;

  // Índice YTM por data
  const ytmPorData = {};
  for (const bond of Object.keys(dados.ytm)) {
    for (const [dt, val] of dados.ytm[bond]) {
      if (!ytmPorData[dt]) ytmPorData[dt] = {};
      ytmPorData[dt][bond] = val;
    }
  }

  // Duration: forward-fill por bond para cobrir datas diárias
  // Para cada bond, guarda série ordenada e usa o valor mais recente disponível
  const durSeries = {};
  for (const bond of Object.keys(dados.duration)) {
    durSeries[bond] = dados.duration[bond].slice().sort((a, b) => a[0] < b[0] ? -1 : 1);
  }

  function getDur(bond, dt) {
    const serie = durSeries[bond];
    if (!serie || !serie.length) return null;
    let val = null;
    for (const [d, v] of serie) {
      if (d <= dt) val = v;
      else break;
    }
    return val;
  }

  // Para cada data com YTM, monta mapa {bond: durDias} via forward-fill
  const todasDatas = Object.keys(ytmPorData).sort();
  const serie = [];
  for (const dt of todasDatas) {
    const ytmMap = ytmPorData[dt];
    const durMap = {};
    for (const bond of Object.keys(ytmMap)) {
      const d = getDur(bond, dt);
      if (d !== null) durMap[bond] = d;
    }
    const ytmInterp = interpolarDia(ytmMap, durMap, target);
    if (ytmInterp !== null) serie.push({ date: dt, ytm: ytmInterp });
  }

  dadosNtnb = serie;

  // Valor atual
  if (serie.length > 0) {
    const ultimo = serie[serie.length - 1];
    document.getElementById("spread-atual-valor").textContent = ultimo.ytm.toFixed(2) + "% a.a.";
    document.getElementById("spread-ntnb-label").textContent =
      `NTN-B ${target}a atual`;
    document.getElementById("spread-atual-wrapper").style.display = "flex";
  }

  document.getElementById("spread-grafico-titulo").textContent =
    fiiSelecionado
      ? `${fiiSelecionado} vs NTN-B ${target} anos`
      : `NTN-B — Duration ${target} anos`;
  document.getElementById("spread-grafico-card").style.display = "block";

  atualizarSpreadAtual();

  // Resetar período
  document.querySelectorAll(".btn-periodo").forEach(b => b.classList.remove("ativo"));
  document.querySelector('[data-periodo="1A"]').classList.add("ativo");
  periodoAtivo = "1A";

  const { ntnb: ntnbC, fii: fiiC } = prepararSeries(periodoAtivo);
  renderizarGrafico(ntnbC, fiiC);
}

// ─── Interpolação ─────────────────────────────────────────────────────────────

function interpolarDia(ytmMap, durMap, targetAnos) {
  const pontos = [];
  for (const bond of Object.keys(ytmMap)) {
    const ytm    = ytmMap[bond];
    const durDias = durMap[bond];
    if (ytm == null || durDias == null) continue;
    pontos.push({ ytm, durAnos: durDias / 365 });
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.durAnos - b.durAnos);

  const minDur = pontos[0].durAnos;
  const maxDur = pontos[pontos.length - 1].durAnos;
  if (targetAnos < minDur || targetAnos > maxDur) return null;

  for (let i = 0; i < pontos.length - 1; i++) {
    const lo = pontos[i], hi = pontos[i + 1];
    if (lo.durAnos <= targetAnos && hi.durAnos >= targetAnos) {
      if (hi.durAnos === lo.durAnos) return lo.ytm;
      return lo.ytm + (targetAnos - lo.durAnos) / (hi.durAnos - lo.durAnos) * (hi.ytm - lo.ytm);
    }
  }
  return null;
}

// ─── Busca de FII ─────────────────────────────────────────────────────────────

function filtrarFiiSugestoes() {
  const q = document.getElementById("spread-fii-input").value.trim().toUpperCase();
  const lista = document.getElementById("spread-fii-sugestoes");
  indiceSugestao = -1;

  if (!q || q.length < 1) { lista.style.display = "none"; return; }

  const matches = todosOsFiis
    .filter(f => f.ticker.includes(q) || f.nome.toUpperCase().includes(q))
    .slice(0, 8);

  if (!matches.length) { lista.style.display = "none"; return; }

  lista.innerHTML = matches.map((f, i) =>
    `<div class="spread-sug-item" data-i="${i}" data-ticker="${f.ticker}"
          onmousedown="selecionarFii('${f.ticker}', '${f.nome.replace(/'/g,"\\'")}')">
       <span class="sug-ticker">${f.ticker}</span>
       <span class="sug-nome">${f.nome}</span>
     </div>`
  ).join("");
  lista.style.display = "block";
}

function navegarSugestoes(e) {
  const lista = document.getElementById("spread-fii-sugestoes");
  const items = lista.querySelectorAll(".spread-sug-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    indiceSugestao = Math.min(indiceSugestao + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    indiceSugestao = Math.max(indiceSugestao - 1, 0);
  } else if (e.key === "Enter" && indiceSugestao >= 0) {
    const el = items[indiceSugestao];
    selecionarFii(el.dataset.ticker, el.textContent.trim());
    e.preventDefault();
    return;
  } else if (e.key === "Escape") {
    lista.style.display = "none"; return;
  }
  items.forEach((el, i) => el.classList.toggle("ativo", i === indiceSugestao));
}

async function selecionarFii(ticker, nome) {
  document.getElementById("spread-fii-sugestoes").style.display = "none";
  document.getElementById("spread-fii-input").value = "";

  fiiSelecionado = ticker;
  document.getElementById("spread-fii-tag-nome").textContent = ticker;
  document.getElementById("spread-fii-tag").style.display    = "flex";

  // Carregar historico_dy do FII
  try {
    const resp = await fetch(`data/fiis/${ticker}.json`);
    const fiiJson = await resp.json();
    dadosFii = (fiiJson.historico_dy || []).map(([dt, dy]) => ({ date: dt, dy }));
  } catch {
    dadosFii = [];
  }

  document.getElementById("spread-grafico-titulo").textContent =
    `${ticker} vs NTN-B ${targetDuration} anos`;

  document.getElementById("spread-fii-dy-label").textContent = `${ticker} DY atual`;
  atualizarSpreadAtual();

  const { ntnb: ntnbS, fii: fiiS } = prepararSeries(periodoAtivo);
  renderizarGrafico(ntnbS, fiiS);
}

function removerFii() {
  fiiSelecionado = null;
  dadosFii = [];
  document.getElementById("spread-fii-tag").style.display = "none";
  document.getElementById("spread-fii-input").value = "";
  document.getElementById("spread-fii-atual-bloco").style.display   = "none";
  document.getElementById("spread-diferenca-bloco").style.display   = "none";
  document.getElementById("spread-grafico-titulo").textContent =
    `NTN-B — Duration ${targetDuration} anos`;

  const { ntnb: ntnbR, fii: fiiR } = prepararSeries(periodoAtivo);
  renderizarGrafico(ntnbR, fiiR);
}

function atualizarSpreadAtual() {
  if (!fiiSelecionado || !dadosFii.length) {
    document.getElementById("spread-fii-atual-bloco").style.display   = "none";
    document.getElementById("spread-diferenca-bloco").style.display   = "none";
    return;
  }
  const ultimoDy   = dadosFii[dadosFii.length - 1].dy;
  const ultimoNtnb = dadosNtnb.length ? dadosNtnb[dadosNtnb.length - 1].ytm : null;

  document.getElementById("spread-fii-atual-valor").textContent = ultimoDy.toFixed(2) + "% a.a.";
  document.getElementById("spread-fii-atual-bloco").style.display = "block";

  if (ultimoNtnb !== null) {
    const spread = ultimoDy - ultimoNtnb;
    const el = document.getElementById("spread-diferenca-valor");
    el.textContent = (spread >= 0 ? "+" : "") + spread.toFixed(2) + "pp";
    el.style.color = spread >= 0 ? "var(--verde)" : "var(--vermelho)";
    document.getElementById("spread-diferenca-bloco").style.display = "block";
  }
}

// ─── Período ──────────────────────────────────────────────────────────────────

function filtrarPorPeriodo(serie, periodo) {
  if (periodo === "MAX" || !serie.length) return serie;
  const ultima = new Date(serie[serie.length - 1].date);
  const corte  = new Date(ultima);
  corte.setFullYear(corte.getFullYear() - { "1A": 1, "3A": 3, "5A": 5 }[periodo]);
  return serie.filter(d => new Date(d.date) >= corte);
}

// Restringe ntnb ao intervalo de datas do FII quando ele está selecionado
function clampNtnbAoFii(serieNtnb, serieFii) {
  if (!serieFii.length) return serieNtnb;
  const minFii = serieFii[0].date;
  const maxFii = serieFii[serieFii.length - 1].date;
  return serieNtnb.filter(d => d.date >= minFii && d.date <= maxFii);
}

function prepararSeries(periodo) {
  const fiiPeriodo  = filtrarPorPeriodo(dadosFii,  periodo);
  const ntnbPeriodo = clampNtnbAoFii(filtrarPorPeriodo(dadosNtnb, periodo), fiiPeriodo);
  return { ntnb: ntnbPeriodo, fii: fiiPeriodo };
}

function filtrarPeriodoSpread(periodo) {
  periodoAtivo = periodo;
  document.querySelectorAll(".btn-periodo").forEach(b => {
    b.classList.toggle("ativo", b.dataset.periodo === periodo);
  });
  const { ntnb, fii } = prepararSeries(periodo);
  renderizarGrafico(ntnb, fii);
}

// ─── Gráfico ──────────────────────────────────────────────────────────────────

function renderizarGrafico(serieNtnb, serieFii) {
  const labelsNtnb = serieNtnb.map(d => d.date);
  const valNtnb    = serieNtnb.map(d => parseFloat(d.ytm.toFixed(4)));

  const datasets = [{
    label: `NTN-B ${targetDuration}a`,
    data:  valNtnb,
    borderColor: COR_NTNB,
    backgroundColor: COR_FUNDO,
    borderWidth: 1.5,
    pointRadius: 0,
    fill: true,
    tension: 0.2,
    yAxisID: "y"
  }];

  if (serieFii.length) {
    // Alinhar FII às mesmas labels da NTN-B para exibição no mesmo eixo
    const dyMap = Object.fromEntries(serieFii.map(d => [d.date, d.dy]));
    const valFii = labelsNtnb.map(dt => dyMap[dt] ?? null);

    datasets.push({
      label: `${fiiSelecionado} DY`,
      data:  valFii,
      borderColor: COR_FII,
      backgroundColor: "transparent",
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.2,
      spanGaps: true,
      yAxisID: "y"
    });
  }

  const escalaY = {
    ticks: {
      color: COR_NAVY,
      callback: v => v.toFixed(2) + "%"
    },
    grid: { color: "rgba(0,0,0,0.05)" }
  };

  if (grafico) { grafico.destroy(); grafico = null; }

  const ctx = document.getElementById("grafico-spread").getContext("2d");
  grafico = new Chart(ctx, {
    type: "line",
    data: { labels: labelsNtnb, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: COR_NAVY, boxWidth: 14, font: { size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y !== null ? ctx.parsed.y.toFixed(2) + "%" : "—"}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: COR_NAVY, maxTicksLimit: 8, maxRotation: 0 },
          grid:  { color: "rgba(0,0,0,0.05)" }
        },
        y: escalaY
      }
    }
  });

  // Gráfico 2: spread diário
  renderizarGraficoDiff(serieNtnb, serieFii);
}

function renderizarGraficoDiff(serieNtnb, serieFii) {
  const diffCard = document.getElementById("spread-diff-card");

  if (!fiiSelecionado || !serieFii.length) {
    diffCard.style.display = "none";
    return;
  }

  diffCard.style.display = "flex";
  document.getElementById("spread-diff-titulo").textContent =
    `Spread — ${fiiSelecionado} DY − NTN-B ${targetDuration}a`;

  // Calcular spread por data (apenas datas com os dois valores)
  const ntnbMap = Object.fromEntries(serieNtnb.map(d => [d.date, d.ytm]));
  const dyMap   = Object.fromEntries(serieFii.map(d  => [d.date, d.dy]));

  const labels = [];
  const valores = [];
  for (const dt of serieNtnb.map(d => d.date)) {
    const ntnb = ntnbMap[dt];
    const dy   = dyMap[dt];
    if (ntnb == null || dy == null) continue;
    labels.push(dt);
    valores.push(parseFloat((dy - ntnb).toFixed(4)));
  }

  // Média
  const media = valores.length
    ? parseFloat((valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(4))
    : 0;
  const linhaMedia = new Array(valores.length).fill(media);

  // Cor da área: positivo = verde, negativo = vermelho
  const corArea = media >= 0 ? "rgba(14,159,110,0.1)" : "rgba(224,36,36,0.1)";
  const corLinha = media >= 0 ? "var(--verde)" : "var(--vermelho)";

  const datasets = [
    {
      label: "Spread (pp)",
      data: valores,
      borderColor: COR_NAVY,
      backgroundColor: corArea,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: true,
      tension: 0.2,
    },
    {
      label: `Média (${media >= 0 ? "+" : ""}${media.toFixed(2)}pp)`,
      data: linhaMedia,
      borderColor: COR_NTNB,
      backgroundColor: "transparent",
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
    }
  ];

  if (graficoDiff) { graficoDiff.destroy(); graficoDiff = null; }
  {
    const ctx = document.getElementById("grafico-spread-diff").getContext("2d");
    graficoDiff = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      animation: false,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: COR_NAVY, boxWidth: 14, font: { size: 12 } }
          },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y !== null ? (ctx.parsed.y >= 0 ? "+" : "") + ctx.parsed.y.toFixed(2) + "pp" : "—"}`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: COR_NAVY, maxTicksLimit: 8, maxRotation: 0 },
            grid:  { color: "rgba(0,0,0,0.05)" }
          },
          y: {
            ticks: {
              color: COR_NAVY,
              callback: v => (v >= 0 ? "+" : "") + v.toFixed(2) + "pp"
            },
            grid: { color: "rgba(0,0,0,0.05)" }
          }
        }
      }
    });
  }
}

inicializar();
