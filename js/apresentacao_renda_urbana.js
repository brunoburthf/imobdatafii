// apresentacao_renda_urbana.js — deck dedicado do setor Tijolo Multissetorial
// (Renda Urbana). Slides: capa, visao geral (KPIs), tabela comparativa,
// vacancia (barras), alavancagem LTV (barras). Navegacao + export PNG.

let _slides = [], _idx = 0, _charts = [];

async function carregar() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const [fund, setoresDoc] = await Promise.all([
      fetch(`data/fundamentos_renda_urbana.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/setores.json?v=${v}`).then(r => r.ok ? r.json() : null),
    ]);
    if (!fund) throw new Error("fundamentos_renda_urbana.json indisponível.");

    const stage = document.getElementById("ap-stage");
    construirCapa(stage, fund);
    construirVisaoGeral(stage, fund, setoresDoc);
    construirTabela(stage, fund);
    construirGraficoMetrica(stage, fund, "vacancia", "Vacância física estimada por fundo",
      "%", "#1c6bbd", true);
    construirGraficoMetrica(stage, fund, "ltv", "Alavancagem (LTV) por fundo",
      "%", "#EF6300", false);
    if (fund.ltv_historico_ifix && fund.ltv_historico_ifix.length)
      construirLtvHistorico(stage, fund);

    _slides = Array.from(stage.querySelectorAll(".ap-slide"));
    document.getElementById("loading").style.display = "none";
    stage.style.display = "flex";
    document.getElementById("ap-nav").style.display = "flex";
    ativar(0); escala();
    window.addEventListener("resize", escala);
    nav();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block"; el.textContent = "Erro: " + e.message;
  }
}

// ── Helpers ──
const pct = (v, d = 1) => v == null ? "—" : (v * 100).toFixed(d) + "%";
const xVP = v => v == null ? "—" : v.toFixed(2) + "x";
const media = a => { const x = a.filter(v => v != null); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };

function novoSlide(stage, cls) {
  const el = document.createElement("div");
  el.className = "ap-slide" + (cls ? " " + cls : "");
  stage.appendChild(el);
  return el;
}

// ── Capa ──
function construirCapa(stage, fund) {
  const el = novoSlide(stage, "ap-capa");
  el.innerHTML = `
    <div class="ap-capa-logo">ImobData</div>
    <div class="ap-capa-kicker">Apresentação por setor</div>
    <h1 class="ap-capa-titulo">Renda Urbana</h1>
    <div class="ap-capa-sub">Tijolo Multissetorial — ${fund.agregado.n_fundos} fundos. Vacância, alavancagem (LTV), yield e valuation.</div>
    <div class="ap-capa-rodape">
      <span>Uso interno</span>
      <span>LTV ref. ${fund.data_ref_ltv || "—"}</span>
    </div>`;
}

// ── Visão geral (KPIs) ──
function construirVisaoGeral(stage, fund, setoresDoc) {
  const ag = fund.agregado;
  const tabRow = ((setoresDoc && setoresDoc.tabela) || []).find(r => r.Setor === fund.setor) || {};
  const dy = tabRow.DY ?? media(fund.fundos.map(f => f.dy_aa));
  const pvp = tabRow["P/VP"] ?? media(fund.fundos.map(f => f.pvp));
  const ifix = tabRow["% do IFIX"];
  const ret = media(fund.fundos.map(f => f.retorno_12m));

  const el = novoSlide(stage);
  el.innerHTML = `
    <div class="ap-shead">
      <div class="ap-shead-left">
        <span class="ap-shead-kicker">Renda Urbana</span>
        <span class="ap-shead-titulo">Visão geral do setor</span>
      </div>
      <div class="ap-shead-badges">
        <div class="ap-badge"><div class="ap-badge-num">${ag.n_fundos}</div><div class="ap-badge-lbl">Fundos</div></div>
        <div class="ap-badge"><div class="ap-badge-num">${pct(ifix, 1)}</div><div class="ap-badge-lbl">do IFIX</div></div>
      </div>
    </div>
    <div class="ap-body">
      <div class="ap-kpis">
        <div class="ap-kpi" style="--cor:#EF6300"><div class="ap-kpi-lbl">DY médio (a.a.)</div><div class="ap-kpi-val">${pct(dy, 1)}</div></div>
        <div class="ap-kpi" style="--cor:#1c6bbd"><div class="ap-kpi-lbl">P/VP médio</div><div class="ap-kpi-val">${xVP(pvp)}</div></div>
        <div class="ap-kpi" style="--cor:${ret >= 0 ? '#0e9f6e' : '#dc2626'}"><div class="ap-kpi-lbl">Retorno 12M médio</div><div class="ap-kpi-val">${ret == null ? "—" : (ret >= 0 ? "+" : "") + (ret * 100).toFixed(1) + "%"}</div></div>
        <div class="ap-kpi" style="--cor:#1c6bbd"><div class="ap-kpi-lbl">Vacância média (estim.)</div><div class="ap-kpi-val">${pct(ag.vacancia_media, 1)}</div><div class="ap-kpi-sub">ponderada por área dos imóveis</div></div>
        <div class="ap-kpi" style="--cor:#EF6300"><div class="ap-kpi-lbl">Alavancagem (LTV) média</div><div class="ap-kpi-val">${pct(ag.ltv_ponderado, 1)}</div><div class="ap-kpi-sub">dívida ÷ valor dos imóveis (ponderado)</div></div>
        <div class="ap-kpi" style="--cor:#7c3aed"><div class="ap-kpi-lbl">Nº de fundos</div><div class="ap-kpi-val">${ag.n_fundos}</div></div>
      </div>
      <p class="ap-nota">Vacância: estimativa ponderada por área a partir da carteira de imóveis (informe CVM). LTV: CVM informe mensal — (obrigações por aquisição + securitização) ÷ valor dos imóveis, ref. ${fund.data_ref_ltv || "—"}.</p>
    </div>`;
}

// ── Tabela comparativa ──
function construirTabela(stage, fund) {
  const fundos = [...fund.fundos].sort((a, b) => (b.dy_aa || 0) - (a.dy_aa || 0));
  const linhas = fundos.map(f => {
    const ret = f.retorno_12m;
    const cls = ret > 0 ? "ap-pos" : ret < 0 ? "ap-neg" : "";
    const sinal = ret > 0 ? "+" : "";
    return `<tr>
      <td>${f.ticker}</td>
      <td>${xVP(f.pvp)}</td>
      <td>${pct(f.dy_aa, 1)}</td>
      <td class="${cls}">${ret == null ? "—" : sinal + (ret * 100).toFixed(1) + "%"}</td>
      <td>${f.vacancia == null ? '<span class="ap-muted">—</span>' : pct(f.vacancia, 1)}</td>
      <td>${f.ltv == null ? '<span class="ap-muted">—</span>' : pct(f.ltv, 1)}</td>
    </tr>`;
  }).join("");

  const el = novoSlide(stage);
  el.innerHTML = `
    <div class="ap-shead">
      <div class="ap-shead-left">
        <span class="ap-shead-kicker">Renda Urbana</span>
        <span class="ap-shead-titulo">Comparativo dos fundos</span>
      </div>
    </div>
    <div class="ap-body">
      <table class="ap-tab">
        <thead><tr><th>FII</th><th>P/VP</th><th>DY a.a.</th><th>Retorno 12M</th><th>Vacância*</th><th>LTV</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      <p class="ap-nota">* Vacância = estimativa ponderada por área (carteira de imóveis). LTV via CVM informe mensal, ref. ${fund.data_ref_ltv || "—"}. Ordenado por DY a.a.</p>
    </div>`;
}

// ── Gráfico de barras de uma métrica (vacancia ou ltv) ──
function construirGraficoMetrica(stage, fund, campo, titulo, unidade, cor, soPositivo) {
  const dados = fund.fundos
    .filter(f => f[campo] != null)
    .sort((a, b) => b[campo] - a[campo]);
  const labels = dados.map(f => f.ticker);
  const valores = dados.map(f => +(f[campo] * 100).toFixed(2));

  const el = novoSlide(stage);
  const id = "chart-" + campo;
  el.innerHTML = `
    <div class="ap-shead">
      <div class="ap-shead-left">
        <span class="ap-shead-kicker">Renda Urbana</span>
        <span class="ap-shead-titulo">${campo === "vacancia" ? "Vacância" : "Alavancagem (LTV)"}</span>
      </div>
    </div>
    <div class="ap-body">
      <div class="ap-lower">
        <div class="ap-chart-titulo">${titulo}</div>
        <div class="ap-chart-wrap"><canvas id="${id}"></canvas></div>
      </div>
      <p class="ap-nota">${campo === "vacancia"
        ? "Estimativa ponderada por área a partir da carteira de imóveis (informe CVM). Não é a taxa oficial reportada pelo gestor."
        : "Dívida financeira (obrigações por aquisição + securitização) ÷ valor dos imóveis. CVM informe mensal, ref. " + (fund.data_ref_ltv || "—") + "."}</p>
    </div>`;
  stage.appendChild(el);

  const ctx = el.querySelector("#" + id).getContext("2d");
  _charts.push(new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: valores, backgroundColor: cor, borderRadius: 5 }] },
    options: {
      responsive: true, maintainAspectRatio: false, devicePixelRatio: 2, animation: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.parsed.y.toFixed(1)}${unidade}` } } },
      scales: {
        x: { ticks: { color: "#1c2b3a", font: { size: 17, weight: "600" } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#6b7a8d", font: { size: 16 }, callback: v => v + unidade },
             grid: { color: "#eef0f4" } },
      },
    },
  }));
}

// ── LTV histórico do setor (ponderado por IFIX) ──
function construirLtvHistorico(stage, fund) {
  const serie = fund.ltv_historico_ifix;
  const labels = serie.map(p => p.mes);
  const ifix = serie.map(p => +(p.ltv_ifix * 100).toFixed(2));
  const simples = serie.map(p => +(p.ltv_simples * 100).toFixed(2));
  const atual = fund.agregado.ltv_ponderado_ifix;

  const el = novoSlide(stage);
  el.innerHTML = `
    <div class="ap-shead">
      <div class="ap-shead-left">
        <span class="ap-shead-kicker">Renda Urbana</span>
        <span class="ap-shead-titulo">Alavancagem histórica do setor</span>
      </div>
      <div class="ap-shead-badges">
        <div class="ap-badge"><div class="ap-badge-num">${pct(atual, 1)}</div><div class="ap-badge-lbl">LTV atual (IFIX)</div></div>
      </div>
    </div>
    <div class="ap-body">
      <div class="ap-lower">
        <div class="ap-chart-titulo">LTV do setor — ponderado por peso no IFIX (linha) vs média simples (tracejado)</div>
        <div class="ap-chart-wrap"><canvas id="chart-ltvhist"></canvas></div>
      </div>
      <p class="ap-nota">LTV mensal de cada fundo (CVM informe) ponderado pelo peso no IFIX. Constituintes atuais do setor traçados para trás (current-constituents). Fundos de maior peso (ex.: TRXF) puxam a média ponderada. Desde ${labels[0]}.</p>
    </div>`;
  stage.appendChild(el);

  const ctx = el.querySelector("#chart-ltvhist").getContext("2d");
  _charts.push(new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [
      { label: "LTV ponderado IFIX", data: ifix, borderColor: "#EF6300",
        backgroundColor: "#EF630022", borderWidth: 3, pointRadius: 0, tension: 0.15, fill: true },
      { label: "LTV média simples", data: simples, borderColor: "#1c6bbd",
        borderWidth: 2, borderDash: [6, 5], pointRadius: 0, tension: 0.15, fill: false },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, devicePixelRatio: 2, animation: false,
      plugins: { legend: { display: true, position: "top", align: "end",
                   labels: { boxWidth: 18, boxHeight: 3, font: { size: 15 }, color: "#1c2b3a" } },
                 tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: "#6b7a8d", font: { size: 15 },
             callback(v){ const s = this.getLabelForValue(v); return s || s; } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#6b7a8d", font: { size: 16 }, callback: v => v + "%" },
             grid: { color: "#eef0f4" } },
      },
    },
  }));
}

// ── Navegação / escala / export ──
function ativar(n) {
  _idx = Math.max(0, Math.min(n, _slides.length - 1));
  _slides.forEach((s, k) => s.classList.toggle("ativo", k === _idx));
  document.getElementById("ap-contador").textContent = `${_idx + 1} / ${_slides.length}`;
  document.getElementById("ap-prev").disabled = _idx === 0;
  document.getElementById("ap-next").disabled = _idx === _slides.length - 1;
}
function escala() {
  const st = document.getElementById("ap-stage");
  const e = Math.min(st.clientWidth / 1280, st.clientHeight / 720) * 0.94;
  _slides.forEach(s => s.style.transform = `scale(${e})`);
}
function nav() {
  document.getElementById("ap-prev").addEventListener("click", () => ativar(_idx - 1));
  document.getElementById("ap-next").addEventListener("click", () => ativar(_idx + 1));
  document.getElementById("ap-export").addEventListener("click", exportar);
  document.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") ativar(_idx - 1);
    if (e.key === "ArrowRight" || e.key === " ") { ativar(_idx + 1); e.preventDefault(); }
  });
}
async function exportar() {
  const slide = _slides[_idx], btn = document.getElementById("ap-export"),
        lbl = document.getElementById("ap-export-lbl"), orig = lbl.textContent;
  const fb = (t, ok) => { lbl.textContent = t; btn.classList.toggle("ok", !!ok);
    clearTimeout(btn._t); btn._t = setTimeout(() => { lbl.textContent = orig; btn.classList.remove("ok"); }, 2200); };
  try {
    const canvas = await html2canvas(slide, { width: 1280, height: 720, scale: 2,
      backgroundColor: "#ffffff", windowWidth: 1280, windowHeight: 720 });
    await new Promise((res, rej) => canvas.toBlob(async b => {
      if (!b) return rej(new Error("toBlob"));
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); fb("✓ Copiado", true);
        } else throw new Error("no clipboard");
        res();
      } catch {
        const a = document.createElement("a"); a.href = canvas.toDataURL("image/png");
        a.download = `renda-urbana-${_idx}.png`; a.click(); fb("↓ Baixado", true); res();
      }
    }, "image/png"));
  } catch (e) { console.warn(e); fb("✕ Falhou", false); }
}

document.addEventListener("DOMContentLoaded", carregar);
