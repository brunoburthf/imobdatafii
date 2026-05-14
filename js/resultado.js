const TIPO_CARTEIRA = localStorage.getItem("sim_tipo") || "simulacao";

let carteira, pesos, valorTotal, transacoes;
if (TIPO_CARTEIRA === "acompanhamento") {
  carteira   = JSON.parse(localStorage.getItem("acomp_carteira") || "[]");
  // Carrega transacoes; se não existir, tenta migrar do schema antigo (posicoes)
  const txRaw = localStorage.getItem("acomp_transacoes");
  if (txRaw) {
    transacoes = JSON.parse(txRaw);
  } else {
    const posicoesAntigas = JSON.parse(localStorage.getItem("acomp_posicoes") || "{}");
    transacoes = [];
    for (const f of carteira) {
      const p = posicoesAntigas[f.ticker];
      if (p && p.quantidade > 0 && p.preco_medio > 0 && p.data_compra) {
        transacoes.push({
          ticker: f.ticker,
          tipo:   "compra",
          qtd:    p.quantidade,
          preco:  p.preco_medio,
          data:   p.data_compra
        });
      }
    }
    localStorage.setItem("acomp_transacoes", JSON.stringify(transacoes));
  }
  pesos      = {};
  valorTotal = 0;
} else {
  carteira   = JSON.parse(localStorage.getItem("sim_carteira")   || "[]");
  pesos      = JSON.parse(localStorage.getItem("sim_pesos")      || "{}");
  valorTotal = parseFloat(localStorage.getItem("sim_valor_total") || "0");
  transacoes = [];
}

// ─── CONSOLIDAÇÃO ─────────────────────────────────────────────────────────────
// Percorre transações em ordem cronológica e devolve, por ticker:
//   { pm, qtd_atual, ganho_realizado, tranches: [{data, qtd_atual}] }
// PM segue regra de média ponderada nas compras; vendas não alteram PM e
// reduzem cada tranche pro-rata. Ganho realizado = (preço_venda − pm) × qtd.
// Quantidade HISTÓRICA de cotas de um ticker numa data específica — calcula a
// partir das transações brutas, sem reduzir tranches retroativamente. Use isso
// (e não tr.qtd_atual de consolidarPorTicker) ao computar dividendos passados,
// pois `qtd_atual` das tranches reflete o estado APÓS vendas posteriores.
function qtdTickerNaData(ticker, dataIso, txs = transacoes) {
  let qtd = 0;
  for (const t of txs) {
    if (t.ticker !== ticker) continue;
    if (t.data > dataIso) continue;
    qtd += (t.tipo === "compra" ? 1 : -1) * t.qtd;
  }
  return Math.max(0, qtd);
}

function consolidarPorTicker(txs) {
  const sorted = [...txs].sort((a, b) =>
    a.data === b.data ? 0 : (a.data < b.data ? -1 : 1)
  );
  const out = {};
  for (const t of sorted) {
    if (!out[t.ticker]) {
      out[t.ticker] = { pm: 0, qtd_atual: 0, ganho_realizado: 0, tranches: [] };
    }
    const pos = out[t.ticker];
    if (t.tipo === "compra") {
      const totalCusto = pos.pm * pos.qtd_atual + t.preco * t.qtd;
      pos.qtd_atual += t.qtd;
      pos.pm = pos.qtd_atual > 0 ? totalCusto / pos.qtd_atual : 0;
      pos.tranches.push({ data: t.data, qtd_atual: t.qtd, preco: t.preco });
    } else {  // venda
      // Limita ao saldo existente: vendas excedentes (entrada inválida ou
      // migração legada) não podem inflar ganho_realizado sobre cotas fictícias.
      const qtdAntes = pos.qtd_atual;
      const qtdEfetiva = Math.min(t.qtd, qtdAntes);
      pos.ganho_realizado += (t.preco - pos.pm) * qtdEfetiva;
      pos.qtd_atual = Math.max(0, qtdAntes - t.qtd);
      if (qtdAntes > 0) {
        const fator = pos.qtd_atual / qtdAntes;
        pos.tranches = pos.tranches
          .map(tr => ({ ...tr, qtd_atual: tr.qtd_atual * fator }))
          .filter(tr => tr.qtd_atual > 0);
      } else {
        pos.tranches = [];
      }
    }
  }
  return out;
}

let todosFiis       = [];
let tickerDir       = {};  // ticker → "fiis" | "infra" | "agro"
let sugestaoIdx     = -1;
let vazioEl         = null;
let vazioAcompEl    = null;
let graficoPizza    = null;
let graficoRetorno  = null;
let graficoRenda    = null;
let proventosCache  = {};  // ticker -> array de proventos (cache pra cálculo)

// Paleta intercalada de laranjas e azuis — fatias adjacentes contrastam,
// e a cor da marca (#EF6300) abre a sequência.
const CORES_PIZZA = [
  "#EF6300", // laranja marca
  "#00093C", // navy escuro
  "#FF8534", // laranja médio
  "#2563EB", // azul royal
  "#B84A00", // laranja queimado
  "#60A5FA", // azul claro
  "#FFA873", // laranja suave
  "#1E3A8A", // azul-marinho médio
  "#7A3000", // laranja escuro
  "#3B82F6", // azul médio
  "#FFC9A8", // laranja pastel
  "#93C5FD"  // azul muito claro
];

// Cinza neutro usado quando o número de fatias é ímpar — sem ele, a primeira
// e a última fatia ficam adjacentes na pizza e seriam da mesma família
// (laranja, na sequência intercalada).
const COR_PIZZA_CINZA = "#6B7280";

function paletaPizza(n) {
  const cores = [];
  for (let i = 0; i < n; i++) cores.push(CORES_PIZZA[i % CORES_PIZZA.length]);
  if (n >= 3 && n % 2 === 1) cores[n - 1] = COR_PIZZA_CINZA;
  return cores;
}

// ─── SALVAR CARTEIRA ─────────────────────────────────────────────────────────

let _salvandoResultado = false;
let _estadoInicialResultado = null;

function snapshotEstadoResultado() {
  const nome = (document.getElementById("res-nome-carteira")?.value || "").trim();
  const tickers = carteira.map(f => f.ticker).join(",");
  if (TIPO_CARTEIRA === "acompanhamento") {
    return JSON.stringify({ nome, tickers, tx: transacoes });
  } else {
    const valor = parseValorCarteira(document.getElementById("res-valor-total")?.value);
    const pesosDom = {};
    document.querySelectorAll("#res-tbody tr[data-ticker]").forEach(tr => {
      const inp = tr.querySelector(".sim-peso-input");
      if (inp) pesosDom[tr.dataset.ticker] = parseFloat(inp.value) || 0;
    });
    return JSON.stringify({ nome, tickers, valor, pesos: pesosDom });
  }
}

function atualizarBtnSalvar() {
  const btn = document.getElementById("btn-salvar-resultado");
  if (!btn) return;
  const temConteudo = TIPO_CARTEIRA === "acompanhamento"
    ? (transacoes?.length > 0)
    : (carteira?.length > 0);

  if (!window.currentUser) {
    // Deslogado: oferece login se houver carteira pra salvar
    btn.textContent = "Fazer login e salvar";
    btn.style.display = temConteudo ? "" : "none";
    return;
  }

  // Logado: comportamento original (só aparece se houve mudança vs snapshot inicial)
  btn.textContent = "Salvar mudanças";
  if (_estadoInicialResultado == null) { btn.style.display = "none"; return; }
  const mudou = snapshotEstadoResultado() !== _estadoInicialResultado;
  btn.style.display = mudou ? "" : "none";
}

// Listener global de auth — atualiza o botão quando user loga/desloga
document.addEventListener("auth-state-changed", () => atualizarBtnSalvar());

async function salvarCarteiraResultado() {
  if (_salvandoResultado) return;
  if (!window.currentUser) {
    // Deslogado: redireciona pra tela de login mantendo a carteira no localStorage
    const ret = encodeURIComponent("resultado.html");
    window.location.href = `simulador.html?action=login&return=${ret}`;
    return;
  }
  if (!carteira.length) { alert("Adicione pelo menos um fundo antes de salvar."); return; }

  const nomeInput = document.getElementById("res-nome-carteira");
  const nome = (nomeInput?.value || "").trim();
  if (!nome) {
    alert("Dê um nome à sua carteira antes de salvar.");
    nomeInput?.focus();
    return;
  }

  const idKey   = TIPO_CARTEIRA === "acompanhamento" ? "acomp_carteira_id" : "sim_carteira_id";
  const idAtual = localStorage.getItem(idKey) || null;
  const status  = document.getElementById("res-salvar-status");

  let payload;
  if (TIPO_CARTEIRA === "acompanhamento") {
    payload = {
      name: nome,
      tipo: "acompanhamento",
      carteira: carteira,
      transacoes: transacoes
    };
  } else {
    const pesosAtuais = {};
    document.querySelectorAll("#res-tbody tr[data-ticker]").forEach(tr => {
      const inp = tr.querySelector(".sim-peso-input");
      if (inp) pesosAtuais[tr.dataset.ticker] = parseFloat(inp.value) || 0;
    });
    const pesosFinais = Object.keys(pesosAtuais).length ? pesosAtuais : pesos;
    const valorAtual = parseValorCarteira(document.getElementById("res-valor-total")?.value) || valorTotal;
    payload = {
      name: nome,
      tipo: "simulacao",
      carteira: carteira,
      pesos: pesosFinais,
      valor_total: valorAtual
    };
  }

  // Otimista: mostra "Carteira salva!" imediatamente
  if (status) {
    status.textContent = "Carteira salva!";
    status.className = "res-salvar-status res-salvar-ok";
    setTimeout(() => {
      if (status.textContent === "Carteira salva!") {
        status.textContent = "";
        status.className = "res-salvar-status";
      }
    }, 3000);
  }

  _salvandoResultado = true;
  try {
    const id = await salvarCarteiraFirestore(idAtual, payload);
    if (id) localStorage.setItem(idKey, id);
    _estadoInicialResultado = snapshotEstadoResultado();
    atualizarBtnSalvar();
  } catch (e) {
    const isLimit = e?.code === "limit-exceeded";
    if (status) {
      status.textContent = isLimit ? "Limite atingido." : "Erro ao salvar.";
      status.className = "res-salvar-status res-salvar-erro";
    }
    alert(isLimit ? e.message : "Erro ao salvar: " + e.message);
  } finally {
    _salvandoResultado = false;
  }
}

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

// SheetJS lazy-loaded só na 1a chamada de baixarResultadoExcel.
let _sheetJsCarregandoRes = null;
async function _carregarSheetJsRes() {
  if (window.XLSX) return;
  if (_sheetJsCarregandoRes) return _sheetJsCarregandoRes;
  _sheetJsCarregandoRes = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Falha ao carregar SheetJS"));
    document.head.appendChild(s);
  });
  return _sheetJsCarregandoRes;
}

async function baixarResultadoExcel(btn) {
  if (!carteira.length) { alert("Nada a exportar."); return; }
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Preparando..."; }

  try {
    await _carregarSheetJsRes();

    const nome = (document.getElementById("res-nome-carteira")?.value || "").trim() || "Carteira";
    const dataExp = new Date().toLocaleString("pt-BR");
    const idx = {};
    todosFiis.forEach(f => { idx[f["Ticker"]] = f; });

    function montarAba(titulo, totalLinha, linhas) {
      const cabecalho = Object.keys(linhas[0]);
      const aoa = [
        [titulo],
        [`Carteira: ${nome}`],
        [`Exportado em: ${dataExp}`],
        [totalLinha],
        [],
        cabecalho,
        ...linhas.map(r => cabecalho.map(c => r[c])),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const w = [10, 30, 22];
      while (w.length < cabecalho.length) w.push(16);
      ws["!cols"] = w.map(wch => ({ wch }));
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: cabecalho.length - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: cabecalho.length - 1 } },
        { s: { r: 2, c: 0 }, e: { r: 2, c: cabecalho.length - 1 } },
        { s: { r: 3, c: 0 }, e: { r: 3, c: cabecalho.length - 1 } },
      ];
      return ws;
    }

    const wb = XLSX.utils.book_new();

    if (TIPO_CARTEIRA === "acompanhamento") {
      // Aba 1: posicao consolidada (PM, qtd, custo + metricas atuais)
      const consol = consolidarPorTicker(transacoes || []);
      const linhasPos = [];
      let custoTotal = 0;
      let valorAtualTotal = 0;
      carteira.forEach(f => {
        const t = f.ticker;
        const p = consol[t];
        if (!p) return;
        const meta = idx[t] || {};
        const precoAtual = meta["Preço Atual"] ?? null;
        const custo = +(p.pm * p.qtd_atual).toFixed(2);
        const valorAtual = precoAtual ? +(precoAtual * p.qtd_atual).toFixed(2) : null;
        const pl = (valorAtual != null) ? +(valorAtual - custo + p.ganho_realizado).toFixed(2) : null;
        custoTotal += custo;
        if (valorAtual) valorAtualTotal += valorAtual;
        const dy = meta["DY a.a."];
        linhasPos.push({
          Ticker: t,
          Nome: meta["Nome"] || f.nome || "",
          Setor: meta["Setor"] || meta["Tipo"] || f.setor || "",
          "Preço Médio (R$)": +p.pm.toFixed(4),
          "Quantidade": p.qtd_atual,
          "Custo (R$)": custo,
          "Preço Atual (R$)": precoAtual,
          "Valor Atual (R$)": valorAtual,
          "Ganho Realizado (R$)": +p.ganho_realizado.toFixed(2),
          "P&L Total (R$)": pl,
          "P/VP": meta["P/VP"] ?? null,
          "DY a.a. (%)": dy != null ? +(dy * 100).toFixed(2) : null,
        });
      });
      if (linhasPos.length) {
        XLSX.utils.book_append_sheet(
          wb,
          montarAba("Acompanhamento — Posições", `Custo total: R$ ${formatarBRL(custoTotal)}  •  Valor atual: R$ ${formatarBRL(valorAtualTotal)}`, linhasPos),
          "Posições"
        );
      }

      // Aba 2: transacoes (historico de operacoes)
      if (transacoes && transacoes.length) {
        const linhasTx = [...transacoes]
          .sort((a, b) => (a.data === b.data ? 0 : a.data < b.data ? -1 : 1))
          .map(t => ({
            Data: t.data || "",
            Ticker: t.ticker,
            Tipo: t.tipo,
            Quantidade: t.qtd,
            "Preço (R$)": t.preco,
            "Total (R$)": +(t.preco * t.qtd).toFixed(2),
          }));
        XLSX.utils.book_append_sheet(
          wb,
          montarAba("Histórico de Transações", `Total de operações: ${linhasTx.length}`, linhasTx),
          "Transações"
        );
      }
    } else {
      // Modo simulacao: peso + valor de posicao + metricas atuais
      const valorTotalCarteira = parseValorCarteira(document.getElementById("res-valor-total")?.value) || 0;
      const linhasSim = [];
      document.querySelectorAll("#res-tbody tr[data-ticker]").forEach(tr => {
        const t = tr.dataset.ticker;
        const meta = idx[t] || {};
        const peso = parseFloat(tr.querySelector(".sim-peso-input")?.value) || 0;
        const dy = meta["DY a.a."];
        const ultDiv = meta["Último Dividendo Pago"] ?? meta["Ultimo Dividendo Pago"];
        linhasSim.push({
          Ticker: t,
          Nome: meta["Nome"] || "",
          Setor: meta["Setor"] || meta["Tipo"] || "",
          "Peso (%)": peso || null,
          "Valor da Posição (R$)": valorTotalCarteira && peso ? +(valorTotalCarteira * peso / 100).toFixed(2) : null,
          "P/VP": meta["P/VP"] ?? null,
          "DY a.a. (%)": dy != null ? +(dy * 100).toFixed(2) : null,
          "Preço Atual (R$)": meta["Preço Atual"] ?? null,
          "Último Dividendo (R$)": ultDiv ?? null,
        });
      });
      if (linhasSim.length) {
        XLSX.utils.book_append_sheet(
          wb,
          montarAba("Simulação de Carteira", `Valor total: R$ ${formatarBRL(valorTotalCarteira)}`, linhasSim),
          "Simulação"
        );
      }
    }

    if (!wb.SheetNames.length) { alert("Nada a exportar."); return; }
    const safeName = nome.replace(/[\\/:*?"<>|]+/g, "_");
    const dt = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `${safeName}_${dt}.xlsx`);
  } catch (e) {
    alert("Erro ao gerar Excel: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
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
  atualizarBtnSalvar();
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

  atualizarBtnSalvar();
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
  const cores  = paletaPizza(labels.length);

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

  // Soma fixa dos pesos da carteira — usada como denominador estável (não muda
  // dia-a-dia conforme presença de cotação). Em geral ≈ 100, mas se o usuário
  // deixou pesos somando menos, respeita esse total.
  const somaPesoTotal = carteira.reduce(
    (s, f) => s + Math.max(0, pesosAtivos[f.ticker] || 0), 0
  );

  for (let i = 1; i < datesJanela.length; i++) {
    const d  = datesJanela[i];
    const d0 = datesJanela[i - 1];
    if (d < dataMin) continue;

    // Retorno ponderado carteira: FIIs sem cotação no dia (p0 ou p1 ausentes)
    // contribuem zero — equivalente a "preço manteve" — em vez de renormalizar
    // os pesos disponíveis, o que distorceria volatilidade e retorno acumulado.
    let retPond = 0;
    for (const f of carteira) {
      const peso = pesosAtivos[f.ticker] || 0;
      if (peso <= 0) continue;
      const p0 = precosPor[f.ticker]?.[d0];
      const p1 = precosPor[f.ticker]?.[d];
      if (p0 > 0 && p1 > 0) {
        retPond += peso * (p1 / p0 - 1);
      }
    }
    if (somaPesoTotal > 0) {
      const retDiario = retPond / somaPesoTotal;
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

  // Busca histórico via cache compartilhado e prefere a série AJUSTADA: como
  // a fórmula compara preço_mês/preço_atual, qualquer split/grupamento entre
  // as duas datas distorce o ratio se usar nominal.
  const resultados = await Promise.all(carteira.map(async f => {
    try {
      const cache = await carregarHistoricoPreco(f.ticker);
      const fonte = (cache.adj && Object.keys(cache.adj).length) ? cache.adj : cache.nominal;
      return { ticker: f.ticker, precos: fonte || {} };
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
    // Normaliza por somaPeso para casar com o card "Renda mensal" do topo
    // (que usa dyMedio = somaDY/somaPeso). Quando algum FII não tem DY no
    // índice, projeta-se a renda como se ele rendesse o DY médio dos demais.
    return vc > 0 ? parseFloat((vc * rendaPonderada / somaPeso).toFixed(2)) : 0;
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

// Cache do detalhe (Comentário + Mês Ref) por ticker — evita re-fetch a cada
// renderização. Os índices não trazem "Mês Ref. Comentário", só os arquivos individuais.
const _cacheDetalheFundo = {};
async function carregarDetalheFundo(ticker) {
  if (_cacheDetalheFundo[ticker] !== undefined) return _cacheDetalheFundo[ticker];
  const dir = tickerDir[ticker] || "fiis";
  try {
    const r = await fetch(`data/${dir}/${ticker}.json`);
    if (!r.ok) { _cacheDetalheFundo[ticker] = null; return null; }
    const d = await r.json();
    const dados = d.dados || d;
    _cacheDetalheFundo[ticker] = {
      comentario: (dados["Comentário"] || "").trim(),
      mesRef:     (dados["Mês Ref. Comentário"] || "").trim(),
      visaoGeral: (dados["Visão Geral"] || "").trim()
    };
    return _cacheDetalheFundo[ticker];
  } catch {
    _cacheDetalheFundo[ticker] = null;
    return null;
  }
}

let _visaoGeralGen = 0;
async function atualizarVisaoGeral() {
  const container = document.getElementById("res-visao-geral");
  if (!container) return;
  const myGen = ++_visaoGeralGen;

  const itens = await Promise.all(carteira.map(async f => {
    const fiiData = todosFiis.find(d => d["Ticker"] === f.ticker);
    const det = await carregarDetalheFundo(f.ticker);
    // Prioridade: Comentário do arquivo individual → Comentário do índice → Visão Geral.
    const comentario = (det?.comentario || (fiiData?.["Comentário"] || "")).trim();
    const visaoGeral = (det?.visaoGeral || (fiiData?.["Visão Geral"] || "")).trim();
    const texto      = comentario || visaoGeral || null;
    const mesRef     = comentario && det?.mesRef ? det.mesRef : "";  // só mostra mês se o texto exibido vier do Comentário
    return { ticker: f.ticker, texto, mesRef };
  }));

  // Se outra chamada começou enquanto esta aguardava, aborta para evitar duplicação.
  if (myGen !== _visaoGeralGen) return;

  container.innerHTML = "";
  for (const item of itens) {
    const bloco = document.createElement("div");
    bloco.className = "res-visao-bloco";
    const sufixoMes = item.mesRef ? ` <span class="res-visao-mes">(${item.mesRef})</span>` : "";
    bloco.innerHTML = `
      <div class="res-visao-ticker">${item.ticker}${sufixoMes}</div>
      <div class="res-visao-texto">${item.texto || "<em>Sem descrição disponível.</em>"}</div>
    `;
    container.appendChild(bloco);
  }
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
  // Apenas Simulação usa esta função (a busca está oculta em Acompanhamento).
  if (TIPO_CARTEIRA === "acompanhamento") return;
  if (carteira.find(f => f.ticker === ticker)) return;
  const fii = todosFiis.find(f => f["Ticker"] === ticker);
  if (!fii) return;

  carteira.push({ ticker, nome: fii["Nome"] || "", setor: fii["Setor"] || "" });

  document.getElementById("res-busca").value = "";
  document.getElementById("res-sugestoes").style.display = "none";

  pesos[ticker] = 0;
  localStorage.setItem("sim_carteira", JSON.stringify(carteira));
  localStorage.setItem("sim_pesos",    JSON.stringify(pesos));
  renderizarTabela();
  renderizarPizza(pesos);
  atualizarIndicadores(pesos);
  atualizarVisaoGeral();
  renderizarRetornoAcumulado(pesos);
  renderizarRendaMensal(pesos);
  atualizarBtnSalvar();
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
  atualizarBtnSalvar();
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

// ─── ACOMPANHAMENTO ──────────────────────────────────────────────────────────

function getPrecoAtual(ticker) {
  // Prefere o último preço do _historicoPrecoCache (mesma fonte usada pelo
  // TWR / gráfico de Valor de Mercado) para evitar descompasso entre cards
  // e tabelas: depois de um update de prices.json, o histórico individual
  // do FII já está atualizado, mas o índice estático (todosFiis) só refresca
  // quando o gerar_dados.py rodar.
  const cache = _historicoPrecoCache[ticker];
  if (cache && cache.nominal) {
    const datas = Object.keys(cache.nominal);
    if (datas.length) {
      let ultima = datas[0];
      for (const d of datas) if (d > ultima) ultima = d;
      const p = cache.nominal[ultima];
      if (p > 0) return p;
    }
  }
  const fii = todosFiis.find(d => d["Ticker"] === ticker);
  return fii?.["Preço Atual"] ?? 0;
}

const _proventosInflight = {};
async function carregarProventosTicker(ticker) {
  if (proventosCache[ticker]) return proventosCache[ticker];
  if (_proventosInflight[ticker]) return _proventosInflight[ticker];
  _proventosInflight[ticker] = (async () => {
    try {
      const r = await fetch(`data/proventos/${ticker}.json`);
      if (!r.ok) return [];
      const d = await r.json();
      const proventos = (d.proventos || []).filter(p => p.tipo === "Rendimento");
      proventosCache[ticker] = proventos;
      return proventos;
    } catch { return []; }
    finally { delete _proventosInflight[ticker]; }
  })();
  return _proventosInflight[ticker];
}

function renderizarTabelaAcomp() {
  const tbody = document.getElementById("res-acomp-tbody");
  const tfoot = document.getElementById("res-acomp-tfoot");
  const vazio = vazioAcompEl;
  if (!tbody || !vazio) return;

  if (!transacoes.length) {
    tbody.innerHTML = "";
    tbody.appendChild(vazio);
    vazio.style.display = "";
    tfoot.style.display = "none";
    return;
  }

  vazio.style.display = "none";
  tfoot.style.display = "";

  // Ordena transações por data desc para listar a mais recente em cima
  const ordenadas = transacoes
    .map((t, idx) => ({ ...t, _idx: idx }))
    .sort((a, b) => a.data === b.data ? b._idx - a._idx : (a.data < b.data ? 1 : -1));

  tbody.innerHTML = "";
  ordenadas.forEach(t => {
    const total = (t.preco || 0) * (t.qtd || 0);
    const tr = document.createElement("tr");
    const ehVenda = t.tipo === "venda";
    tr.innerHTML = `
      <td class="ticker-cell">${t.ticker}</td>
      <td><span class="op-tipo-badge ${ehVenda ? "venda" : "compra"}">${ehVenda ? "Venda" : "Compra"}</span></td>
      <td class="num">${formatarBRL(t.preco || 0)}</td>
      <td class="num">${t.qtd || 0}</td>
      <td class="num">${formatarDataBR(t.data)}</td>
      <td class="num">${formatarBRL(total)}</td>
      <td>
        <button class="sim-remover" onclick="removerOperacao(${t._idx})" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function formatarDataBR(iso) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function onTransacoesChange() {
  _twrCache = {};
  _twrInflight = {};   // descarta cálculos em curso pra não sobrescrever o cache com dados antigos
  // Reconstrói carteira a partir das transações (tickers únicos com qtd_atual > 0)
  const consolidado = consolidarPorTicker(transacoes);
  const setTickers = new Set(Object.keys(consolidado));
  // Mantém ordem original; remove tickers sem operações; adiciona novos no fim
  carteira = carteira.filter(f => setTickers.has(f.ticker));
  for (const tk of setTickers) {
    if (!carteira.find(f => f.ticker === tk)) {
      const fii = todosFiis.find(d => d["Ticker"] === tk);
      carteira.push({ ticker: tk, nome: fii?.["Nome"] || "", setor: fii?.["Setor"] || "" });
    }
  }
  localStorage.setItem("acomp_carteira",   JSON.stringify(carteira));
  localStorage.setItem("acomp_transacoes", JSON.stringify(transacoes));

  renderizarTabelaAcomp();
  atualizarCustoTotalAcomp();
  atualizarIndicadoresAcomp();
  renderizarPizzaAcomp();
  atualizarVisaoGeral();
  renderizarEvolucaoValor();
  renderizarDividendosPorMes();
  renderizarDYMensal();
  renderizarTabelaVendasEncerradas();
  renderizarTabelaGeralAcomp();
  renderizarRetornoAcumuladoCarteira();
  renderizarTabelaMensalCarteira();
  atualizarBtnSalvar();
}

function atualizarCustoTotalAcomp() {
  const consolidado = consolidarPorTicker(transacoes);
  let total = 0;
  for (const tk of Object.keys(consolidado)) {
    const c = consolidado[tk];
    total += c.pm * c.qtd_atual;
  }
  const tot = document.getElementById("res-acomp-total");
  if (tot) tot.textContent = total > 0 ? formatarBRL(total) : "—";
  const tot2 = document.getElementById("acomp-res-custo-total");
  if (tot2) tot2.textContent = total > 0
    ? total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "0,00";
}

let _indicadoresAcompGen = 0;
async function atualizarIndicadoresAcomp() {
  // Anti-race: edições rápidas em transações disparam várias chamadas; sem
  // gerador, uma execução lenta pode sobrescrever os cards com dados antigos
  // depois que a chamada mais recente já terminou.
  const myGen = ++_indicadoresAcompGen;

  const consolidado = consolidarPorTicker(transacoes);

  let custoTotal = 0;
  let valorAtual = 0;
  let ganhoRealizadoTot = 0;

  for (const tk of Object.keys(consolidado)) {
    const c = consolidado[tk];
    custoTotal += c.pm * c.qtd_atual;
    const precoAtual = getPrecoAtual(tk);
    valorAtual += precoAtual * c.qtd_atual;
    ganhoRealizadoTot += c.ganho_realizado;
  }

  // Dividendos por tranche: cada tranche recebe sobre os proventos com data_com >= data_da_tranche
  let dividendosRecebidos = 0;
  for (const tk of Object.keys(consolidado)) {
    const c = consolidado[tk];
    const proventos = await carregarProventosTicker(tk);
    if (myGen !== _indicadoresAcompGen) return;
    for (const pv of proventos) {
      if (!pv.data_com) continue;
      const qtdNaData = qtdTickerNaData(tk, pv.data_com);
      if (qtdNaData > 0) dividendosRecebidos += (pv.valor || 0) * qtdNaData;
    }
  }

  const ganhoCapital = valorAtual - custoTotal;
  const retornoTotal = ganhoCapital + dividendosRecebidos + ganhoRealizadoTot;
  const retornoPct   = custoTotal > 0 ? retornoTotal / custoTotal : 0;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  // ── Cards-resumo (acima da tabela) ──────────────────────────────────────
  const resultadoCotas = ganhoCapital + ganhoRealizadoTot;

  const setSinal = (id, valorR$, vencido) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("valor-positivo", "valor-negativo");
    if (!vencido) { el.textContent = "—"; return; }
    el.textContent = formatarBRL(valorR$);
    if (Math.abs(valorR$) > 1e-9) {
      el.classList.add(valorR$ >= 0 ? "valor-positivo" : "valor-negativo");
    }
  };

  setSinal("ac-topo-retorno-total",   retornoTotal,   custoTotal > 0);
  setSinal("ac-topo-resultado-cotas", resultadoCotas, custoTotal > 0);
  set("ac-topo-dividendos", dividendosRecebidos > 0 ? formatarBRL(dividendosRecebidos) : "—");
  set("ac-topo-retorno-total-sub",
      custoTotal > 0
        ? `${(retornoPct * 100).toFixed(2)}% sobre o custo`
        : "Cotas + Dividendos");

  // % do CDI (carteira / CDI) — assíncrono porque depende do helper de CDI
  const elTopoRet = document.getElementById("ac-topo-retorno-carteira");
  const elTopoSub = document.getElementById("ac-topo-retorno-carteira-sub");
  if (elTopoRet && elTopoSub) {
    elTopoRet.classList.remove("valor-positivo", "valor-negativo");
    elTopoRet.textContent = "—";
    elTopoSub.textContent = "Carteira — · CDI —";
    computarTWR().then(twr => {
      if (myGen !== _indicadoresAcompGen) return;
      if (twr.finalTWR == null) return;
      const cart = twr.finalTWR;
      const cdi  = twr.finalCDI;
      // Sub-linha: comparação direta carteira vs CDI no mesmo período
      elTopoSub.textContent =
        `Carteira ${(cart * 100).toFixed(2)}% · CDI ${cdi != null ? (cdi * 100).toFixed(2) + "%" : "—"}`;
      // Valor principal: % do CDI = retorno_carteira / retorno_cdi × 100
      // Exige CDI estritamente positivo + acima de um piso pra evitar divisão
      // por valor minúsculo (que estouraria o pctDoCDI) e a inversão de sinal
      // teórica quando ambos são negativos.
      if (cdi != null && cdi > 1e-6) {
        const pctDoCDI = (cart / cdi) * 100;
        elTopoRet.textContent = `${pctDoCDI.toFixed(0)}% do CDI`;
        // Verde se bateu o CDI (>100%), vermelho se ficou abaixo
        if (pctDoCDI > 100) elTopoRet.classList.add("valor-positivo");
        else if (pctDoCDI < 100) elTopoRet.classList.add("valor-negativo");
      } else {
        elTopoRet.textContent = "—";
      }
    }).catch(() => {});
  }
}

function renderizarPizzaAcomp() {
  const consolidado = consolidarPorTicker(transacoes);
  const porSetor = {};
  for (const tk of Object.keys(consolidado)) {
    const c = consolidado[tk];
    const valor = c.qtd_atual * getPrecoAtual(tk);
    if (valor <= 0) continue;
    const fii = carteira.find(f => f.ticker === tk) || todosFiis.find(d => d["Ticker"] === tk);
    const setor = fii?.setor || fii?.["Setor"] || "Outros";
    porSetor[setor] = (porSetor[setor] || 0) + valor;
  }
  const totalGeral = Object.values(porSetor).reduce((s, v) => s + v, 0);
  const labels = Object.keys(porSetor);
  const dados = labels.map(s => totalGeral > 0 ? parseFloat((100 * porSetor[s] / totalGeral).toFixed(2)) : 0);
  const cores = paletaPizza(labels.length);

  const ctx = document.getElementById("grafico-setores")?.getContext("2d");
  if (!ctx) return;
  if (graficoPizza) graficoPizza.destroy();
  if (!labels.length) return;

  graficoPizza = new Chart(ctx, {
    type: "pie",
    plugins: [ChartDataLabels],
    data: {
      labels,
      datasets: [{ data: dados, backgroundColor: cores, borderColor: "#fff", borderWidth: 2, hoverOffset: 8 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: c => ` ${c.label}: ${c.parsed.toFixed(2)}%` }
        },
        datalabels: {
          color: "#fff",
          font: { size: 11, weight: "700" },
          textAlign: "center",
          formatter: (value, c) => `${c.chart.data.labels[c.dataIndex]}\n${value.toFixed(1)}%`,
          display: c => c.dataset.data[c.dataIndex] >= 3
        }
      }
    }
  });
}

// Cache em memória do histórico de preços por ticker — devolve { adj, nominal }.
// `adj` é usado pelo TWR (retorno total via preço ajustado por proventos);
// `nominal` é o preço de tela, usado no gráfico de Valor de Mercado e no DY.
const _historicoPrecoCache    = {};
const _historicoPrecoInflight = {};
async function carregarHistoricoPreco(ticker) {
  if (_historicoPrecoCache[ticker]) return _historicoPrecoCache[ticker];
  if (_historicoPrecoInflight[ticker]) return _historicoPrecoInflight[ticker];
  _historicoPrecoInflight[ticker] = (async () => {
    try {
      const dir = tickerDir[ticker] || "fiis";
      const r = await fetch(`data/${dir}/${ticker}.json`);
      if (!r.ok) return { adj: {}, nominal: {} };
      const d = await r.json();
      const serieAdj = (d.historico_preco_adj && d.historico_preco_adj.length)
        ? d.historico_preco_adj
        : (d.historico_preco || []);
      const serieNom = d.historico_preco || serieAdj;  // fallback se só houver adj
      const adj = {}, nominal = {};
      for (const [data, p] of serieAdj) adj[data] = p;
      for (const [data, p] of serieNom) nominal[data] = p;
      const result = { adj, nominal };
      _historicoPrecoCache[ticker] = result;
      return result;
    } catch { return { adj: {}, nominal: {} }; }
    finally { delete _historicoPrecoInflight[ticker]; }
  })();
  return _historicoPrecoInflight[ticker];
}

let graficoEvolucaoValor    = null;
let graficoDivsMes          = null;
let graficoDYMensal         = null;
let graficoRetornoCarteira  = null;
let _dividendosPeriodo      = "MAX";   // filtro do card de Dividendos (1M/3M/6M/1A/MAX)

// Recorta os últimos N meses dos arrays paralelos do card Dividendos.
function _slicePeriodoDividendos(...arrays) {
  if (_dividendosPeriodo === "MAX") return arrays;
  const n = _dividendosPeriodo === "1M" ? 1
          : _dividendosPeriodo === "3M" ? 3
          : _dividendosPeriodo === "6M" ? 6
          : 12;  // 1A
  return arrays.map(a => a.slice(-n));
}

function filtrarDividendos(periodo) {
  document.querySelectorAll('.btn-periodo[data-chart="dividendos"]').forEach(b => {
    b.classList.toggle("ativo", b.dataset.periodo === periodo);
  });
  _dividendosPeriodo = periodo;
  renderizarDividendosPorMes();
  renderizarDYMensal();
}

async function renderizarEvolucaoValor() {
  const ctx = document.getElementById("grafico-evolucao-valor")?.getContext("2d");
  if (!ctx) return;
  if (graficoEvolucaoValor) { graficoEvolucaoValor.destroy(); graficoEvolucaoValor = null; }

  // Reusa o TWR: já tem labels, datasIso e patrimEod por dia, com a mesma
  // grade de datas usada no gráfico de Retorno Acumulado vs CDI — eixos batem.
  const twr = await computarTWR();
  if (!twr.labels?.length || !twr.patrimEod) return;

  // Custo acumulado por data: percorre transações em ordem e registra o custo
  // total da carteira após cada evento. Para datas sem evento, usa o último.
  const sortedTx = [...transacoes].sort((a, b) =>
    a.data === b.data ? 0 : (a.data < b.data ? -1 : 1)
  );
  const estado = {};
  const custoEvento = [];   // [{data, custo}]
  for (const t of sortedTx) {
    if (!estado[t.ticker]) estado[t.ticker] = { pm: 0, qtd: 0 };
    const e = estado[t.ticker];
    if (t.tipo === "compra") {
      const totalCusto = e.pm * e.qtd + t.preco * t.qtd;
      e.qtd += t.qtd;
      e.pm   = e.qtd > 0 ? totalCusto / e.qtd : 0;
    } else {
      e.qtd = Math.max(0, e.qtd - t.qtd);
    }
    let custoTot = 0;
    for (const tk of Object.keys(estado)) custoTot += estado[tk].pm * estado[tk].qtd;
    custoEvento.push({ data: t.data, custo: custoTot });
  }
  function custoEm(d) {
    let last = 0;
    for (const e of custoEvento) {
      if (e.data <= d) last = e.custo;
      else break;
    }
    return last;
  }

  const labels  = twr.labels;
  const valores = twr.patrimEod.map(v => parseFloat((v || 0).toFixed(2)));
  const custos  = twr.datasIso.map(d => parseFloat(custoEm(d).toFixed(2)));

  if (!labels.length) return;

  graficoEvolucaoValor = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Valor de Mercado",
          data: valores,
          borderColor: "#EF6300",
          backgroundColor: "#EF630018",
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2
        },
        {
          label: "Custo Investido",
          data: custos,
          borderColor: "rgb(0,9,60)",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true, position: "top",
          labels: { font: { size: 12 }, usePointStyle: true, pointStyleWidth: 10 }
        },
        datalabels: { display: false },
        tooltip: {
          callbacks: { label: c => ` ${c.dataset.label}: ${formatarBRL(c.parsed.y)}` }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 11 }, callback: v => "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

async function renderizarDividendosPorMes() {
  const ctx = document.getElementById("grafico-divs-mes")?.getContext("2d");
  if (!ctx) return;
  if (graficoDivsMes) { graficoDivsMes.destroy(); graficoDivsMes = null; }

  // Inclui tickers totalmente vendidos (precisam aparecer pelos dividendos passados)
  const tickersComOps = [...new Set(transacoes.map(t => t.ticker))];
  if (!tickersComOps.length) return;

  const porMes = {};  // "YYYY-MM" → soma
  for (const tk of tickersComOps) {
    const proventos = await carregarProventosTicker(tk);
    for (const pv of proventos) {
      if (!pv.data_com) continue;
      const qtdNaData = qtdTickerNaData(tk, pv.data_com);
      if (qtdNaData <= 0) continue;
      const ym = pv.data_com.slice(0, 7);
      porMes[ym] = (porMes[ym] || 0) + (pv.valor || 0) * qtdNaData;
    }
  }

  if (!Object.keys(porMes).length) return;

  const MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const dataMin = transacoes.reduce((m, t) => t.data < m ? t.data : m, "9999-12-31");
  const [yMin, mMin] = dataMin.slice(0, 7).split("-").map(Number);
  const hoje = new Date();
  const labels = [];
  const dados  = [];
  let y = yMin, m = mMin;
  while (y < hoje.getFullYear() || (y === hoje.getFullYear() && m <= hoje.getMonth() + 1)) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    labels.push(`${MESES_PT[m - 1]}/${String(y).slice(2)}`);
    dados.push(parseFloat((porMes[ym] || 0).toFixed(2)));
    m++;
    if (m > 12) { m = 1; y++; }
  }

  // Aplica filtro de período do card Dividendos
  const [labelsF, dadosF] = _slicePeriodoDividendos(labels, dados);

  graficoDivsMes = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labelsF,
      datasets: [{
        label: "Dividendos (R$)",
        data: dadosF,
        backgroundColor: "rgba(239,99,0,0.85)",
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
          callbacks: { label: c => ` ${formatarBRL(c.parsed.y)}` }
        }
      },
      scales: {
        x: { ticks: { font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 11 }, callback: v => "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

// DY mensal da carteira = dividendos do mês / patrimônio no fim do mês anterior
// (1º mês exibido e mês corrente são parciais → barra mais clara)
async function renderizarDYMensal() {
  const ctx = document.getElementById("grafico-dy-mensal")?.getContext("2d");
  if (!ctx) return;
  if (graficoDYMensal) { graficoDYMensal.destroy(); graficoDYMensal = null; }

  // Inclui tickers totalmente vendidos (já receberam dividendos no passado)
  const tickersComOps = [...new Set(transacoes.map(t => t.ticker))];
  if (!tickersComOps.length) return;

  const twr = await computarTWR();
  if (!twr.datasIso?.length || !twr.patrimEod) return;

  // Patrim total da carteira numa data ISO — pega o último ponto disponível ≤ dataIso.
  function patrimNaData(dataIso) {
    let last = 0;
    for (let i = 0; i < twr.datasIso.length; i++) {
      if (twr.datasIso[i] <= dataIso) last = twr.patrimEod[i] || 0;
      else break;
    }
    return last;
  }

  // Para cada provento dentro de cada mês, contribui ao DY do mês com:
  //   contribuição = valor_recebido / patrim_total_na_data_ex × 100
  // Soma das contribuições de todos os proventos no mês = DY[M].
  // Isso casa numerador (o quanto rendeu) com denominador (carteira que existia
  // quando o provento foi declarado), independente de aportes ou vendas no mês.
  const dyPorMes = {};
  for (const tk of tickersComOps) {
    const proventos = await carregarProventosTicker(tk);
    for (const pv of proventos) {
      if (!pv.data_com) continue;
      const qtdNaData = qtdTickerNaData(tk, pv.data_com);
      if (qtdNaData <= 0) continue;
      const valorRecebido = (pv.valor || 0) * qtdNaData;
      const patrim = patrimNaData(pv.data_com);
      if (patrim <= 0) continue;
      const ym = pv.data_com.slice(0, 7);
      dyPorMes[ym] = (dyPorMes[ym] || 0) + (valorRecebido / patrim) * 100;
    }
  }

  // Último idx disponível por mês
  const lastIdxPorMes = {};
  twr.datasIso.forEach((d, i) => { lastIdxPorMes[d.slice(0, 7)] = i; });
  const mesesOrd = Object.keys(lastIdxPorMes).sort();

  // CDI mensal: fator acumulado entre o último dia do mês anterior e o último dia do mês
  const cdiHelper = await getCDIHelper();

  // Mês corrente (para marcar como parcial)
  const hoje = new Date();
  const ymCorrente = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;

  const NOMES_MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const labels = [];
  const dyArr  = [];
  const cdiArr = [];
  const parcial = [];   // booleans: true se o mês é parcial

  for (let i = 0; i < mesesOrd.length; i++) {
    const ym = mesesOrd[i];
    const idxFim  = lastIdxPorMes[ym];
    // Para o 1º mês, usa o ponto inicial do TWR (índice 0) — equivalente à
    // data da primeira transação. Para meses seguintes, último dia do mês
    // anterior. Sem isso o 1º mês teria dataIni === dataFim e o CDI zeraria.
    const idxBase = i > 0 ? lastIdxPorMes[mesesOrd[i - 1]] : 0;

    const dy = dyPorMes[ym] || 0;

    // CDI mede a janela do mês (último dia de M-1 → último dia de M);
    // no 1º mês, da data inicial do TWR até o fim do mês.
    let cdiMes = 0;
    if (cdiHelper) {
      let dataIni = twr.datasIso[idxBase];
      let dataFim = twr.datasIso[idxFim];

      // Caso de borda: 1º mês com apenas UMA data no TWR (ex: compra no
      // último dia útil do mês, ou FII com histórico curto). dataIni ===
      // dataFim → fatorEntre devolveria 1 e o CDI zeraria. Estende dataFim
      // até o último dia do mês calendário (ou hoje, se o mês corrente).
      if (i === 0 && dataIni === dataFim) {
        const [yy, mm] = ym.split("-").map(Number);
        const fimMesCal = new Date(yy, mm, 0);   // dia 0 do mês seguinte = último de mm
        const hoje = new Date();
        const fim = fimMesCal < hoje ? fimMesCal : hoje;
        dataFim = fim.toISOString().slice(0, 10);
      }

      cdiMes = (cdiHelper.fatorEntre(dataIni, dataFim) - 1) * 100;
    }

    const [y, m] = ym.split("-");
    labels.push(`${NOMES_MES[parseInt(m, 10) - 1]}/${y.slice(2)}`);
    dyArr.push(parseFloat(dy.toFixed(4)));
    cdiArr.push(parseFloat(cdiMes.toFixed(4)));
    parcial.push(ym === ymCorrente);
  }

  const corDYCheia   = "rgba(0,9,60,0.85)";
  const corDYParcial = "rgba(0,9,60,0.35)";

  // Aplica filtro de período do card Dividendos
  const [labelsF, dyArrF, cdiArrF, parcialF] = _slicePeriodoDividendos(labels, dyArr, cdiArr, parcial);

  graficoDYMensal = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labelsF,
      datasets: [
        {
          type: "bar",
          label: "Dividend Yield",
          data: dyArrF,
          backgroundColor: parcialF.map(p => p ? corDYParcial : corDYCheia),
          borderColor: "rgba(0,9,60,1)",
          borderWidth: 1,
          borderRadius: 4,
          order: 2
        },
        {
          type: "line",
          label: "CDI",
          data: cdiArrF,
          borderColor: "#EF6300",
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: "#EF6300",
          pointBorderColor: "#fff",
          pointBorderWidth: 1,
          fill: false,
          tension: 0.25,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true, position: "top",
          labels: { font: { size: 12 }, usePointStyle: true, pointStyleWidth: 10 }
        },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const sufixo = c.datasetIndex === 0 && parcialF[c.dataIndex] ? "  (parcial)" : "";
              return ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}%${sufixo}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 11 }, callback: v => v.toFixed(2) + "%" },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });
}

// CDI acumulado por data — cache + helper que retorna fator multiplicativo
// (ex.: 1.12 = +12%) entre uma data inicial e o último dia disponível.
let _cdiHelperCache = null;   // { dataMin, fatorDesde, fatorTotal }
async function getCDIHelper() {
  // Pega a menor data de transação como base; se mudou, recalcula
  if (!transacoes.length) return null;
  const dataMin = transacoes.reduce((m, t) => t.data < m ? t.data : m, "9999-12-31");
  if (_cdiHelperCache && _cdiHelperCache.dataMin === dataMin) return _cdiHelperCache;

  const cdiMap = await buscarCDI(dataMin);
  const datas  = Object.keys(cdiMap).sort();
  if (!datas.length) { _cdiHelperCache = null; return null; }

  // Fator cumulativo: cumFactor[d] = produto de (1+rate) de datas[0] até d
  const cumFactor = {};
  let cum = 1;
  for (const d of datas) {
    cum *= (1 + (cdiMap[d] || 0));
    cumFactor[d] = cum;
  }
  const ultimaData = datas[datas.length - 1];
  const fatorTotal = cumFactor[ultimaData];

  function fatorDesde(dataIso) {
    // último dado CDI com data <= dataIso (preserva fim de semana / feriado)
    let baseDate = null;
    for (const d of datas) {
      if (d <= dataIso) baseDate = d;
      else break;
    }
    if (!baseDate) return fatorTotal;     // anterior ao 1º dado disponível
    return fatorTotal / cumFactor[baseDate];
  }
  function fatorEntre(dataInicial, dataFinal) {
    let baseInit = null, baseFinal = null;
    for (const d of datas) {
      if (d <= dataInicial) baseInit = d;
      if (d <= dataFinal)   baseFinal = d;
      if (d > dataFinal) break;
    }
    if (!baseFinal) return 1;
    if (!baseInit)  return cumFactor[baseFinal];  // dataInicial anterior aos dados
    return cumFactor[baseFinal] / cumFactor[baseInit];
  }
  _cdiHelperCache = { dataMin, fatorDesde, fatorEntre, fatorTotal };
  return _cdiHelperCache;
}

// ─── RETORNO ACUMULADO TWR vs CDI ────────────────────────────────────────────

// Cache e in-flight por modo ("com" | "sem" reinvestimento de dividendos).
// "com" usa série ajustada (proventos reinvestidos implicitamente ao preço
// ex-div); "sem" usa série nominal + caixa de dividendos (alinha com tabela).
let _twrCache = {};
let _twrInflight = {};

async function computarTWR(modo = "com") {
  const key = JSON.stringify(transacoes);
  const cache = _twrCache[modo];
  if (cache && cache.key === key) return cache.value;
  const inflight = _twrInflight[modo];
  if (inflight && inflight.key === key) return inflight.promise;

  const promise = _computarTWRInterno(key, modo);
  _twrInflight[modo] = { key, promise };
  try { return await promise; }
  finally { if (_twrInflight[modo]?.key === key) delete _twrInflight[modo]; }
}

async function _computarTWRInterno(key, modo = "com") {
  if (!transacoes.length) {
    const empty = { labels: [], datasIso: [], retCarteira: [], retCDI: [], finalTWR: null, finalCDI: null, primeiroDia: null, patrimEod: [] };
    if (key === JSON.stringify(transacoes)) _twrCache[modo] = { key, value: empty };
    return empty;
  }

  const sortedTx = [...transacoes].sort((a, b) =>
    a.data === b.data ? 0 : (a.data < b.data ? -1 : 1)
  );
  const primeiroDia = sortedTx[0].data;
  const tickers = [...new Set(sortedTx.map(t => t.ticker))];

  const precos = {};   // tk → { adj: {...}, nominal: {...} }
  await Promise.all(tickers.map(async tk => {
    precos[tk] = await carregarHistoricoPreco(tk);
  }));

  const cdiHelper = await getCDIHelper();

  // No modo "sem", carrega proventos e indexa por data_com — entram no caixa
  // no dia da ex sem afetar o preço (que continua nominal).
  let divsPorData = {};
  if (modo === "sem") {
    const provs = await Promise.all(tickers.map(tk => carregarProventosTicker(tk)));
    tickers.forEach((tk, i) => {
      for (const pv of provs[i]) {
        if (!pv.data_com || !(pv.valor > 0)) continue;
        if (!divsPorData[pv.data_com]) divsPorData[pv.data_com] = [];
        divsPorData[pv.data_com].push({ ticker: tk, valor: pv.valor });
      }
    });
  }

  const txPorData = {};
  for (const t of sortedTx) {
    if (!txPorData[t.data]) txPorData[t.data] = [];
    txPorData[t.data].push(t);
  }

  const conjDatas = new Set();
  for (const tk of tickers) {
    for (const d of Object.keys(precos[tk]?.adj || {})) {
      if (d >= primeiroDia) conjDatas.add(d);
    }
  }
  for (const t of sortedTx) conjDatas.add(t.data);
  if (modo === "sem") {
    for (const d of Object.keys(divsPorData)) {
      if (d >= primeiroDia) conjDatas.add(d);
    }
  }
  const todasDatas = [...conjDatas].sort();
  if (!todasDatas.length) {
    const empty = { labels: [], datasIso: [], retCarteira: [], retCDI: [], patrimEod: [], finalTWR: null, finalCDI: null, primeiroDia };
    if (key === JSON.stringify(transacoes)) _twrCache[modo] = { key, value: empty };
    return empty;
  }

  // Estado comum aos dois modos. Ambos usam cota sintética (TWR-style) — isso
  // garante que aportes/saques NÃO causem quebras artificiais no retorno em
  // nenhum dos dois modos. A diferença entre "com" e "sem" é só a fonte do
  // patrimônio: "com" usa preço ajustado (dividendos embutidos como retorno
  // total); "sem" usa preço nominal + caixa de dividendos acumulado.
  const qtd = {};                    for (const tk of tickers) qtd[tk] = 0;
  const ultimoPrecoAdj  = {};        for (const tk of tickers) ultimoPrecoAdj[tk]  = 0;
  const ultimoPrecoNom  = {};        for (const tk of tickers) ultimoPrecoNom[tk]  = 0;
  let cotas = 0;
  // Memória do valor da cota antes de uma liquidação total — preserva o retorno
  // acumulado quando a carteira é zerada e depois reaberta (ex: vendeu tudo,
  // recomprou). Sem isso, o branch `cotas <= 0` reinicia o histórico.
  let valorCotaUltimo = 1;
  // Caixa de dividendos (modo "sem"): cresce no dia ex-data e fica até o fim.
  let caixa = 0;

  const labels = [];
  const retCarteira = [];
  const retCDI = [];
  const patrimEodArr = [];   // nominal, exposto pro gráfico de Valor de Mercado

  for (const d of todasDatas) {
    for (const tk of tickers) {
      const pa = precos[tk]?.adj?.[d];
      const pn = precos[tk]?.nominal?.[d];
      if (pa != null) ultimoPrecoAdj[tk] = pa;
      if (pn != null) ultimoPrecoNom[tk] = pn;
    }

    // Modo "sem": dividendos do dia entram no caixa. Usa qtdTickerNaData(tk, d)
    // (que inclui tx do dia ≤ d) — convenção alinhada com a tabela "Situação
    // atual" e demais cards/gráficos do sistema.
    if (modo === "sem" && divsPorData[d]) {
      for (const { ticker, valor } of divsPorData[d]) {
        const q = qtdTickerNaData(ticker, d);
        if (q > 0) caixa += q * valor;
      }
    }

    // Patrim PRE (antes das tx do dia): no modo "com" usa preço ajustado;
    // no modo "sem", preço nominal + caixa de dividendos. Define valorCotaPre
    // que neutraliza aportes (compras criam cotas, não geram retorno).
    let patrimPre = 0;
    if (modo === "sem") {
      for (const tk of tickers) patrimPre += (qtd[tk] || 0) * (ultimoPrecoNom[tk] || 0);
      patrimPre += caixa;
    } else {
      for (const tk of tickers) patrimPre += (qtd[tk] || 0) * (ultimoPrecoAdj[tk] || 0);
    }
    const valorCotaPre = cotas > 0 ? patrimPre / cotas : 1;

    if (txPorData[d]) {
      for (const t of txPorData[d]) {
        // `||` em vez de `??` porque ultimoPreco inicializa como 0 (não null);
        // sem isso, em data sem preço de mercado (feriado, fim de semana) o `??`
        // aceitaria o 0 e o fluxo da operação ficaria zerado.
        const precoAdj = precos[t.ticker]?.adj?.[d]     || ultimoPrecoAdj[t.ticker] || t.preco;
        const precoNom = precos[t.ticker]?.nominal?.[d] || ultimoPrecoNom[t.ticker] || t.preco;
        if (!ultimoPrecoAdj[t.ticker]) ultimoPrecoAdj[t.ticker] = precoAdj;
        if (!ultimoPrecoNom[t.ticker]) ultimoPrecoNom[t.ticker] = precoNom;
        const sinal = t.tipo === "compra" ? 1 : -1;

        // Preço de execução para o fluxo (criação/destruição de cotas):
        //  - "com": t.preco × (pAdj/pNom). O fator cobre proventos pagos APÓS
        //    a tx; recalcula sozinho a cada novo dividendo (pAdj cai retro).
        //  - "sem": t.preco direto (nominal). Dividendos entram via caixa.
        //  - t.preco inválido → cai no nominal do dia (fechamento).
        const precoUser = t.preco > 0 ? t.preco : precoNom;
        let precoExec;
        if (modo === "sem") {
          precoExec = precoUser;
        } else {
          const fatorAjuste = precoNom > 0 ? (precoAdj / precoNom) : 1;
          precoExec = precoUser * fatorAjuste;
        }
        const fluxo = sinal * t.qtd * precoExec;

        if (cotas <= 0) {
          // Carteira vazia: 1º investimento OU reabertura após liquidação.
          // Inicializa cotas a valorCotaUltimo (1 no início, ou o valor
          // preservado da liquidação anterior) pra preservar histórico.
          cotas = Math.abs(fluxo) / (valorCotaUltimo || 1);
        } else {
          cotas += fluxo / valorCotaPre;
        }
        qtd[t.ticker] = (qtd[t.ticker] || 0) + sinal * t.qtd;
      }
    }

    // Patrim ajustado (modo "com" alimenta o valor da cota)
    let patrimEodAdj = 0;
    for (const tk of tickers) patrimEodAdj += (qtd[tk] || 0) * (ultimoPrecoAdj[tk] || 0);

    // Patrim nominal (exposto pro gráfico de Valor de Mercado e DY mensal)
    let patrimEodNom = 0;
    for (const tk of tickers) patrimEodNom += (qtd[tk] || 0) * (ultimoPrecoNom[tk] || 0);

    // Patrim EOD usado pra valor da cota: depende do modo.
    const patrimEod = (modo === "sem") ? (patrimEodNom + caixa) : patrimEodAdj;
    const valorCotaEod = cotas > 0 ? patrimEod / cotas : valorCotaUltimo;
    if (cotas > 0) valorCotaUltimo = valorCotaEod;
    const retCart = valorCotaEod - 1;
    const retCdi  = cdiHelper ? (cdiHelper.fatorEntre(primeiroDia, d) - 1) : 0;

    const [, mes, dia] = d.split("-");
    labels.push(`${dia}/${mes}`);
    retCarteira.push(parseFloat((retCart * 100).toFixed(4)));
    retCDI.push(parseFloat((retCdi * 100).toFixed(4)));
    patrimEodArr.push(parseFloat(patrimEodNom.toFixed(2)));
  }

  const result = {
    labels, datasIso: todasDatas, retCarteira, retCDI, patrimEod: patrimEodArr, primeiroDia,
    finalTWR: retCarteira.length ? retCarteira.at(-1) / 100 : null,
    finalCDI: retCDI.length    ? retCDI.at(-1)    / 100 : null,
  };
  // Só escreve no cache se a key ainda corresponde às transações atuais —
  // evita que um cálculo em vôo escrito após uma alteração na carteira "ressuscite" dados antigos.
  if (key === JSON.stringify(transacoes)) {
    _twrCache[modo] = { key, value: result };
  }
  return result;
}

// Recorta a série TWR/CDI para uma janela temporal e reescala para que o
// retorno acumulado comece em 0% no início da janela.
function recortarTWRPorPeriodo(twr, periodo) {
  const { labels, datasIso, retCarteira, retCDI } = twr;
  if (!labels.length || periodo === "MAX") {
    return { labels, retCarteira, retCDI };
  }

  const meses = periodo === "1M" ? 1 : periodo === "3M" ? 3 : periodo === "6M" ? 6 : 12;

  // Alinha o início ao último dia útil do mês ANTERIOR aos N meses calendário
  // mais recentes — mesma definição da Tabela mensal (produto dos retornos
  // mensais). Sem isso, o filtro "1A" do gráfico mede 365 dias corridos a
  // partir da última data, enquanto a tabela mede 12 meses calendário; com
  // a última data caindo no meio do mês, as janelas divergem e o acumulado
  // do gráfico não bate com o acumulado da tabela.
  const lastIdxPorMes = {};
  datasIso.forEach((d, i) => { lastIdxPorMes[d.slice(0, 7)] = i; });
  const mesesOrd = Object.keys(lastIdxPorMes).sort();
  const idxMesInicial = Math.max(0, mesesOrd.length - meses);
  const startIdx = idxMesInicial > 0
    ? lastIdxPorMes[mesesOrd[idxMesInicial - 1]]
    : 0;

  // Reescala: novo_ret = ((1+ret_i) / (1+ret_start) - 1)
  const baseCart = 1 + (retCarteira[startIdx] || 0) / 100;
  const baseCDI  = 1 + (retCDI[startIdx]      || 0) / 100;
  const reescalar = (arr, base) =>
    arr.slice(startIdx).map(v => parseFloat((((1 + v / 100) / base - 1) * 100).toFixed(4)));

  return {
    labels:      labels.slice(startIdx),
    retCarteira: reescalar(retCarteira, baseCart),
    retCDI:      reescalar(retCDI, baseCDI)
  };
}

let _retornoCarteiraPeriodo = "MAX";
let _retornoCarteiraModo = "com";  // "com" | "sem" reinvestimento

function setModoRetorno(modo) {
  if (modo !== "com" && modo !== "sem") return;
  _retornoCarteiraModo = modo;
  document.querySelectorAll('.btn-toggle-modo[data-chart="retorno-carteira"]').forEach(b => {
    b.classList.toggle("ativo", b.dataset.modo === modo);
  });
  renderizarRetornoAcumuladoCarteira();
  renderizarTabelaMensalCarteira();
}

async function renderizarRetornoAcumuladoCarteira(periodo = _retornoCarteiraPeriodo) {
  _retornoCarteiraPeriodo = periodo;
  const ctx = document.getElementById("grafico-retorno-carteira")?.getContext("2d");
  if (!ctx) return;
  if (graficoRetornoCarteira) { graficoRetornoCarteira.destroy(); graficoRetornoCarteira = null; }

  const twr = await computarTWR(_retornoCarteiraModo);
  const { labels, retCarteira, retCDI } = recortarTWRPorPeriodo(twr, periodo);
  if (!labels.length) {
    const resumoEl = document.getElementById("retorno-carteira-resumo");
    if (resumoEl) resumoEl.style.display = "none";
    return;
  }

  const corCarteira    = retCarteira.at(-1) >= 0 ? "#00093C" : "#DC2626";
  const fillCarteira   = retCarteira.at(-1) >= 0 ? "rgba(0,9,60,0.10)" : "rgba(220,38,38,0.10)";

  graficoRetornoCarteira = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Carteira",
          data: retCarteira,
          borderColor: corCarteira,
          backgroundColor: fillCarteira,
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2
        },
        {
          label: "CDI",
          data: retCDI,
          borderColor: "#6B7280",
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
          display: true, position: "top",
          labels: { font: { size: 12 }, usePointStyle: true, pointStyleWidth: 10 }
        },
        datalabels: { display: false },
        tooltip: {
          callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { font: { size: 11 }, callback: v => v.toFixed(1) + "%" },
          grid: { color: "rgba(0,0,0,0.05)" }
        }
      }
    }
  });

  // Resumo no canto superior direito do gráfico
  const resumoEl = document.getElementById("retorno-carteira-resumo");
  const elCart   = document.getElementById("resumo-carteira");
  const elCDI    = document.getElementById("resumo-cdi");
  const elPct    = document.getElementById("resumo-pct-cdi");
  if (resumoEl && elCart && elCDI && elPct) {
    const finalCart = retCarteira.at(-1) ?? 0;          // já em %
    const finalCDI  = retCDI.at(-1)      ?? 0;
    const fmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    const cls = v => v > 0 ? "valor-positivo" : v < 0 ? "valor-negativo" : "";

    elCart.textContent = fmt(finalCart);
    elCart.className   = `grafico-resumo-valor ${cls(finalCart)}`;
    elCDI .textContent = fmt(finalCDI);
    elCDI .className   = `grafico-resumo-valor ${cls(finalCDI)}`;

    // % do CDI: mesma convenção da tabela "Situação atual" — retorno_carteira / retorno_cdi
    // (finalCDI já em %; piso conservador equivalente a 1e-4 % de retorno acumulado)
    if (finalCDI > 1e-4) {
      const pct = (finalCart / finalCDI) * 100;
      elPct.textContent = `${pct.toFixed(0)}%`;
      elPct.className   = "grafico-resumo-valor";
    } else {
      elPct.textContent = "—";
      elPct.className   = "grafico-resumo-valor";
    }
    resumoEl.style.display = "flex";
  }
}

function filtrarRetornoCarteira(periodo) {
  document.querySelectorAll('.btn-periodo[data-chart="retorno-carteira"]').forEach(b => {
    b.classList.toggle("ativo", b.dataset.periodo === periodo);
  });
  renderizarRetornoAcumuladoCarteira(periodo);
}

// Tabela mês a mês — Carteira vs CDI nos últimos 12 meses (linha por série)
async function renderizarTabelaMensalCarteira() {
  const tbody     = document.getElementById("tabela-mensal-tbody");
  const headerRow = document.getElementById("tabela-mensal-header");
  if (!tbody || !headerRow) return;

  // Segue o mesmo modo (com/sem reinvestimento) do gráfico de retorno —
  // sem isso, a tabela mostraria outra coisa que o gráfico logo acima.
  const { datasIso, retCarteira, retCDI } = await computarTWR(_retornoCarteiraModo);
  if (!datasIso || !datasIso.length) {
    headerRow.innerHTML = '<th></th>';
    tbody.innerHTML = '<tr><td class="sim-vazio-msg">Adicione operações para ver os retornos mensais.</td></tr>';
    return;
  }

  // Mapeia cada YYYY-MM para o índice do último ponto disponível dentro do mês
  const lastIdxPorMes = {};
  datasIso.forEach((d, i) => { lastIdxPorMes[d.slice(0, 7)] = i; });
  const mesesOrd = Object.keys(lastIdxPorMes).sort();
  const ultimos12 = mesesOrd.slice(-12);

  // Para o ponto base do 1º mês exibido, usa o último idx do mês anterior se houver;
  // senão (carteira começou dentro deste mês), o retorno do 1º mês é o acumulado desde o início.
  const idx0 = mesesOrd.indexOf(ultimos12[0]);
  let prevIdx = idx0 > 0 ? lastIdxPorMes[mesesOrd[idx0 - 1]] : -1;

  const retCart = [], retCdi = [];
  for (const ym of ultimos12) {
    const i = lastIdxPorMes[ym];
    if (prevIdx === -1) {
      retCart.push(retCarteira[i] || 0);
      retCdi.push(retCDI[i] || 0);
    } else {
      const baseC = 1 + (retCarteira[prevIdx] || 0) / 100;
      const baseD = 1 + (retCDI[prevIdx]      || 0) / 100;
      retCart.push(((1 + (retCarteira[i] || 0) / 100) / baseC - 1) * 100);
      retCdi.push (((1 + (retCDI[i]      || 0) / 100) / baseD - 1) * 100);
    }
    prevIdx = i;
  }

  const NOMES_MES = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const labels = ultimos12.map(ym => {
    const [y, m] = ym.split("-");
    return `${NOMES_MES[parseInt(m, 10) - 1]}/${y.slice(2)}`;
  });

  // Acumulado nos meses exibidos
  const cumCart = (retCart.reduce((a, r) => a * (1 + r / 100), 1) - 1) * 100;
  const cumCdi  = (retCdi .reduce((a, r) => a * (1 + r / 100), 1) - 1) * 100;

  const cls = v => v > 0 ? "valor-positivo" : v < 0 ? "valor-negativo" : "";
  const fmt = v => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

  headerRow.innerHTML =
    '<th></th>' +
    labels.map(l => `<th class="num">${l}</th>`).join("") +
    '<th class="num">Acumulado</th>';

  tbody.innerHTML = `
    <tr>
      <td class="ticker-cell">Carteira</td>
      ${retCart.map(v => `<td class="num ${cls(v)}">${fmt(v)}</td>`).join("")}
      <td class="num ${cls(cumCart)}">${fmt(cumCart)}</td>
    </tr>
    <tr>
      <td class="ticker-cell">CDI</td>
      ${retCdi.map(v => `<td class="num ${cls(v)}">${fmt(v)}</td>`).join("")}
      <td class="num ${cls(cumCdi)}">${fmt(cumCdi)}</td>
    </tr>
  `;
}

async function renderizarTabelaGeralAcomp() {
  const tbody = document.getElementById("res-tabela-geral-acomp-tbody");
  if (!tbody) return;

  const consolidado = consolidarPorTicker(transacoes);
  const tickersAtivos = Object.keys(consolidado).filter(tk => consolidado[tk].qtd_atual > 0);

  if (!tickersAtivos.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="sim-vazio-msg">Adicione operações para ver a situação da carteira.</td></tr>`;
    const tabela = document.getElementById("res-tabela-geral-acomp");
    const tfoot = tabela?.querySelector("tfoot");
    if (tfoot) tfoot.remove();
    return;
  }

  const cdiHelper = await getCDIHelper();

  const linhas = await Promise.all(tickersAtivos.map(async tk => {
    const c = consolidado[tk];
    const fii = carteira.find(f => f.ticker === tk) || todosFiis.find(d => d["Ticker"] === tk);
    const setor = fii?.setor || fii?.["Setor"] || "—";
    const custo = c.pm * c.qtd_atual;
    const precoAtual = getPrecoAtual(tk);
    const valor = precoAtual * c.qtd_atual;
    const ganho = valor - custo;

    let divs = 0;
    const proventos = await carregarProventosTicker(tk);
    for (const pv of proventos) {
      if (!pv.data_com) continue;
      const qtdNaData = qtdTickerNaData(tk, pv.data_com);
      if (qtdNaData > 0) divs += (pv.valor || 0) * qtdNaData;
    }
    const retorno = ganho + divs + c.ganho_realizado;
    const retornoPct = custo > 0 ? retorno / custo : 0;

    // CDI ponderado pelos custos das tranches: cada tranche aplica seu próprio
    // fator (acumulado desde a data da tranche) sobre seu custo individual.
    let cdiValor = 0, cdiCusto = 0;
    if (cdiHelper) {
      for (const tr of c.tranches) {
        const costTr = (tr.qtd_atual || 0) * (tr.preco || c.pm);
        if (costTr <= 0) continue;
        cdiValor += costTr * cdiHelper.fatorDesde(tr.data);
        cdiCusto += costTr;
      }
    }
    const retornoCDIPct = cdiCusto > 0 ? (cdiValor / cdiCusto - 1) : null;
    const pctDoCDI =
      retornoCDIPct != null && retornoCDIPct > 1e-6
        ? (retornoPct / retornoCDIPct) * 100
        : null;

    return { ticker: tk, setor, valor, ganho, divs, retorno, retornoPct,
             cdiValor, cdiCusto, pctDoCDI };
  }));

  const totalValor = linhas.reduce((s, l) => s + l.valor, 0);

  let totValor = 0, totGanho = 0, totDivs = 0, totRetorno = 0, totCusto = 0;
  for (const tk of tickersAtivos) {
    const c = consolidado[tk];
    totCusto += c.pm * c.qtd_atual;
  }

  const cls = v => v > 0 ? "valor-positivo" : v < 0 ? "valor-negativo" : "";
  // Tons de azul escuro para o % do CDI: ≥100% = navy sólido, 0–100% = navy claro, <0% = neutro
  const pctCDIClasse = pct =>
    pct == null ? "pct-cdi-neutro"
                : pct >= 100 ? "pct-cdi-acima"
                : pct >= 0   ? "pct-cdi-abaixo"
                             : "pct-cdi-neutro";
  let totCDIValor = 0, totCDICusto = 0;
  tbody.innerHTML = linhas.map(l => {
    totValor    += l.valor;
    totGanho    += l.ganho;
    totDivs     += l.divs;
    totRetorno  += l.retorno;
    totCDIValor += l.cdiValor || 0;
    totCDICusto += l.cdiCusto || 0;
    const peso = totalValor > 0 ? (100 * l.valor / totalValor) : 0;
    const pctCDIStr = l.pctDoCDI != null ? `${l.pctDoCDI.toFixed(0)}%` : "—";
    return `
      <tr>
        <td class="ticker-cell">${l.ticker}</td>
        <td><span class="setor-chip">${l.setor}</span></td>
        <td class="num peso-cell" style="--peso:${peso.toFixed(2)}%">${peso.toFixed(2)}%</td>
        <td class="num">${formatarBRL(l.valor)}</td>
        <td class="num ${cls(l.ganho)}">${formatarBRL(l.ganho)}</td>
        <td class="num">${formatarBRL(l.divs)}</td>
        <td class="num ${cls(l.retorno)}">${formatarBRL(l.retorno)}</td>
        <td class="num ${cls(l.retorno)}">${(l.retornoPct * 100).toFixed(2)}%</td>
        <td class="num"><span class="pct-cdi-badge ${pctCDIClasse(l.pctDoCDI)}">${pctCDIStr}</span></td>
      </tr>
    `;
  }).join("");

  // Linha de total
  const totRetPct = totCusto > 0 ? totRetorno / totCusto : 0;
  const totCDIPct = totCDICusto > 0 ? (totCDIValor / totCDICusto - 1) : null;
  const totPctDoCDI =
    totCDIPct != null && totCDIPct > 1e-6
      ? (totRetPct / totCDIPct) * 100
      : null;
  const totPctCDIStr = totPctDoCDI != null ? `${totPctDoCDI.toFixed(0)}%` : "—";

  // Ganho realizado de tickers totalmente vendidos (ficam de fora da tabela
  // por terem qtd_atual = 0, mas entram no Retorno Total dos cards do topo).
  // Mostra-se aqui pra evitar a divergência "soma das linhas ≠ Total geral".
  const tickersEncerrados = Object.keys(consolidado).filter(tk => consolidado[tk].qtd_atual === 0);
  const ganhoEncerradas = tickersEncerrados.reduce(
    (s, tk) => s + (consolidado[tk].ganho_realizado || 0), 0
  );
  // Dividendos de posições já encerradas (cotas que foram vendidas mas
  // receberam proventos enquanto fizeram parte da carteira)
  let divsEncerradas = 0;
  for (const tk of tickersEncerrados) {
    const proventos = await carregarProventosTicker(tk);
    for (const pv of proventos) {
      if (!pv.data_com) continue;
      const qtdNaData = qtdTickerNaData(tk, pv.data_com);
      if (qtdNaData > 0) divsEncerradas += (pv.valor || 0) * qtdNaData;
    }
  }
  const totalConsolidadoRetorno = totRetorno + ganhoEncerradas + divsEncerradas;
  const totalConsolidadoDivs    = totDivs + divsEncerradas;
  const temEncerradas = Math.abs(ganhoEncerradas) + Math.abs(divsEncerradas) > 0.005;

  const tabela = document.getElementById("res-tabela-geral-acomp");
  let tfoot = tabela.querySelector("tfoot");
  if (!tfoot) {
    tfoot = document.createElement("tfoot");
    tabela.appendChild(tfoot);
  }

  let tfootHTML = `
    <tr>
      <td colspan="2">Total (posições ativas)</td>
      <td class="num">100,00%</td>
      <td class="num">${formatarBRL(totValor)}</td>
      <td class="num ${cls(totGanho)}">${formatarBRL(totGanho)}</td>
      <td class="num">${formatarBRL(totDivs)}</td>
      <td class="num ${cls(totRetorno)}">${formatarBRL(totRetorno)}</td>
      <td class="num ${cls(totRetorno)}">${(totRetPct * 100).toFixed(2)}%</td>
      <td class="num"><span class="pct-cdi-badge ${pctCDIClasse(totPctDoCDI)}">${totPctCDIStr}</span></td>
    </tr>
  `;

  if (temEncerradas) {
    const ganhoEncTotal = ganhoEncerradas + divsEncerradas;
    tfootHTML += `
      <tr class="tfoot-encerradas">
        <td colspan="2">+ Posições encerradas</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num ${cls(ganhoEncerradas)}">${formatarBRL(ganhoEncerradas)}</td>
        <td class="num">${formatarBRL(divsEncerradas)}</td>
        <td class="num ${cls(ganhoEncTotal)}">${formatarBRL(ganhoEncTotal)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
      </tr>
      <tr class="tfoot-consolidado">
        <td colspan="2">Total geral</td>
        <td class="num">—</td>
        <td class="num">${formatarBRL(totValor)}</td>
        <td class="num ${cls(totGanho)}">${formatarBRL(totGanho)}</td>
        <td class="num">${formatarBRL(totalConsolidadoDivs)}</td>
        <td class="num ${cls(totalConsolidadoRetorno)}">${formatarBRL(totalConsolidadoRetorno)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
      </tr>
    `;
  }

  tfoot.innerHTML = tfootHTML;
}

// Sumariza vendas por ticker — cada item: { qtd_atual, qtd_vendida, custo_vendido,
//   valor_vendido, lucro_realizado }. PM acompanha o histórico de compras.
function calcularVendasPorTicker(txs) {
  const sorted = [...txs].sort((a, b) =>
    a.data === b.data ? 0 : (a.data < b.data ? -1 : 1)
  );
  const out = {};
  for (const t of sorted) {
    if (!out[t.ticker]) {
      out[t.ticker] = {
        pm: 0, qtd_atual: 0, qtd_vendida: 0,
        custo_vendido: 0, valor_vendido: 0, lucro_realizado: 0
      };
    }
    const pos = out[t.ticker];
    if (t.tipo === "compra") {
      const totalCusto = pos.pm * pos.qtd_atual + t.preco * t.qtd;
      pos.qtd_atual += t.qtd;
      pos.pm = pos.qtd_atual > 0 ? totalCusto / pos.qtd_atual : 0;
    } else {
      // Limita ao saldo existente — espelha consolidarPorTicker.
      const qtdEfetiva = Math.min(t.qtd, pos.qtd_atual);
      const custo = pos.pm * qtdEfetiva;
      const valor = t.preco * qtdEfetiva;
      pos.custo_vendido   += custo;
      pos.valor_vendido   += valor;
      pos.lucro_realizado += valor - custo;
      pos.qtd_atual = Math.max(0, pos.qtd_atual - t.qtd);
      pos.qtd_vendida += qtdEfetiva;
    }
  }
  return out;
}

async function renderizarTabelaVendasEncerradas() {
  const tbody = document.getElementById("tabela-vendas-acomp-tbody");
  if (!tbody) return;

  const vendas = calcularVendasPorTicker(transacoes);
  const tickersComVenda = Object.keys(vendas).filter(tk => vendas[tk].qtd_vendida > 0);

  const tabela = document.getElementById("tabela-vendas-acomp");

  if (!tickersComVenda.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="sim-vazio-msg">Nenhuma venda registrada ainda.</td></tr>`;
    const tfootExistente = tabela?.querySelector("tfoot");
    if (tfootExistente) tfootExistente.remove();
    return;
  }

  const linhas = tickersComVenda.map(tk => {
    const v = vendas[tk];
    const status = v.qtd_atual === 0 ? "Encerrada" : "Parcial";
    const retornoPct = v.custo_vendido > 0 ? v.lucro_realizado / v.custo_vendido : 0;
    return { ticker: tk, status, ...v, retornoPct };
  });

  // Encerradas primeiro (alfabéticas), depois parciais (alfabéticas)
  linhas.sort((a, b) => {
    if (a.status !== b.status) return a.status === "Encerrada" ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  const cls = v => v > 0 ? "valor-positivo" : v < 0 ? "valor-negativo" : "";

  let totCustoV = 0, totValorV = 0, totLucro = 0;
  tbody.innerHTML = linhas.map(l => {
    totCustoV += l.custo_vendido;
    totValorV += l.valor_vendido;
    totLucro  += l.lucro_realizado;
    const statusBadge = l.status === "Encerrada"
      ? '<span class="status-badge status-encerrada">Encerrada</span>'
      : '<span class="status-badge status-parcial">Parcial</span>';
    return `
      <tr>
        <td class="ticker-cell">${l.ticker}</td>
        <td>${statusBadge}</td>
        <td class="num">${formatarBRL(l.custo_vendido)}</td>
        <td class="num">${formatarBRL(l.valor_vendido)}</td>
        <td class="num ${cls(l.lucro_realizado)}">${formatarBRL(l.lucro_realizado)}</td>
        <td class="num ${cls(l.lucro_realizado)}">${(l.retornoPct * 100).toFixed(2)}%</td>
      </tr>
    `;
  }).join("");

  // Linha de total
  const totRetPct = totCustoV > 0 ? totLucro / totCustoV : 0;
  let tfoot = tabela.querySelector("tfoot");
  if (!tfoot) {
    tfoot = document.createElement("tfoot");
    tabela.appendChild(tfoot);
  }
  tfoot.innerHTML = `
    <tr>
      <td colspan="2">Total</td>
      <td class="num">${formatarBRL(totCustoV)}</td>
      <td class="num">${formatarBRL(totValorV)}</td>
      <td class="num ${cls(totLucro)}">${formatarBRL(totLucro)}</td>
      <td class="num ${cls(totLucro)}">${(totRetPct * 100).toFixed(2)}%</td>
    </tr>
  `;
}

function removerOperacao(idx) {
  if (idx < 0 || idx >= transacoes.length) return;
  if (!confirm("Remover esta operação?")) return;
  transacoes.splice(idx, 1);
  onTransacoesChange();
}

// ─── MODAL: NOVA OPERAÇÃO ────────────────────────────────────────────────────

let opSugestaoIdx = -1;
let opTickerEscolhido = null;

function abrirModalNovaOperacao() {
  const dlg = document.getElementById("modal-nova-operacao");
  if (!dlg) return;
  opTickerEscolhido = null;
  opSugestaoIdx = -1;
  document.getElementById("op-ticker").value = "";
  document.getElementById("op-qtd").value = "";
  document.getElementById("op-preco").value = "";
  document.getElementById("op-data").value = new Date().toISOString().slice(0, 10);
  document.querySelector('input[name="op-tipo"][value="compra"]').checked = true;
  document.getElementById("op-erro").style.display = "none";
  document.getElementById("op-sugestoes").style.display = "none";
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  setTimeout(() => document.getElementById("op-ticker").focus(), 50);
}

function fecharModalOperacao() {
  const dlg = document.getElementById("modal-nova-operacao");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function opFiltrarSugestoes() {
  const inp = document.getElementById("op-ticker");
  const box = document.getElementById("op-sugestoes");
  const q = inp.value.trim().toUpperCase();
  opSugestaoIdx = -1;
  opTickerEscolhido = null;
  if (!q) { box.style.display = "none"; return; }
  const resultados = todosFiis
    .filter(f => {
      const t = (f["Ticker"] || "").toUpperCase();
      const n = (f["Nome"]   || "").toUpperCase();
      return t.includes(q) || n.includes(q);
    })
    .slice(0, 8);
  if (!resultados.length) { box.style.display = "none"; return; }
  box.innerHTML = resultados.map((f, i) =>
    `<div class="sim-sugestao" data-idx="${i}" onmousedown="opSelecionarTicker('${f["Ticker"]}')">
      <span class="sim-sug-ticker">${f["Ticker"]}</span>
      <span class="sim-sug-nome">${f["Nome"] || ""}</span>
    </div>`
  ).join("");
  box._resultados = resultados;
  box.style.display = "block";
}

function opSelecionarTicker(ticker) {
  opTickerEscolhido = ticker;
  document.getElementById("op-ticker").value = ticker;
  document.getElementById("op-sugestoes").style.display = "none";
  document.getElementById("op-qtd").focus();
}

function opNavegarSugestoes(e) {
  const box = document.getElementById("op-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (e.key === "Enter" && items.length) {
    e.preventDefault();
    const r = box._resultados?.[opSugestaoIdx >= 0 ? opSugestaoIdx : 0];
    if (r) opSelecionarTicker(r["Ticker"]);
    return;
  }
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    opSugestaoIdx = Math.min(opSugestaoIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    opSugestaoIdx = Math.max(opSugestaoIdx - 1, 0);
  } else if (e.key === "Escape") {
    box.style.display = "none";
    return;
  }
  items.forEach((el, i) => el.classList.toggle("ativo", i === opSugestaoIdx));
}

async function submeterOperacao(e) {
  e.preventDefault();
  const erroEl = document.getElementById("op-erro");
  const showErr = msg => { erroEl.textContent = msg; erroEl.style.display = "block"; };

  const tickerRaw = (opTickerEscolhido || document.getElementById("op-ticker").value || "").toUpperCase().trim();
  const tipo  = document.querySelector('input[name="op-tipo"]:checked')?.value || "compra";
  const qtd   = parseInt(document.getElementById("op-qtd").value, 10);
  const preco = parseFloat(document.getElementById("op-preco").value);
  const data  = document.getElementById("op-data").value;

  if (!tickerRaw || !todosFiis.find(f => f["Ticker"] === tickerRaw)) {
    return showErr("Selecione um fundo válido da lista de sugestões.");
  }
  if (!Number.isFinite(qtd) || qtd <= 0) return showErr("Quantidade deve ser maior que zero.");
  if (!Number.isFinite(preco) || preco <= 0) return showErr("Preço deve ser maior que zero.");
  if (!data) return showErr("Selecione a data da operação.");
  const hoje = new Date().toISOString().slice(0, 10);
  if (data > hoje) return showErr("Data não pode ser futura.");

  // Valida que o fundo já existia na data informada (tem histórico de preço).
  const precos = await carregarHistoricoPreco(tickerRaw);
  const mapaNominal = precos.nominal || precos.adj || {};
  const datasDisponiveis = Object.keys(mapaNominal);
  if (!datasDisponiveis.length) {
    return showErr(`Sem dados de preço disponíveis para ${tickerRaw}.`);
  }
  const primeiraData = datasDisponiveis.reduce((min, d) => d < min ? d : min);
  if (data < primeiraData) {
    return showErr(`${tickerRaw} só tem dados a partir de ${formatarDataBR(primeiraData)}.`);
  }

  // Sanidade do preço informado: compara com a cotação histórica do dia (ou
  // do último pregão antes). Se diferir mais que 50%, pede confirmação.
  let precoMercado = mapaNominal[data];
  if (precoMercado == null) {
    // Fim de semana / feriado — pega o último pregão anterior à data
    const datasOrd = datasDisponiveis.filter(d => d <= data).sort();
    if (datasOrd.length) precoMercado = mapaNominal[datasOrd[datasOrd.length - 1]];
  }
  if (precoMercado != null && precoMercado > 0) {
    const desvio = Math.abs(preco - precoMercado) / precoMercado;
    if (desvio > 0.5) {
      const ok = confirm(
        `O preço informado (${formatarBRL(preco)}) está ${(desvio * 100).toFixed(0)}% ` +
        `distante da cotação histórica de ${tickerRaw} em ${formatarDataBR(data)} ` +
        `(${formatarBRL(precoMercado)}).\n\nQuer mesmo registrar essa operação?`
      );
      if (!ok) return;
    }
  }

  if (tipo === "venda") {
    // Valida considerando todas as transações ATÉ a data informada
    const ateData = transacoes.filter(t => t.data <= data);
    const consol = consolidarPorTicker(ateData);
    const qtdDisp = consol[tickerRaw]?.qtd_atual || 0;
    if (qtdDisp <= 0) return showErr(`Sem cotas de ${tickerRaw} na data ${formatarDataBR(data)}.`);
    if (qtd > qtdDisp + 1e-9) return showErr(`Só há ${Math.floor(qtdDisp)} cotas em ${formatarDataBR(data)}.`);
  }

  transacoes.push({ ticker: tickerRaw, tipo, qtd, preco, data });
  fecharModalOperacao();
  onTransacoesChange();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

async function init() {
  vazioEl      = document.getElementById("res-vazio");
  vazioAcompEl = document.getElementById("res-acomp-vazio");

  // Marca o modo no <main> para CSS
  const mainEl = document.querySelector("main");
  if (mainEl) mainEl.setAttribute("data-tipo", TIPO_CARTEIRA);

  // Carrega lista de FIIs + Infra + Agro para busca
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

  if (TIPO_CARTEIRA === "acompanhamento") {
    // Pré-carrega histórico dos tickers em transações para que getPrecoAtual
    // já tenha o cache pronto e use a mesma fonte do TWR. Sem isso, os
    // primeiros renders síncronos cairiam no fallback de todosFiis e poderiam
    // discordar do gráfico de Valor de Mercado.
    const tickersTx = [...new Set(transacoes.map(t => t.ticker))];
    await Promise.all(tickersTx.map(carregarHistoricoPreco));

    renderizarTabelaAcomp();
    atualizarCustoTotalAcomp();
    atualizarIndicadoresAcomp();
    renderizarPizzaAcomp();
    atualizarVisaoGeral();
    renderizarEvolucaoValor();
    renderizarDividendosPorMes();
    renderizarDYMensal();
    renderizarTabelaVendasEncerradas();
    renderizarTabelaGeralAcomp();
    renderizarRetornoAcumuladoCarteira();
    renderizarTabelaMensalCarteira();
  } else {
    // Preenche valor da carteira (só simulação)
    const inp = document.getElementById("res-valor-total");
    if (inp && valorTotal > 0) {
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

  // Snapshot inicial: botão "Salvar mudanças" só aparece a partir daqui
  _estadoInicialResultado = snapshotEstadoResultado();
  atualizarBtnSalvar();
}

init();
