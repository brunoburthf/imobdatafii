// copom_curva.js — pagina Interno > COPOM x Curva NTN-B.
// Consome data/estudo_copom_curva.json + data/selic/serie_diaria.json
// + data/ntnb/curva_diaria.json e renderiza resumo + tabela + 2 graficos.

let _estudo = null;
let _selic = null;
let _curva = null;
let _setores = null;
let _definicaoAtiva = "pt";  // "pt" = peak-to-trough, "es" = estrito

async function carregar() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const [estudo, selic, curva, setores] = await Promise.all([
      fetch(`data/estudo_copom_curva.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/selic/serie_diaria.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/ntnb/curva_diaria.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/estudo_setores_copom.json?v=${v}`).then(r => r.ok ? r.json() : null),
    ]);
    if (!estudo) throw new Error("estudo_copom_curva.json não disponível.");
    _estudo = estudo;
    _selic = selic;
    _curva = curva;
    _setores = setores;

    renderResumo();
    renderTransmissao();
    renderTabela();
    if (_setores) renderSetores();
    renderTimeline();

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Erro: " + e.message;
  }
}

// ── Setores: histórico (estático) ────────────────────────────────────
function renderSetores() {
  const setores = setoresOrdenados();
  const histBody = document.getElementById("cc-setores-hist-body");
  histBody.innerHTML = "";

  for (const [nome, info] of setores) {
    const d = info.delta_medio_historico;
    const n = info.n_ciclos_amostra.preco;
    const trH = document.createElement("tr");
    trH.innerHTML = `
      <td>${nome}</td>
      <td>${info.n_fiis_atuais}</td>
      <td>${n}</td>
      <td>${fmtDelta(d.preco_pct, 1)}</td>
      <td>${fmtDelta(d.pvp_pct, 1)}</td>
      <td>${fmtDelta(d.spread_pp, 2)}</td>
    `;
    histBody.appendChild(trH);
  }

  // Render inicial da simulação
  atualizarSimulacao();
}

function setoresOrdenados() {
  return Object.entries(_setores.setores)
    .sort((a, b) => {
      const dA = a[1].delta_medio_historico.preco_pct;
      const dB = b[1].delta_medio_historico.preco_pct;
      if (dA === null) return 1;
      if (dB === null) return -1;
      return dB - dA;
    });
}

// ── Simulação interativa por setor ────────────────────────────────────
function atualizarSimulacao() {
  if (!_setores) return;
  const inp = document.getElementById("cc-sim-input");
  let queda = parseFloat(inp.value);
  if (isNaN(queda) || queda < 0) queda = 0;
  if (queda > 20) queda = 20;

  const setores = setoresOrdenados();
  const tbody = document.getElementById("cc-setores-prev-body");
  tbody.innerHTML = "";

  for (const [nome, info] of setores) {
    const e = info.estado_atual;
    const s = info.sensibilidade_por_pp_queda;

    // Δ projetado = sensibilidade × queda (queda em pp positivo)
    const dPrecoPct  = (s.preco_pct  !== null) ? s.preco_pct  * queda : null;
    const dPvpPct    = (s.pvp_pct    !== null) ? s.pvp_pct    * queda : null;
    const dSpreadPp  = (s.spread_pp  !== null) ? s.spread_pp  * queda : null;

    const precoProj  = (e.preco_medio    !== null && dPrecoPct  !== null)
                        ? e.preco_medio    * (1 + dPrecoPct / 100) : null;
    const pvpProj    = (e.pvp_medio      !== null && dPvpPct    !== null)
                        ? e.pvp_medio      * (1 + dPvpPct   / 100) : null;
    const spreadProj = (e.spread_medio_pp !== null && dSpreadPp !== null)
                        ? e.spread_medio_pp + dSpreadPp : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${nome}</td>
      <td>${fmtNum(e.preco_medio,    2)}</td>
      <td>${fmtNum(precoProj,        2)}</td>
      <td>${fmtDelta(dPrecoPct,      1)}</td>
      <td>${fmtNum(e.pvp_medio,      2)}</td>
      <td>${fmtNum(pvpProj,          2)}</td>
      <td>${fmtDelta(dPvpPct,        1)}</td>
      <td>${fmtNum(e.spread_medio_pp, 2)}</td>
      <td>${fmtNum(spreadProj,       2)}</td>
      <td>${fmtDelta(dSpreadPp,      2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function setSim(v) {
  document.getElementById("cc-sim-input").value = v;
  atualizarSimulacao();
}

// ── KPIs de resumo (4 cards) ──────────────────────────────────────────
function renderResumo() {
  const r = _estudo.resumo_medias_peak_to_trough;
  document.getElementById("cc-kpi-trans-2a").textContent  = fmtKpi(r.ytm_2a.transmissao,  2, "pp");
  document.getElementById("cc-kpi-trans-12a").textContent = fmtKpi(r.ytm_12a.transmissao, 2, "pp");
  document.getElementById("cc-kpi-slope").textContent     = fmtKpi(r.slope_12a_2a.pre_fim, 2, "pp", true);
  document.getElementById("cc-kpi-curv").textContent      = fmtKpi(r.curvature.pre_fim,    2, "pp", true);
}

function fmtKpi(v, dec, unit, comSinal) {
  if (v === null || v === undefined) return "—";
  const sinal = comSinal && v > 0 ? "+" : "";
  return `${sinal}${v.toFixed(dec)}${unit ? " " + unit : ""}`;
}

// ── Bar chart de transmissao por prazo ────────────────────────────────
function renderTransmissao() {
  const r = _estudo.resumo_medias_peak_to_trough;
  const labels = ["2 anos", "5 anos", "10 anos", "12 anos"];
  const data = [
    r.ytm_2a.transmissao,
    r.ytm_5a.transmissao,
    r.ytm_10a.transmissao,
    r.ytm_12a.transmissao,
  ];

  // Gradiente laranja → azul claro (curto → longo) refletindo "transmissão cai com prazo"
  const cores = [
    "rgba(239, 99, 0, 0.85)",     // 2a — laranja forte
    "rgba(239, 99, 0, 0.60)",     // 5a
    "rgba(28, 107, 189, 0.65)",   // 10a — azul claro
    "rgba(28, 107, 189, 0.50)",   // 12a
  ];

  new Chart(document.getElementById("cc-grafico-transmissao"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Transmissão (Δ NTN-B / Δ Selic)",
        data,
        backgroundColor: cores,
        borderColor: cores.map(c => c.replace(/[\d.]+\)$/, "1)")),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(0,9,60,0.95)",
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
          padding: 10,
          callbacks: {
            label: (ctx) => `Transmissão: ${ctx.parsed.y?.toFixed(3)}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true, max: 1,
          grid: { color: "#eef0f4" },
          ticks: { callback: (v) => v.toFixed(2), color: "#6b7a8d", font: { size: 11 } },
        },
        x: {
          grid: { display: false },
          ticks: { color: "#1c2b3a", font: { size: 12, weight: "500" } },
        },
      },
    },
  });
}

// ── Tabela de ciclos ──────────────────────────────────────────────────
function selecionarDefinicao(def) {
  _definicaoAtiva = def;
  document.getElementById("cc-btn-pt").classList.toggle("ativo", def === "pt");
  document.getElementById("cc-btn-es").classList.toggle("ativo", def === "es");
  renderTabela();
}

function ciclosAtivos() {
  return _definicaoAtiva === "pt"
    ? _estudo.estudo_peak_to_trough
    : _estudo.estudo_estritos;
}

function resumoAtivo() {
  return _definicaoAtiva === "pt"
    ? _estudo.resumo_medias_peak_to_trough
    : _estudo.resumo_medias_estritos;
}

function renderTabela() {
  const ciclos = ciclosAtivos();
  const tbody = document.getElementById("cc-tabela-body");
  tbody.innerHTML = "";

  document.getElementById("cc-toggle-info").innerHTML =
    `${ciclos.length} ciclos. Cada linha mostra Δ YTM (T<sub>fim</sub> − T<sub>−90d</sub>) por maturidade.`;

  for (const c of ciclos) {
    const d2  = c.deltas.ytm_2a.pre_fim;
    const d5  = c.deltas.ytm_5a.pre_fim;
    const d10 = c.deltas.ytm_10a.pre_fim;
    const d12 = c.deltas.ytm_12a.pre_fim;
    const ds  = c.deltas.slope_12a_2a.pre_fim;
    const t10 = c.deltas.ytm_10a.transmissao;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.data_inicio}</td>
      <td>${c.data_fim}</td>
      <td>${c.n_cortes}</td>
      <td>${fmtDelta(c.delta_selic_pp)}</td>
      <td>${fmtDelta(d2)}</td>
      <td>${fmtDelta(d5)}</td>
      <td>${fmtDelta(d10)}</td>
      <td>${fmtDelta(d12)}</td>
      <td>${fmtDelta(ds)}</td>
      <td>${fmtNum(t10, 2)}</td>
    `;
    tbody.appendChild(tr);
  }

  // Linha de medias
  const r = resumoAtivo();
  const medRow = document.getElementById("cc-medias-row");
  medRow.innerHTML = `
    <td colspan="3">Média (ciclos com dado NTN-B)</td>
    <td>—</td>
    <td>${fmtDelta(r.ytm_2a.pre_fim)}</td>
    <td>${fmtDelta(r.ytm_5a.pre_fim)}</td>
    <td>${fmtDelta(r.ytm_10a.pre_fim)}</td>
    <td>${fmtDelta(r.ytm_12a.pre_fim)}</td>
    <td>${fmtDelta(r.slope_12a_2a.pre_fim)}</td>
    <td>${fmtNum(r.ytm_10a.transmissao, 2)}</td>
  `;
}

// ── Timeline (Selic + curva 5a/10a + bandas dos ciclos) ───────────────
function renderTimeline() {
  if (!_selic || !_curva) return;

  // Amostragem mensal pra performance (curva tem 5300+ pontos)
  const passo = 5;   // 1 ponto a cada 5 dias uteis ~ semanal
  const datas = [];
  const selicMeta = [];
  const ytm5a = [];
  const ytm10a = [];

  // Indice Selic por data
  const selicMap = new Map();
  for (const p of _selic.serie) {
    if (p.meta !== null) selicMap.set(p.data, p.meta);
  }

  const curvaSerie = _curva.serie.filter((_, i) => i % passo === 0);
  for (const p of curvaSerie) {
    datas.push(p.data);
    selicMeta.push(selicMap.get(p.data) ?? null);
    ytm5a.push(p.ytm_5a);
    ytm10a.push(p.ytm_10a);
  }

  // Forward-fill da Selic Meta pra dias sem dado
  let last = null;
  for (let i = 0; i < selicMeta.length; i++) {
    if (selicMeta[i] !== null) last = selicMeta[i];
    else selicMeta[i] = last;
  }

  // Bandas dos ciclos peak-to-trough (annotation via dataset extra)
  // Como Chart.js nao suporta annotations nativo, simulo com dataset de barras
  // verticais discretas ou usando background colorido no plugin.
  // Simplificacao: desenho areas verdes com canvas afterDraw.
  const bandas = _estudo.estudo_peak_to_trough.map(c => ({
    inicio: c.data_inicio, fim: c.data_fim,
  }));

  const bandaPlugin = {
    id: "bandas",
    beforeDraw(chart) {
      const { ctx, chartArea, scales: { x } } = chart;
      ctx.save();
      ctx.fillStyle = "rgba(239, 99, 0, 0.07)";   // banda laranja sutil (cor do site)
      for (const b of bandas) {
        const x0 = x.getPixelForValue(b.inicio);
        const x1 = x.getPixelForValue(b.fim);
        if (isFinite(x0) && isFinite(x1) && x1 > x0) {
          ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
        }
      }
      ctx.restore();
    },
  };

  new Chart(document.getElementById("cc-grafico-timeline"), {
    type: "line",
    data: {
      labels: datas,
      datasets: [
        {
          label: "Selic Meta",
          data: selicMeta,
          borderColor: "rgb(0, 9, 60)",            // navy
          backgroundColor: "rgb(0, 9, 60)",
          borderWidth: 2, pointRadius: 0, tension: 0.05,
        },
        {
          label: "NTN-B 5a",
          data: ytm5a,
          borderColor: "rgb(239, 99, 0)",           // laranja
          backgroundColor: "rgb(239, 99, 0)",
          borderWidth: 1.5, pointRadius: 0, tension: 0.05,
        },
        {
          label: "NTN-B 10a",
          data: ytm10a,
          borderColor: "rgb(28, 107, 189)",         // azul claro
          backgroundColor: "rgb(28, 107, 189)",
          borderWidth: 1.5, pointRadius: 0, tension: 0.05,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top", align: "end",
          labels: { boxWidth: 14, boxHeight: 4, font: { size: 12 }, color: "#1c2b3a" },
        },
        tooltip: {
          backgroundColor: "rgba(0,9,60,0.95)",
          padding: 10,
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)}%`,
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, color: "#6b7a8d", font: { size: 11 } },
          grid: { color: "#eef0f4" },
        },
        y: {
          ticks: {
            callback: (v) => v.toFixed(0) + "%",
            color: "#6b7a8d", font: { size: 11 },
          },
          grid: { color: "#eef0f4" },
        },
      },
    },
    plugins: [bandaPlugin],
  });
}

// ── Formatters ────────────────────────────────────────────────────────
function fmt(v, dec, sinal) {
  if (v === null || v === undefined) return "—";
  const s = v.toFixed(dec);
  return sinal && v > 0 ? "+" + s : s;
}

function fmtNum(v, dec) {
  if (v === null || v === undefined) return `<span class="cc-nulo">—</span>`;
  return v.toFixed(dec);
}

function fmtDelta(v, dec = 2) {
  if (v === null || v === undefined) return `<span class="cc-nulo">—</span>`;
  const cls = v < 0 ? "cc-negativo" : v > 0 ? "cc-positivo" : "cc-neutro";
  const sinal = v > 0 ? "+" : "";
  return `<span class="${cls}">${sinal}${v.toFixed(dec)}</span>`;
}

document.addEventListener("DOMContentLoaded", carregar);
