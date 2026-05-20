// apresentacao_setores.js — deck de slides (16:9) por setor de FII, base pra
// PowerPoint. Capa + 1 slide por setor (>=10 FIIs), com KPIs grandes, grafico
// de DY historico e tabela de FIIs. Navegacao por setas/botoes + export PNG.

// Setores com >=10 FIIs, ordenados por % do IFIX (mais relevante primeiro).
const SETORES = [
  "Crédito Imobiliário",
  "Logística",
  "Tijolo Multissetorial",
  "Shoppings",
  "FOFs/Hedge Funds",
  "Escritórios",
];

const CORES = ["#EF6300", "#1c6bbd", "#0e9f6e", "#7c3aed", "#00093C", "#d4a017"];

let _slides = [];        // elementos .ap-slide
let _idx = 0;            // slide ativo
let _charts = [];

async function carregar() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const [setoresDoc, idxDoc] = await Promise.all([
      fetch(`data/setores.json?v=${v}`).then(r => r.ok ? r.json() : null),
      fetch(`data/index.json?v=${v}`).then(r => r.ok ? r.json() : null),
    ]);
    if (!setoresDoc || !idxDoc) throw new Error("setores.json ou index.json indisponível.");

    const stage = document.getElementById("ap-stage");
    construirCapa(stage, setoresDoc);
    SETORES.forEach((setor, i) => construirSlideSetor(stage, setor, i, setoresDoc, idxDoc));

    _slides = Array.from(stage.querySelectorAll(".ap-slide"));
    document.getElementById("loading").style.display = "none";
    stage.style.display = "flex";
    document.getElementById("ap-nav").style.display = "flex";

    ativarSlide(0);
    ajustarEscala();
    window.addEventListener("resize", ajustarEscala);
    configurarNav();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Erro: " + e.message;
  }
}

// ── Helpers de dados ──────────────────────────────────────────────────
function fiisDoSetor(setor, idxDoc) {
  return idxDoc.fiis.filter(f => f.Setor === setor);
}
function media(arr) {
  const v = arr.filter(x => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
const pct = (v, d = 1) => v == null ? "—" : (v * 100).toFixed(d) + "%";
const xVP = (v) => v == null ? "—" : v.toFixed(2) + "x";

// ── Capa ──────────────────────────────────────────────────────────────
function construirCapa(stage, setoresDoc) {
  const data = setoresDoc.atualizado_em || "";
  const el = document.createElement("div");
  el.className = "ap-slide ap-capa ativo";
  el.innerHTML = `
    <div class="ap-capa-logo">ImobData</div>
    <h1 class="ap-capa-titulo">Setores de <span class="laranja">FIIs</span></h1>
    <div class="ap-capa-sub">Panorama por segmento — yield, valuation e performance dos fundos imobiliários por setor.</div>
    <div class="ap-capa-rodape">
      <span>Uso interno</span>
      <span>Dados de ${data}</span>
    </div>`;
  stage.appendChild(el);
}

// ── Slide de setor ─────────────────────────────────────────────────────
function construirSlideSetor(stage, setor, i, setoresDoc, idxDoc) {
  const cor = CORES[i % CORES.length];
  const tabRow = (setoresDoc.tabela || []).find(r => r.Setor === setor) || {};
  const fiis = fiisDoSetor(setor, idxDoc);

  const dyMed   = tabRow.DY ?? media(fiis.map(f => f["DY a.a."]));
  const pvpMed  = tabRow["P/VP"] ?? media(fiis.map(f => f["P/VP"]));
  const ifix    = tabRow["% do IFIX"];
  const retMed  = media(fiis.map(f => f["Retorno - 12M"]));

  // Top FIIs por DY a.a. (desc), ate 7
  const topFiis = [...fiis]
    .filter(f => f["DY a.a."] != null)
    .sort((a, b) => (b["DY a.a."] || 0) - (a["DY a.a."] || 0))
    .slice(0, 7);

  const linhas = topFiis.map(f => {
    const ret = f["Retorno - 12M"];
    const cls = ret > 0 ? "ap-pos" : ret < 0 ? "ap-neg" : "";
    const sinal = ret > 0 ? "+" : "";
    return `<tr>
      <td>${f.Ticker}</td>
      <td>${xVP(f["P/VP"])}</td>
      <td>${pct(f["DY a.a."], 1)}</td>
      <td class="${cls}">${ret == null ? "—" : sinal + (ret * 100).toFixed(1) + "%"}</td>
    </tr>`;
  }).join("");

  const el = document.createElement("div");
  el.className = "ap-slide";
  el.innerHTML = `
    <div class="ap-shead">
      <div class="ap-shead-left">
        <span class="ap-shead-kicker">Setor</span>
        <span class="ap-shead-titulo">${setor}</span>
      </div>
      <div class="ap-shead-badges">
        <div class="ap-badge"><div class="ap-badge-num">${fiis.length}</div><div class="ap-badge-lbl">FIIs</div></div>
        <div class="ap-badge"><div class="ap-badge-num">${pct(ifix, 1)}</div><div class="ap-badge-lbl">do IFIX</div></div>
      </div>
    </div>
    <div class="ap-body">
      <div class="ap-kpis">
        <div class="ap-kpi" style="--cor:${CORES[0]}">
          <div class="ap-kpi-lbl">DY médio (a.a.)</div>
          <div class="ap-kpi-val">${pct(dyMed, 1)}</div>
        </div>
        <div class="ap-kpi" style="--cor:${CORES[1]}">
          <div class="ap-kpi-lbl">P/VP médio</div>
          <div class="ap-kpi-val">${xVP(pvpMed)}</div>
        </div>
        <div class="ap-kpi" style="--cor:${retMed >= 0 ? CORES[2] : '#dc2626'}">
          <div class="ap-kpi-lbl">Retorno 12M médio</div>
          <div class="ap-kpi-val">${retMed == null ? "—" : (retMed >= 0 ? "+" : "") + (retMed * 100).toFixed(1) + "%"}</div>
        </div>
        <div class="ap-kpi" style="--cor:${CORES[3]}">
          <div class="ap-kpi-lbl">Nº de fundos</div>
          <div class="ap-kpi-val">${fiis.length}</div>
        </div>
      </div>
      <div class="ap-lower">
        <div class="ap-chart-box">
          <div class="ap-chart-titulo">Dividend Yield do setor — últimos 3 anos</div>
          <div class="ap-chart-wrap"><canvas id="ap-chart-${i}"></canvas></div>
        </div>
        <div class="ap-fiis-box">
          <div class="ap-fiis-titulo">Maiores DY do setor</div>
          <table class="ap-fiis-tabela">
            <thead><tr><th>FII</th><th>P/VP</th><th>DY a.a.</th><th>12M</th></tr></thead>
            <tbody>${linhas || '<tr><td colspan="4">—</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  stage.appendChild(el);

  // Grafico DY historico (ultimos 3 anos)
  const serie = (setoresDoc.historico_dy || {})[setor] || [];
  const corte = new Date(); corte.setFullYear(corte.getFullYear() - 3);
  const corteStr = corte.toISOString().slice(0, 10);
  const passo = 5;  // ~semanal
  const pontos = serie.filter(p => p[0] >= corteStr).filter((_, k) => k % passo === 0);
  const labels = pontos.map(p => p[0]);
  const valores = pontos.map(p => +(p[1] * 100).toFixed(2));

  const ctx = el.querySelector(`#ap-chart-${i}`).getContext("2d");
  const ch = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{
      data: valores, borderColor: cor, backgroundColor: cor + "22",
      borderWidth: 3, pointRadius: 0, tension: 0.15, fill: true,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, color: "#6b7a8d", font: { size: 15 },
             callback(v){ const s = this.getLabelForValue(v); return s ? s.slice(0,7) : s; } },
             grid: { display: false } },
        y: { ticks: { color: "#6b7a8d", font: { size: 15 }, callback: v => v.toFixed(0) + "%" },
             grid: { color: "#eef0f4" } },
      },
    },
  });
  _charts.push(ch);
}

// ── Navegacao / escala ─────────────────────────────────────────────────
function ativarSlide(n) {
  _idx = Math.max(0, Math.min(n, _slides.length - 1));
  _slides.forEach((s, k) => s.classList.toggle("ativo", k === _idx));
  document.getElementById("ap-contador").textContent = `${_idx + 1} / ${_slides.length}`;
  document.getElementById("ap-prev").disabled = _idx === 0;
  document.getElementById("ap-next").disabled = _idx === _slides.length - 1;
}

function ajustarEscala() {
  const stage = document.getElementById("ap-stage");
  const margem = 0.94;
  const escala = Math.min(stage.clientWidth / 1280, stage.clientHeight / 720) * margem;
  _slides.forEach(s => { s.style.transform = `scale(${escala})`; });
}

function configurarNav() {
  document.getElementById("ap-prev").addEventListener("click", () => ativarSlide(_idx - 1));
  document.getElementById("ap-next").addEventListener("click", () => ativarSlide(_idx + 1));
  document.getElementById("ap-export").addEventListener("click", exportarSlide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft")  ativarSlide(_idx - 1);
    if (e.key === "ArrowRight" || e.key === " ") { ativarSlide(_idx + 1); e.preventDefault(); }
  });
}

// ── Export do slide ativo como PNG (alta resolucao) ────────────────────
async function exportarSlide() {
  const slide = _slides[_idx];
  const btn = document.getElementById("ap-export");
  const lbl = document.getElementById("ap-export-lbl");
  const orig = lbl.textContent;
  const feedback = (txt, ok) => {
    lbl.textContent = txt; btn.classList.toggle("ok", !!ok);
    clearTimeout(btn._t); btn._t = setTimeout(() => { lbl.textContent = orig; btn.classList.remove("ok"); }, 2200);
  };

  try {
    // Captura o slide no tamanho natural 1280x720 (ignora o transform de tela),
    // em 2x -> 2560x1440, nitido pra PowerPoint.
    const canvas = await html2canvas(slide, {
      width: 1280, height: 720, scale: 2,
      backgroundColor: "#ffffff", useCORS: true,
      windowWidth: 1280, windowHeight: 720,
    });
    await new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error("toBlob falhou"));
        try {
          if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            feedback("✓ Copiado", true);
          } else { throw new Error("Clipboard indisponível"); }
          resolve();
        } catch {
          // fallback: download
          const a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = `setor-${_idx}.png`;
          a.click();
          feedback("↓ Baixado", true);
          resolve();
        }
      }, "image/png");
    });
  } catch (e) {
    console.warn(e);
    feedback("✕ Falhou", false);
  }
}

document.addEventListener("DOMContentLoaded", carregar);
