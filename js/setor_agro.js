// Setor Agro (aba interna): evolução de Dividend Yield e P/VP contra a média
// histórica. Fonte: data/setores.json → historico_dy / historico_pvp, as mesmas
// séries que alimentam a Análise Setorial.
//
// A linha de referência é a média de TODA a série, não a do período visível: o
// que interessa é "onde estamos frente ao histórico", então trocar o preset de
// 12M pra 3A move a janela mas não move a régua.

const SETOR = "Agro";

// DY vem em decimal (0.1509 = 15,09%); P/VP é razão (0.6921).
const METRICAS = {
  dy:  { chave: "historico_dy",  rotulo: "Dividend Yield", cor: "#FF6200",
         fmt: v => (v * 100).toFixed(2).replace(".", ",") + "%" },
  pvp: { chave: "historico_pvp", rotulo: "P/VP",           cor: "#00093C",
         fmt: v => v.toFixed(2).replace(".", ",") + "x" },
};

let _series = {};    // dy|pvp -> [[data, valor], ...] série completa
let _stats = {};     // dy|pvp -> { media, desvio }
let _charts = {};    // dy|pvp -> Chart
let _mesesAtual = 0; // 0 = tudo

// ── Carga ───────────────────────────────────────────────────────────────────

async function carregarAgro() {
  try {
    const r = await fetch("data/setores.json?t=" + Math.floor(Date.now() / 60000));
    if (!r.ok) throw new Error("setores.json → HTTP " + r.status);
    const doc = await r.json();

    for (const [id, m] of Object.entries(METRICAS)) {
      const serie = (doc[m.chave] || {})[SETOR];
      if (!serie || serie.length < 2) {
        throw new Error(`sem histórico de ${m.rotulo} para o setor ${SETOR}`);
      }
      _series[id] = serie;
      _stats[id] = calcularStats(serie.map(([, v]) => v));
    }

    const s = _series.dy;
    document.getElementById("sa-nota").textContent =
      `Série de ${formatarData(s[0][0])} a ${formatarData(s[s.length - 1][0])} `
      + `(${s.length} pregões). Fonte: data/setores.json, atualizado em ${doc.atualizado_em}.`;

    aplicarPeriodo(0);

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Erro ao carregar dados: " + e.message;
  }
}

function calcularStats(valores) {
  const n = valores.length;
  const media = valores.reduce((a, b) => a + b, 0) / n;
  const variancia = valores.reduce((a, v) => a + (v - media) ** 2, 0) / n;
  return { media, desvio: Math.sqrt(variancia) };
}

function formatarData(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

// ── Período ─────────────────────────────────────────────────────────────────

function aplicarPeriodo(meses) {
  _mesesAtual = meses;
  document.querySelectorAll(".sa-presets button").forEach(b => {
    b.classList.toggle("ativo", Number(b.dataset.meses) === meses);
  });

  for (const id of Object.keys(METRICAS)) {
    const serie = recortar(_series[id], meses);
    desenhar(id, serie);
    renderStats(id, serie);
  }
}

function recortar(serie, meses) {
  if (!meses) return serie;
  const fim = new Date(serie[serie.length - 1][0] + "T00:00:00");
  fim.setMonth(fim.getMonth() - meses);
  const corte = fim.toISOString().slice(0, 10);
  const recorte = serie.filter(([d]) => d >= corte);
  return recorte.length >= 2 ? recorte : serie;
}

function renderStats(id, serie) {
  const m = METRICAS[id];
  const { media, desvio } = _stats[id];
  const atual = serie[serie.length - 1][1];
  const diff = atual - media;

  // "Acima da média" é bom pro DY e ruim pro P/VP — a cor segue o que o número
  // significa pra quem compra, não o sinal.
  const favoravel = id === "dy" ? diff > 0 : diff < 0;
  const cls = favoravel ? "sa-acima" : "sa-abaixo";
  const sinal = diff >= 0 ? "+" : "−";
  const absFmt = id === "dy"
    ? (Math.abs(diff) * 100).toFixed(2).replace(".", ",") + " p.p."
    : Math.abs(diff).toFixed(2).replace(".", ",");

  document.getElementById(`sa-stats-${id}`).innerHTML =
    `<span><span class="sa-stat-rot">Atual</span> <span class="sa-stat-val">${m.fmt(atual)}</span></span>`
    + `<span><span class="sa-stat-rot">Média hist.</span> <span class="sa-stat-val">${m.fmt(media)}</span></span>`
    + `<span><span class="sa-stat-rot">vs média</span> <span class="${cls}">${sinal}${absFmt}</span></span>`
    + `<span><span class="sa-stat-rot">Desvio</span> <span class="sa-stat-val">${m.fmt(desvio)}</span></span>`;
}

// ── Gráfico ─────────────────────────────────────────────────────────────────

function desenhar(id, serie) {
  const m = METRICAS[id];
  const { media, desvio } = _stats[id];
  const labels = serie.map(([d]) => d);
  const n = labels.length;

  if (_charts[id]) _charts[id].destroy();

  _charts[id] = new Chart(document.getElementById(`sa-grafico-${id}`), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: m.rotulo,
          data: serie.map(([, v]) => v),
          borderColor: m.cor,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
          fill: false,
          order: 0,
        },
        {
          label: "Média histórica",
          data: Array(n).fill(media),
          borderColor: "#8a8f98",
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          order: 1,
        },
        // Banda ±1σ: o "upper" preenche até o dataset seguinte ("lower").
        {
          label: "+1 desvio",
          data: Array(n).fill(media + desvio),
          borderColor: "transparent",
          backgroundColor: "rgba(138,143,152,0.10)",
          pointRadius: 0,
          fill: "+1",
          order: 2,
        },
        {
          label: "−1 desvio",
          data: Array(n).fill(media - desvio),
          borderColor: "transparent",
          pointRadius: 0,
          fill: false,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 14, font: { size: 12 },
            // As duas linhas da banda são um detalhe visual, não séries.
            filter: item => !item.text.includes("desvio"),
          },
        },
        tooltip: {
          callbacks: {
            title: c => formatarData(c[0].label),
            label: c => c.dataset.label.includes("desvio")
              ? null
              : `${c.dataset.label}: ${m.fmt(c.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 10,
            callback: function(_, idx) {
              const d = this.getLabelForValue(idx);
              const [a, mm] = d.split("-");
              const meses = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
              return `${meses[parseInt(mm, 10) - 1]}/${a.slice(2)}`;
            },
          },
          grid: { display: false },
        },
        y: {
          ticks: { callback: v => m.fmt(v) },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
      },
    },
  });
}

// ── Exportações ─────────────────────────────────────────────────────────────

async function copiarGraficoAgro(canvasId, btn) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Copiando...";
  try {
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error("falha ao gerar PNG")), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    btn.textContent = "✓ Copiado!";
  } catch (e) {
    btn.textContent = "Erro: " + (e.message || e);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = txt; }, 2200);
  }
}

let _sheetJsAgro = null;
async function _carregarSheetJsAgro() {
  if (window.XLSX) return;
  if (_sheetJsAgro) return _sheetJsAgro;
  _sheetJsAgro = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Falha ao carregar SheetJS"));
    document.head.appendChild(s);
  });
  return _sheetJsAgro;
}

async function baixarAgroExcel(btn) {
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparando...";
  try {
    await _carregarSheetJsAgro();
    const dyPorData = Object.fromEntries(_series.dy);
    const pvpPorData = Object.fromEntries(_series.pvp);
    const datas = [...new Set([...Object.keys(dyPorData), ...Object.keys(pvpPorData)])].sort();
    const r6 = v => (v == null ? null : Math.round(v * 1e6) / 1e6);

    const aoa = [
      [`Setor ${SETOR} — Dividend Yield e P/VP`],
      [`Exportado em: ${new Date().toLocaleString("pt-BR")}`],
      [`Média histórica — DY: ${METRICAS.dy.fmt(_stats.dy.media)} · P/VP: ${METRICAS.pvp.fmt(_stats.pvp.media)}`],
      [],
      ["Data", "Dividend Yield", "P/VP"],
      ...datas.map(d => [formatarData(d), r6(dyPorData[d]), r6(pvpPorData[d])]),
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 12 }];
    // DY como percentual de verdade; P/VP com 2 casas.
    datas.forEach((_, i) => {
      const cDy = ws[XLSX.utils.encode_cell({ r: 5 + i, c: 1 })];
      const cPvp = ws[XLSX.utils.encode_cell({ r: 5 + i, c: 2 })];
      if (cDy && typeof cDy.v === "number") cDy.z = "0.00%";
      if (cPvp && typeof cPvp.v === "number") cPvp.z = "0.00";
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SETOR);
    XLSX.writeFile(wb, `setor_${SETOR.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    alert("Erro ao gerar Excel: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = txt;
  }
}

carregarAgro();
