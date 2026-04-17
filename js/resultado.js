let carteira   = JSON.parse(localStorage.getItem("sim_carteira")   || "[]");
let pesos      = JSON.parse(localStorage.getItem("sim_pesos")      || "{}");
let valorTotal = parseFloat(localStorage.getItem("sim_valor_total") || "0");

let todosFiis       = [];
let tickerDir       = {};  // ticker → "fiis" | "infra" | "agro"
let sugestaoIdx     = -1;
let vazioEl         = null;
let graficoPizza    = null;
let graficoRetorno  = null;
let graficoRenda    = null;

const CORES_PIZZA = [
  "#EF6300","#2563EB","#16A34A","#DC2626","#9333EA",
  "#0891B2","#D97706","#059669","#7C3AED","#DB2777",
  "#0284C7","#65A30D"
];

// ─── PDF ─────────────────────────────────────────────────────────────────────

function carregarImagem(img, src) {
  return new Promise(resolve => {
    if (!src) { resolve(); return; }
    img.onload  = resolve;
    img.onerror = resolve;
    img.src = src;
    if (img.complete) resolve();
  });
}

async function gerarPDF() {
  const nome  = document.getElementById("res-nome-carteira")?.value.trim() || "Carteira";
  const vc    = parseValorCarteira(document.getElementById("res-valor-total")?.value);

  // ── Cabeçalho ──
  document.getElementById("pdf-nome").textContent = nome;
  document.getElementById("pdf-data-gerado").textContent =
    "Gerado em " + new Date().toLocaleDateString("pt-BR");
  document.getElementById("pdf-valor-titulo").textContent =
    vc > 0 ? "Valor da carteira: " + formatarBRL(vc) : "";

  // ── Indicadores ──
  document.getElementById("pdf-ind-dy").textContent      = document.getElementById("ind-dy").textContent;
  document.getElementById("pdf-ind-renda").textContent   = document.getElementById("ind-renda").textContent;
  document.getElementById("pdf-ind-pvp").textContent     = document.getElementById("ind-pvp").textContent;
  document.getElementById("pdf-ind-retorno").textContent = document.getElementById("ind-retorno").textContent;
  document.getElementById("pdf-ind-vol").textContent     = document.getElementById("ind-vol").textContent;
  document.getElementById("pdf-ind-vol-ifix").textContent = document.getElementById("ind-vol-ifix").textContent;

  // ── Tabela ──
  const tbody = document.getElementById("pdf-tbody");
  tbody.innerHTML = "";
  let somaPeso = 0, somaPos = 0;
  carteira.forEach(f => {
    const peso = pesos[f.ticker] || 0;
    const pos  = vc > 0 ? (peso / 100) * vc : null;
    somaPeso += peso;
    if (pos) somaPos += pos;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="ticker-cell">${f.ticker}</td>
      <td>${f.nome}</td>
      <td>${f.setor || "—"}</td>
      <td class="num">${peso.toFixed(2)}%</td>
      <td class="num">${pos != null ? formatarBRL(pos) : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById("pdf-total-peso").textContent = somaPeso.toFixed(2) + "%";
  document.getElementById("pdf-total-pos").textContent  = vc > 0 ? formatarBRL(somaPos) : "—";

  // ── Visão Geral ──
  const vgEl = document.getElementById("pdf-visao-geral");
  vgEl.innerHTML = "";
  carteira.forEach(f => {
    const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
    const texto   = fiiData?.["Visão Geral"] || fiiData?.["Vis\u00e3o Geral"] || "Sem descrição disponível.";
    const bloco   = document.createElement("div");
    bloco.className = "pdf-visao-bloco";
    bloco.innerHTML = `<span class="pdf-visao-ticker">${f.ticker}</span> ${texto}`;
    vgEl.appendChild(bloco);
  });

  // ── Gráficos como imagens (aguarda carregamento) ──
  await Promise.all([
    carregarImagem(
      document.getElementById("pdf-pizza-img"),
      document.getElementById("grafico-setores")?.toDataURL("image/png")
    ),
    carregarImagem(
      document.getElementById("pdf-retorno-img"),
      document.getElementById("grafico-retorno")?.toDataURL("image/png")
    ),
    carregarImagem(
      document.getElementById("pdf-renda-img"),
      document.getElementById("grafico-renda")?.toDataURL("image/png")
    )
  ]);

  // ── Abre diálogo de impressão do navegador ──
  window.print();
}

// ─── NOME DA CARTEIRA ────────────────────────────────────────────────────────

function salvarNomeCarteira() {
  const val = document.getElementById("res-nome-carteira")?.value || "";
  localStorage.setItem("sim_nome_carteira", val);
}

// ─── FORMATAÇÃO ──────────────────────────────────────────────────────────────

function formatarBRL(v) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseValorCarteira(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/\./g, "").replace(",", ".")) || 0;
}

function formatarInputCarteira() {
  const inp = document.getElementById("res-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0
    ? val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "";
  atualizarTotal();
}

function desformatarInputCarteira() {
  const inp = document.getElementById("res-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0 ? String(val).replace(".", ",") : "";
}

// ─── TABELA ──────────────────────────────────────────────────────────────────

function renderizarTabela() {
  const tbody     = document.getElementById("res-tbody");
  const tfoot     = document.getElementById("res-tfoot");
  const vazio     = vazioEl;

  if (!carteira.length) {
    tbody.innerHTML = "";
    tbody.appendChild(vazio);
    vazio.style.display = "";
    tfoot.style.display = "none";
    return;
  }

  vazio.style.display = "none";
  tfoot.style.display = "";

  // Preserva pesos já digitados
  const pesosAtuais = {};
  tbody.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp = tr.querySelector(".sim-peso-input");
    if (inp) pesosAtuais[tr.dataset.ticker] = inp.value;
  });

  tbody.innerHTML = "";

  carteira.forEach(f => {
    const tr = document.createElement("tr");
    tr.dataset.ticker = f.ticker;
    const pesoAtual = pesosAtuais[f.ticker] ?? (pesos[f.ticker] != null ? String(pesos[f.ticker]) : "");

    tr.innerHTML = `
      <td class="ticker-cell">${f.ticker}</td>
      <td>${f.nome}</td>
      <td>${f.setor || "—"}</td>
      <td class="num">
        <input type="number" class="sim-peso-input" min="0" max="100" step="0.01"
          value="${pesoAtual}" placeholder="0"
          oninput="atualizarTotal()" />
        <span class="sim-peso-pct">%</span>
      </td>
      <td class="num res-posicao-valor">—</td>
      <td>
        <button class="sim-remover" onclick="resRemoverFii('${f.ticker}')" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  atualizarTotal();
}

// ─── TOTAIS E VALIDAÇÃO ───────────────────────────────────────────────────────

function atualizarTotal() {
  const inputs     = document.querySelectorAll(".sim-peso-input");
  const totalPeso  = document.getElementById("res-total-peso");
  const totalPos   = document.getElementById("res-total-posicao");
  const aviso      = document.getElementById("res-aviso");
  const btnWrapper = document.getElementById("res-btn-wrapper");
  const vc         = parseValorCarteira(document.getElementById("res-valor-total")?.value);

  let soma = 0;
  let todosPositivos = true;

  inputs.forEach(inp => {
    const v = parseFloat(inp.value) || 0;
    soma += v;
    if (v <= 0) todosPositivos = false;
  });

  // Valor de posição por linha
  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp     = tr.querySelector(".sim-peso-input");
    const posCell = tr.querySelector(".res-posicao-valor");
    if (!inp || !posCell) return;
    const peso = parseFloat(inp.value) || 0;
    posCell.textContent = vc > 0 ? formatarBRL((peso / 100) * vc) : "—";
  });

  // Totais no tfoot
  if (totalPeso)  totalPeso.textContent  = soma.toFixed(2) + "%";
  if (totalPos)   totalPos.textContent   = vc > 0 ? formatarBRL((soma / 100) * vc) : "—";

  // Classe do total
  const diff = Math.abs(soma - 100);
  const somaOk = diff < 0.01;

  if (!carteira.length) {
    aviso.style.display = "none";
    totalPeso.className = "num";
    btnWrapper.style.display = "none";
    return;
  }

  if (somaOk) {
    totalPeso.className = "num sim-total-ok";
    aviso.style.display = "none";
  } else {
    totalPeso.className = "num sim-total-erro";
    aviso.style.display = "block";
    aviso.textContent = soma < 100
      ? `A soma dos pesos é ${soma.toFixed(2)}% — faltam ${(100 - soma).toFixed(2)}% para chegar a 100%.`
      : `A soma dos pesos é ${soma.toFixed(2)}% — reduza ${(soma - 100).toFixed(2)}% para chegar a 100%.`;
  }

  // Botão só aparece se todos os pesos > 0 E soma = 100%
  btnWrapper.style.display = (todosPositivos && somaOk) ? "flex" : "none";
}

// ─── GRÁFICO DE PIZZA ────────────────────────────────────────────────────────

function renderizarPizza(pesosAtivos) {
  // Agrupa por setor somando os pesos
  const porSetor = {};
  carteira.forEach(f => {
    const setor = f.setor || "Outros";
    const peso  = pesosAtivos[f.ticker] || 0;
    porSetor[setor] = (porSetor[setor] || 0) + peso;
  });

  const labels = Object.keys(porSetor);
  const dados  = labels.map(s => parseFloat(porSetor[s].toFixed(2)));
  const cores  = labels.map((_, i) => CORES_PIZZA[i % CORES_PIZZA.length]);

  const ctx = document.getElementById("grafico-setores").getContext("2d");

  if (graficoPizza) graficoPizza.destroy();

  graficoPizza = new Chart(ctx, {
    type: "pie",
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{
        data: dados,
        backgroundColor: cores,
        borderColor: "#fff",
        borderWidth: 2,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(2)}%`
          }
        },
        datalabels: {
          color: "#fff",
          font: { size: 11, weight: "700" },
          textAlign: "center",
          formatter: (value, ctx) => {
            const label = ctx.chart.data.labels[ctx.dataIndex];
            return `${label}\n${value.toFixed(1)}%`;
          },
          display: ctx => ctx.dataset.data[ctx.dataIndex] >= 3
        }
      }
    }
  });
}

// ─── RETORNO ACUMULADO ───────────────────────────────────────────────────────

async function buscarCDI(dataMinISO) {
  try {
    const fmt = iso => {
      const [a, m, d] = iso.split("-");
      return `${d}/${m}/${a}`;
    };
    const hoje = new Date().toISOString().slice(0, 10);
    const url  = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json`
               + `&dataInicial=${fmt(dataMinISO)}&dataFinal=${fmt(hoje)}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const lista = await resp.json();
    // Converte para mapa { "AAAA-MM-DD": taxaDiaria }
    const mapa = {};
    for (const { data, valor } of lista) {
      const [d, m, a] = data.split("/");
      mapa[`${a}-${m}-${d}`] = parseFloat(valor) / 100; // taxa decimal (0.000415)
    }
    return mapa;
  } catch { return {}; }
}

async function renderizarRetornoAcumulado(pesosAtivos) {
  if (!carteira.length) return;

  // Data mínima: 12 meses atrás
  const dataMin = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // Busca histórico de preços + CDI + IFIX em paralelo
  const [resultados, cdiMapa, ifixSerie] = await Promise.all([
    Promise.all(carteira.map(async f => {
      try {
        const resp = await fetch(`data/${tickerDir[f.ticker] || "fiis"}/${f.ticker}.json?v=${Date.now()}`);
        if (!resp.ok) return { ticker: f.ticker, precos: {} };
        const data = await resp.json();
        const serie = (data.historico_preco_adj && data.historico_preco_adj.length)
          ? data.historico_preco_adj
          : (data.historico_preco || []);
        const mapa = {};
        for (const [d, p] of serie) mapa[d] = p;
        return { ticker: f.ticker, precos: mapa };
      } catch { return { ticker: f.ticker, precos: {} }; }
    })),
    buscarCDI(dataMin),
    fetch(`data/ifix.json?v=${Date.now()}`).then(r => r.ok ? r.json() : null).then(j => j?.historico || []).catch(() => [])
  ]);

  const precosPor = {};
  for (const { ticker, precos } of resultados) precosPor[ticker] = precos;

  // Todas as datas únicas ordenadas dos preços
  const todasDatas = [...new Set(
    Object.values(precosPor).flatMap(m => Object.keys(m))
  )].sort();

  if (!todasDatas.length) return;

  const idxInicio  = Math.max(0, todasDatas.findIndex(d => d >= dataMin) - 1);
  const datesJanela = todasDatas.slice(idxInicio);

  // Acumula retorno carteira e CDI
  let acumCarteira = 100;
  let acumCDI      = 100;

  const labels          = [];
  const valoresCarteira = [];
  const valoresCDI      = [];
  const retornosDiarios = [];

  for (let i = 1; i < datesJanela.length; i++) {
    const d  = datesJanela[i];
    const d0 = datesJanela[i - 1];
    if (d < dataMin) continue;

    // Retorno ponderado carteira
    let retPond = 0, somaPeso = 0;
    for (const f of carteira) {
      const peso = pesosAtivos[f.ticker] || 0;
      if (peso <= 0) continue;
      const p0 = precosPor[f.ticker]?.[d0];
      const p1 = precosPor[f.ticker]?.[d];
      if (p0 > 0 && p1 > 0) {
        retPond  += peso * (p1 / p0 - 1);
        somaPeso += peso;
      }
    }
    if (somaPeso > 0) {
      const retDiario = retPond / somaPeso;
      acumCarteira *= (1 + retDiario);
      retornosDiarios.push(retDiario);
    }

    // CDI acumulado (usa taxa do dia ou do dia anterior se não houver)
    const taxaCDI = cdiMapa[d] ?? cdiMapa[d0] ?? 0;
    acumCDI *= (1 + taxaCDI);

    const [, mes, dia] = d.split("-");
    labels.push(`${dia}/${mes}`);
    valoresCarteira.push(parseFloat((acumCarteira - 100).toFixed(4)));
    valoresCDI.push(parseFloat((acumCDI - 100).toFixed(4)));
  }

  // Volatilidade anualizada = std_dev(retornos diários) × √252
  const calcVolAnual = rets => {
    if (rets.length < 2) return null;
    const n = rets.length;
    const media = rets.reduce((a, b) => a + b, 0) / n;
    const variancia = rets.reduce((a, r) => a + (r - media) ** 2, 0) / (n - 1);
    return Math.sqrt(variancia) * Math.sqrt(252);
  };

  const volCart = calcVolAnual(retornosDiarios);
  const volEl = document.getElementById("ind-vol");
  if (volEl) volEl.textContent = volCart != null ? (volCart * 100).toFixed(2) + "%" : "—";

  // IFIX: mesmo cálculo usando a série reconstituída (apenas últimos 12M)
  const ifixJanela = (ifixSerie || []).filter(([d]) => d >= dataMin);
  const retornosIfix = [];
  for (let i = 1; i < ifixJanela.length; i++) {
    const p0 = ifixJanela[i - 1][1];
    const p1 = ifixJanela[i][1];
    if (p0 > 0 && p1 > 0) retornosIfix.push(p1 / p0 - 1);
  }
  const volIfix = calcVolAnual(retornosIfix);
  const volIfixEl = document.getElementById("ind-vol-ifix");
  if (volIfixEl) volIfixEl.textContent = volIfix != null ? (volIfix * 100).toFixed(2) + "%" : "—";

  const ctx = document.getElementById("grafico-retorno")?.getContext("2d");
  if (!ctx) return;

  if (graficoRetorno) graficoRetorno.destroy();

  const corCarteira = valoresCarteira.at(-1) >= 0 ? "#EF6300" : "#DC2626";

  graficoRetorno = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Carteira",
          data: valoresCarteira,
          borderColor: corCarteira,
          backgroundColor: corCarteira + "18",
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2
        },
        {
          label: "CDI",
          data: valoresCDI,
          borderColor: "rgb(0,9,60)",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { font: { size: 12 }, usePointStyle: true, pointStyleWidth: 10 }
        },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%`
          }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 12, font: { size: 11 } },
          grid: { display: false }
        },
        y: {
          ticks: { font: { size: 11 }, callback: v => v.toFixed(1) + "%" },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

async function renderizarRendaMensal(pesosAtivos) {
  if (!carteira.length) return;

  const vc = parseValorCarteira(document.getElementById("res-valor-total")?.value);

  // Busca histórico de preços de cada fundo
  const resultados = await Promise.all(carteira.map(async f => {
    try {
      const resp = await fetch(`data/${tickerDir[f.ticker] || "fiis"}/${f.ticker}.json`);
      if (!resp.ok) return { ticker: f.ticker, precos: {} };
      const data = await resp.json();
      const mapa = {};
      for (const [d, p] of (data.historico_preco || [])) mapa[d] = p;
      return { ticker: f.ticker, precos: mapa };
    } catch { return { ticker: f.ticker, precos: {} }; }
  }));

  const precosPor = {};
  for (const { ticker, precos } of resultados) precosPor[ticker] = precos;

  // Preço atual de cada fundo (última entrada do histórico ou dos dados)
  const precoAtual = {};
  for (const f of carteira) {
    const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
    precoAtual[f.ticker] = fiiData?.["Preço Atual"] ?? fiiData?.["Pre\u00e7o Atual"] ?? null;
    // fallback: último preço do histórico
    if (!precoAtual[f.ticker]) {
      const datas = Object.keys(precosPor[f.ticker] || {}).sort();
      if (datas.length) precoAtual[f.ticker] = precosPor[f.ticker][datas.at(-1)];
    }
  }

  // Gera os 12 últimos meses (ano-mês)
  const meses = [];
  const MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const hoje = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push({
      ano: d.getFullYear(),
      mes: d.getMonth(),          // 0-based
      label: `${MESES_PT[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`
    });
  }

  // Para cada mês, estima renda mensal
  // Lógica: DY_mensal_i = (DY_a.a._i / 12) × (preço_mês_i / preço_atual_i)
  // Renda_mês = valor_carteira × Σ(peso_i/100 × DY_mensal_i)
  const rendas = meses.map(({ ano, mes }) => {
    // Pega o último preço disponível dentro daquele mês para cada fundo
    let rendaPonderada = 0;
    let somaPeso = 0;

    for (const f of carteira) {
      const peso  = (pesosAtivos[f.ticker] || 0) / 100;
      if (peso <= 0) continue;
      const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
      const dyAnual = fiiData?.["DY a.a."] ?? null;
      if (dyAnual == null) continue;

      // Preço no mês: último dia do mês disponível no histórico
      const prefixo = `${ano}-${String(mes + 1).padStart(2, "0")}`;
      const datasDoMes = Object.keys(precosPor[f.ticker] || {})
        .filter(d => d.startsWith(prefixo)).sort();
      const precoMes = datasDoMes.length
        ? precosPor[f.ticker][datasDoMes.at(-1)]
        : precoAtual[f.ticker];

      const pAtual = precoAtual[f.ticker];
      const fatorPreco = (precoMes && pAtual && pAtual > 0) ? precoMes / pAtual : 1;

      const dyMensal = (dyAnual / 12) * fatorPreco;
      rendaPonderada += peso * dyMensal;
      somaPeso += peso;
    }

    if (somaPeso <= 0) return 0;
    return vc > 0 ? parseFloat((vc * rendaPonderada / somaPeso * somaPeso).toFixed(2)) : 0;
  });

  const ctx = document.getElementById("grafico-renda")?.getContext("2d");
  if (!ctx) return;

  if (graficoRenda) graficoRenda.destroy();

  graficoRenda = new Chart(ctx, {
    type: "bar",
    data: {
      labels: meses.map(m => m.label),
      datasets: [{
        label: "Renda Mensal (R$)",
        data: rendas,
        backgroundColor: "rgba(239,99,0,0.9)",
        borderColor: "rgba(239,99,0,1)",
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.parsed.y.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 11 } },
          grid: { display: false }
        },
        y: {
          ticks: {
            font: { size: 11 },
            callback: v => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 0 })
          },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

// ─── INDICADORES ─────────────────────────────────────────────────────────────

function atualizarIndicadores(pesosAtivos) {
  const vc = parseValorCarteira(document.getElementById("res-valor-total")?.value);

  let somaDY = 0, somaPVP = 0, somaRet = 0, somaPeso = 0;
  let temDY = false, temPVP = false, temRet = false;

  carteira.forEach(f => {
    const peso = (pesosAtivos[f.ticker] || 0) / 100;
    if (peso <= 0) return;
    const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
    if (!fiiData) return;

    somaPeso += peso;

    const dy  = fiiData["DY a.a."];
    const pvp = fiiData["P/VP"];
    const ret = fiiData["Retorno - 12M"];

    if (dy  != null) { somaDY  += peso * dy;  temDY  = true; }
    if (pvp != null) { somaPVP += peso * pvp; temPVP = true; }
    if (ret != null) { somaRet += peso * ret; temRet = true; }
  });

  const dyMedio  = temDY  && somaPeso > 0 ? somaDY  / somaPeso : null;
  const pvpMedio = temPVP && somaPeso > 0 ? somaPVP / somaPeso : null;
  const retMedio = temRet && somaPeso > 0 ? somaRet / somaPeso : null;

  const fmtPct = v => v != null ? (v * 100).toFixed(2) + "%" : "—";
  const fmtX   = v => v != null ? v.toFixed(2) + "x"         : "—";

  document.getElementById("ind-dy").textContent      = fmtPct(dyMedio);
  document.getElementById("ind-pvp").textContent     = fmtX(pvpMedio);
  document.getElementById("ind-retorno").textContent = fmtPct(retMedio);

  const rendaEl = document.getElementById("ind-renda");
  if (dyMedio != null && vc > 0) {
    const rendaMensal = (dyMedio * vc) / 12;
    rendaEl.textContent = rendaMensal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } else {
    rendaEl.textContent = "—";
  }
}

// ─── VISÃO GERAL ─────────────────────────────────────────────────────────────

function atualizarVisaoGeral() {
  const container = document.getElementById("res-visao-geral");
  if (!container) return;

  container.innerHTML = "";

  carteira.forEach(f => {
    const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
    const texto   = fiiData?.["Visão Geral"] || fiiData?.["Vis\u00e3o Geral"] || null;

    const bloco = document.createElement("div");
    bloco.className = "res-visao-bloco";
    bloco.innerHTML = `
      <div class="res-visao-ticker">${f.ticker}</div>
      <div class="res-visao-texto">${texto || "<em>Sem descrição disponível.</em>"}</div>
    `;
    container.appendChild(bloco);
  });
}

// ─── BUSCA E SUGESTÕES ───────────────────────────────────────────────────────

function resFiltrarSugestoes() {
  const q   = document.getElementById("res-busca").value.trim().toUpperCase();
  const box = document.getElementById("res-sugestoes");
  sugestaoIdx = -1;

  if (!q) { box.style.display = "none"; return; }

  const naCarteira = new Set(carteira.map(f => f.ticker));
  const resultados = todosFiis
    .filter(f => {
      const t = (f["Ticker"] || "").toUpperCase();
      const n = (f["Nome"]   || "").toUpperCase();
      return (t.includes(q) || n.includes(q)) && !naCarteira.has(f["Ticker"]);
    })
    .slice(0, 8);

  if (!resultados.length) { box.style.display = "none"; return; }

  box.innerHTML = resultados.map((f, i) =>
    `<div class="sim-sugestao" data-idx="${i}"
      onmousedown="resAdicionarFii('${f["Ticker"]}')">
      <span class="sim-sug-ticker">${f["Ticker"]}</span>
      <span class="sim-sug-nome">${f["Nome"] || ""}</span>
    </div>`
  ).join("");

  box._resultados = resultados;
  box.style.display = "block";
}

function resNavegarSugestoes(e) {
  const box   = document.getElementById("res-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    sugestaoIdx = Math.min(sugestaoIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    sugestaoIdx = Math.max(sugestaoIdx - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = box._resultados?.[sugestaoIdx >= 0 ? sugestaoIdx : 0];
    if (r) resAdicionarFii(r["Ticker"]);
    return;
  } else if (e.key === "Escape") {
    box.style.display = "none";
    return;
  }
  items.forEach((el, i) => el.classList.toggle("ativo", i === sugestaoIdx));
}

function resAdicionarFii(ticker) {
  if (carteira.find(f => f.ticker === ticker)) return;
  const fii = todosFiis.find(f => f["Ticker"] === ticker);
  if (!fii) return;

  carteira.push({ ticker, nome: fii["Nome"] || "", setor: fii["Setor"] || "" });
  pesos[ticker] = 0;

  document.getElementById("res-busca").value = "";
  document.getElementById("res-sugestoes").style.display = "none";

  localStorage.setItem("sim_carteira", JSON.stringify(carteira));
  localStorage.setItem("sim_pesos",    JSON.stringify(pesos));

  renderizarTabela();
  renderizarPizza(pesos);
  atualizarIndicadores(pesos);
  atualizarVisaoGeral();
  renderizarRetornoAcumulado(pesos);
  renderizarRendaMensal(pesos);
}

function resRemoverFii(ticker) {
  carteira = carteira.filter(f => f.ticker !== ticker);
  delete pesos[ticker];

  localStorage.setItem("sim_carteira", JSON.stringify(carteira));
  localStorage.setItem("sim_pesos",    JSON.stringify(pesos));

  renderizarTabela();
  renderizarPizza(pesos);
  atualizarIndicadores(pesos);
  atualizarVisaoGeral();
  renderizarRetornoAcumulado(pesos);
  renderizarRendaMensal(pesos);
}

document.addEventListener("click", e => {
  if (!e.target.closest(".res-busca-container")) {
    const box = document.getElementById("res-sugestoes");
    if (box) box.style.display = "none";
  }
});

// ─── MODIFICAR ────────────────────────────────────────────────────────────────

function modificarCarteira() {
  const novosPesos = {};
  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp = tr.querySelector(".sim-peso-input");
    if (inp) novosPesos[tr.dataset.ticker] = parseFloat(inp.value) || 0;
  });

  pesos = novosPesos;
  valorTotal = parseValorCarteira(document.getElementById("res-valor-total")?.value);

  localStorage.setItem("sim_pesos",       JSON.stringify(pesos));
  localStorage.setItem("sim_valor_total", String(valorTotal));

  document.getElementById("res-btn-wrapper").style.display = "none";
  renderizarPizza(pesos);
  atualizarIndicadores(pesos);
  atualizarVisaoGeral();
  renderizarRetornoAcumulado(pesos);
  renderizarRendaMensal(pesos);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  vazioEl = document.getElementById("res-vazio");

  // Carrega lista de FIIs + Infra para busca
  try {
    const [resp, respInfra, respAgro] = await Promise.all([
      fetch("data/index.json"),
      fetch("data/infra_index.json").catch(() => null),
      fetch("data/agro_index.json").catch(() => null)
    ]);
    if (resp.ok) {
      const data = await resp.json();
      todosFiis = data.fiis || [];
    }
    if (respInfra && respInfra.ok) {
      const infra = await respInfra.json();
      const fundosInfra = infra.fundos || [];
      fundosInfra.forEach(f => tickerDir[f["Ticker"]] = "infra");
      todosFiis = todosFiis.concat(fundosInfra);
    }
    if (respAgro && respAgro.ok) {
      const agro = await respAgro.json();
      const fundosAgro = agro.fundos || [];
      fundosAgro.forEach(f => tickerDir[f["Ticker"]] = "agro");
      todosFiis = todosFiis.concat(fundosAgro);
    }
  } catch (_) {}

  // Restaura nome da carteira
  const nomeEl = document.getElementById("res-nome-carteira");
  if (nomeEl) nomeEl.value = localStorage.getItem("sim_nome_carteira") || "";

  // Preenche valor da carteira
  const inp = document.getElementById("res-valor-total");
  if (valorTotal > 0) {
    inp.value = valorTotal.toLocaleString("pt-BR", {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  renderizarTabela();
  renderizarPizza(pesos);
  atualizarIndicadores(pesos);
  atualizarVisaoGeral();
  renderizarRetornoAcumulado(pesos);
  renderizarRendaMensal(pesos);
}

init();
