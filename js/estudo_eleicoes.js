// Estudo Eleições — compara o retorno ajustado de uma lista curada de FIIs
// contra o índice do próprio setor desde o último fechamento antes do 1º turno,
// e cruza com o DY atual.
//
// Fonte: data/estudo_eleicoes.json (gerado por scripts/gerar_estudo_eleicoes.py).
// Tudo vem pré-calculado — a página só filtra, ordena e desenha. Os números
// saem da mesma metodologia dos agregados setoriais do site (índice ponderado
// por peso IFIX sobre retorno total; DY = provento mensal × 12 / preço).

// Mesma paleta da tela de volatilidade, pra um setor ter sempre a mesma cor
// em todas as telas internas.
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

let _doc = null;                       // JSON completo (sempre o fechamento)
let _setoresOcultos = new Set();       // setores desmarcados na legenda
let _ordem = { campo: "excesso", direcao: "desc" };
const _charts = {};                    // id do canvas -> instância Chart

// Modo "preço de agora": SÓ sob clique, nunca automático. O default é e
// continua sendo o fechamento anterior — _vivo = null significa fechamento.
const LS_TOKEN_BRAPI = "brapi_token";
const BRAPI_LOTE = 20;                 // tickers por chamada
// Mesmo feed que fii.js/agro.js/infra.js já consomem: yfinance -> prices.json,
// lido do raw (não do deploy), com os 175 tickers do universo.
const URL_PRICES = "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json";
let _vivo = null;                      // { quando, fonte, precos: {T: preço}, faltando: [] }

function cor(setor) { return PALETA_SETORES[setor] || COR_DEFAULT; }

async function carregar() {
  try {
    // Cache buster por minuto: o JSON é regerado no CI todo dia.
    const v = Math.floor(Date.now() / 60000);
    const r = await fetch("data/estudo_eleicoes.json?v=" + v);
    if (!r.ok) throw new Error("estudo_eleicoes.json não encontrado — rode scripts/gerar_estudo_eleicoes.py");
    _doc = await r.json();

    document.getElementById("ele-janela").innerHTML =
      `${formatarData(_doc.data_base)} → ${formatarData(_doc.data_fim)} · <b>${_doc.dias_uteis}</b> ${_doc.dias_uteis === 1 ? "pregão" : "pregões"}`;
    document.getElementById("ele-fonte").textContent =
      `Fonte: ${_doc.fonte}. Atualizado em ${_doc.atualizado_em}.`;

    const semDy = _doc.sem_dy || [];
    document.getElementById("ele-nota-dy").textContent = semDy.length
      ? `DY sem dado para: ${semDy.join(", ")} — provento do mês ainda não publicado. Excesso e retorno seguem válidos.`
      : "";

    renderEstadoPrecos();
    renderTabelaSetores();
    renderFiltroSetores();
    renderTabelaFundos();

    document.querySelectorAll("#tabela-fundos th[data-campo]").forEach(th => {
      th.addEventListener("click", () => ordenarPor(th.dataset.campo));
    });
    document.getElementById("ele-btn-agora")
      .addEventListener("click", ev => aplicarPrecosAgora(ev.currentTarget, "prices"));
    document.getElementById("ele-btn-brapi")
      .addEventListener("click", ev => aplicarPrecosAgora(ev.currentTarget, "brapi"));
    document.getElementById("ele-btn-fechamento")
      .addEventListener("click", voltarAoFechamento);

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";

    // Só depois de revelar o #conteudo: canvas dentro de container com
    // display:none mede 0x0 e o Chart.js desenha um gráfico vazio.
    desenharTodos();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = "Falha ao carregar: " + e.message;
  }
}

// ─── Preços de agora (sob demanda) ───────────────────────────────────────
//
// A cotação intradiária vem NOMINAL; a série do estudo é ajustada por
// provento. Comparar um com o outro erraria por todo dividendo pago desde a
// base, então o retorno ao vivo encadeia o retorno do dia em cima do retorno
// fechado:
//     retorno = (ajustado[fim]/ajustado[base]) × (preço_agora/nominal[fim]) − 1
// O índice setorial recebe o mesmo tratamento, ponderado por peso IFIX sobre
// TODOS os FIIs do setor — senão o fundo andaria intradiário contra um setor
// parado no fechamento.
//
// DY é inversamente proporcional ao preço (DY = provento×12/preço), então
// escala por nominal[fim]/preço_agora nos dois lados.

function tickersParaCotar() {
  const s = new Set((_doc.fundos || []).map(f => f.ticker));
  for (const membros of Object.values(_doc.universo_setorial || {})) {
    for (const m of membros) s.add(m.ticker);
  }
  return [...s];
}

function tokenBrapi() {
  let t = localStorage.getItem(LS_TOKEN_BRAPI);
  if (!t) {
    t = (prompt("Token da brapi.dev (guardado só neste navegador):") || "").trim();
    if (!t) return null;
    localStorage.setItem(LS_TOKEN_BRAPI, t);
  }
  return t;
}

// Fonte padrão: o prices.json que as outras telas já usam. Sem token, sem
// dependência nova. A atualidade é a do arquivo — por isso o aviso mostra o
// atualizado_em dele, e não a hora do clique: quem gera é o servidor local
// (thread de 5 em 5 min) ou o workflow atualizar_precos, que o GitHub
// estrangula. Se o arquivo estiver velho, o usuário vê na própria faixa.
async function buscarPrecosPricesJson() {
  const r = await fetch(URL_PRICES + "?t=" + Math.floor(Date.now() / 60000));
  if (!r.ok) throw new Error(`prices.json respondeu ${r.status}`);
  const doc = await r.json();
  const precos = {};
  for (const [t, p] of Object.entries(doc.precos || {})) {
    if (typeof p === "number" && p > 0) precos[t] = p;
  }
  if (!Object.keys(precos).length) throw new Error("prices.json sem preços");
  const tickers = tickersParaCotar();
  return {
    quando: doc.atualizado_em || "(sem carimbo de hora)",
    fonte: "Yahoo via prices.json",
    precos,
    faltando: tickers.filter(t => precos[t] == null),
  };
}

async function buscarPrecosBrapi() {
  const token = tokenBrapi();
  if (!token) throw new Error("sem token da brapi.dev");

  const tickers = tickersParaCotar();
  const precos = {};
  for (let i = 0; i < tickers.length; i += BRAPI_LOTE) {
    const lote = tickers.slice(i, i + BRAPI_LOTE);
    const url = `https://brapi.dev/api/quote/${lote.join(",")}?token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    if (r.status === 401 || r.status === 403) {
      localStorage.removeItem(LS_TOKEN_BRAPI);   // token ruim: pede de novo no próximo clique
      throw new Error("token da brapi.dev recusado — clique de novo para informar outro");
    }
    if (!r.ok) throw new Error(`brapi.dev respondeu ${r.status}`);
    const doc = await r.json();
    for (const q of (doc.results || [])) {
      const p = q.regularMarketPrice;
      if (q.symbol && typeof p === "number" && p > 0) precos[q.symbol] = p;
    }
  }

  if (Object.keys(precos).length === 0) throw new Error("nenhuma cotação retornada");
  return {
    quando: new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
    fonte: "brapi.dev (intradiário)",
    precos,
    faltando: tickers.filter(t => precos[t] == null),
  };
}

// Retorno ponderado do dia para um setor, a partir das cotações de agora.
// null se nenhum membro do setor tiver cotação.
function retornoDiaSetor(setor) {
  const membros = (_doc.universo_setorial || {})[setor] || [];
  let num = 0, den = 0;
  for (const m of membros) {
    const p = _vivo.precos[m.ticker];
    if (p == null || !m.nominal_fim) continue;
    num += m.peso * (p / m.nominal_fim - 1);
    den += m.peso;
  }
  return den > 0 ? num / den : null;
}

// Fundos com os números do modo atual. Sem _vivo devolve o fechamento intacto.
function fundosCalculados() {
  if (!_vivo) return _doc.fundos || [];

  const retDiaSetor = {};
  for (const s of Object.keys(_doc.universo_setorial || {})) retDiaSetor[s] = retornoDiaSetor(s);

  return (_doc.fundos || []).map(f => {
    const p = _vivo.precos[f.ticker];
    const rd = retDiaSetor[f.setor];

    // Setor: encadeia o dia em cima do índice fechado.
    const retSetor = (rd != null && f.retorno_setor != null)
      ? (1 + f.retorno_setor) * (1 + rd) - 1
      : f.retorno_setor;
    const dySetor = (rd != null && f.dy_setor != null)
      ? f.dy_setor / (1 + rd)
      : f.dy_setor;

    // Fundo: sem cotação, fica no fechamento (mas o setor já andou).
    if (p == null || !f.nominal_fim || f.preco_base == null || f.preco_fim == null) {
      return { ...f, retorno_setor: retSetor, dy_setor: dySetor,
               excesso: (f.retorno != null && retSetor != null) ? f.retorno - retSetor : null,
               spread_dy: (f.dy != null && dySetor != null) ? f.dy - dySetor : null,
               semCotacao: true };
    }

    const retorno = (f.preco_fim / f.preco_base) * (p / f.nominal_fim) - 1;
    const dy = f.dy != null ? f.dy * (f.nominal_fim / p) : null;
    return {
      ...f,
      retorno,
      retorno_setor: retSetor,
      excesso: retSetor != null ? retorno - retSetor : null,
      dy,
      dy_setor: dySetor,
      spread_dy: (dy != null && dySetor != null) ? dy - dySetor : null,
      preco_agora: p,
      semCotacao: false,
    };
  });
}

// Resumo setorial recalculado em cima de fundosCalculados().
function setoresCalculados() {
  if (!_vivo) return _doc.setores || [];
  const porSetor = {};
  for (const f of fundosCalculados()) (porSetor[f.setor] ||= []).push(f);

  return (_doc.setores || []).map(s => {
    const lista = (porSetor[s.setor] || []).filter(f => f.retorno != null);
    const rets = lista.map(f => f.retorno);
    const rd = retornoDiaSetor(s.setor);
    return {
      ...s,
      retorno_setor: (rd != null && s.retorno_setor != null)
        ? (1 + s.retorno_setor) * (1 + rd) - 1 : s.retorno_setor,
      retorno_medio_fundos: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
      dy_setor: (rd != null && s.dy_setor != null) ? s.dy_setor / (1 + rd) : s.dy_setor,
      acima_do_setor: lista.filter(f => (f.excesso ?? 0) > 0).length,
      n_fundos: lista.length,
    };
  });
}

// fonte: "prices" (padrão, Yahoo) ou "brapi" (intradiário com token).
// Só roda sob clique — não existe polling nesta tela.
async function aplicarPrecosAgora(btn, fonte) {
  const txt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Buscando...";
  try {
    _vivo = fonte === "brapi" ? await buscarPrecosBrapi() : await buscarPrecosPricesJson();
  } catch (e) {
    alert("Não foi possível buscar os preços: " + e.message);
    _vivo = null;
  } finally {
    btn.disabled = false;
    btn.textContent = txt;
    atualizarTudo();
  }
}

function voltarAoFechamento() {
  _vivo = null;
  atualizarTudo();
}

function renderEstadoPrecos() {
  const aviso = document.getElementById("ele-aviso-vivo");
  const btnVoltar = document.getElementById("ele-btn-fechamento");
  if (!aviso || !btnVoltar) return;

  btnVoltar.style.display = _vivo ? "" : "none";

  // O rótulo da janela tem que acompanhar o modo: deixar "→ 05/10" no ar
  // enquanto a tela mostra preço de hoje faz o leitor atribuir o movimento
  // ao período errado.
  const janela = document.getElementById("ele-janela");
  if (janela) {
    janela.innerHTML = _vivo
      ? `${formatarData(_doc.data_base)} → <b>agora</b> (fechamento até ${formatarData(_doc.data_fim)} + preço do dia)`
      : `${formatarData(_doc.data_base)} → ${formatarData(_doc.data_fim)} · <b>${_doc.dias_uteis}</b> ${_doc.dias_uteis === 1 ? "pregão" : "pregões"}`;
  }

  if (!_vivo) {
    aviso.style.display = "none";
    aviso.textContent = "";
    return;
  }
  const falt = _vivo.faltando.length
    ? ` · sem preço para ${_vivo.faltando.length} ticker(s): ${_vivo.faltando.slice(0, 6).join(", ")}${_vivo.faltando.length > 6 ? "…" : ""} (seguem no fechamento)`
    : "";
  aviso.style.display = "";
  aviso.innerHTML =
    `⚡ <b>Preços de ${_vivo.quando}</b> · fonte: ${_vivo.fonte} — retorno e DY recalculados ` +
    `sobre esse preço, inclusive o índice setorial. Não atualiza sozinho: clique de novo ` +
    `para rebuscar.${falt}`;
}

function atualizarTudo() {
  renderEstadoPrecos();
  renderTabelaSetores();
  renderTabelaFundos();
  desenharTodos();
}

// ─── Fundos visíveis (respeita o filtro da legenda) ──────────────────────

function fundosVisiveis() {
  return fundosCalculados().filter(f => !_setoresOcultos.has(f.setor));
}

// ─── Tabelas ─────────────────────────────────────────────────────────────

function renderTabelaSetores() {
  document.getElementById("tabela-setores-body").innerHTML =
    setoresCalculados().map(s => `
      <tr>
        <td><span class="ele-setor-tag" style="background:${cor(s.setor)}">${s.setor}</span></td>
        <td class="num">${s.n_fundos}</td>
        <td class="num">${fmtRet(s.retorno_setor)}</td>
        <td class="num">${fmtRet(s.retorno_medio_fundos)}</td>
        <td class="num">${s.acima_do_setor}/${s.n_fundos}</td>
        <td class="num">${fmtPct(s.dy_setor)}</td>
      </tr>
    `).join("");
}

function renderFiltroSetores() {
  const cont = document.getElementById("ele-filtro-setores");
  cont.innerHTML = "";
  for (const s of (_doc.setores || [])) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = _setoresOcultos.has(s.setor) ? "apagada" : "";
    b.innerHTML = `<span class="ele-dot" style="background:${cor(s.setor)}"></span>${s.setor}`;
    b.title = "Clique para mostrar/ocultar este setor";
    b.addEventListener("click", () => {
      if (_setoresOcultos.has(s.setor)) _setoresOcultos.delete(s.setor);
      else _setoresOcultos.add(s.setor);
      renderFiltroSetores();
      renderTabelaFundos();
      desenharTodos();
    });
    cont.appendChild(b);
  }
}

function ordenarPor(campo) {
  if (_ordem.campo === campo) {
    _ordem.direcao = _ordem.direcao === "asc" ? "desc" : "asc";
  } else {
    // Texto começa A→Z; número começa do maior.
    _ordem = { campo, direcao: (campo === "ticker" || campo === "setor") ? "asc" : "desc" };
  }
  renderTabelaFundos();
}

function renderTabelaFundos() {
  const lista = fundosVisiveis().slice();
  const { campo, direcao } = _ordem;
  const sinal = direcao === "asc" ? 1 : -1;

  lista.sort((a, b) => {
    const va = a[campo], vb = b[campo];
    // Nulos sempre no fim, independente da direção.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") return sinal * va.localeCompare(vb, "pt-BR");
    return sinal * (va - vb);
  });

  document.getElementById("tabela-fundos-body").innerHTML = lista.map(f => `
    <tr>
      <td><b>${f.ticker}</b></td>
      <td><span class="ele-setor-tag" style="background:${cor(f.setor)}">${f.setor}</span></td>
      <td class="num">${fmtRet(f.retorno)}</td>
      <td class="num">${fmtRet(f.retorno_setor)}</td>
      <td class="num">${fmtRet(f.excesso)}</td>
      <td class="num">${fmtPct(f.dy)}</td>
      <td class="num">${fmtPct(f.dy_setor)}</td>
      <td class="num">${fmtPp(f.spread_dy)}</td>
    </tr>
  `).join("");

  document.querySelectorAll("#tabela-fundos th[data-campo]").forEach(th => {
    th.classList.remove("ord-asc", "ord-desc");
    if (th.dataset.campo === campo) th.classList.add("ord-" + direcao);
  });

  const acima = lista.filter(f => f.excesso != null && f.excesso > 0).length;
  document.getElementById("ele-resumo-fundos").innerHTML =
    `<b>${acima}</b> de <b>${lista.length}</b> acima do próprio setor`;
}

// ─── Gráficos ────────────────────────────────────────────────────────────

// Escreve o ticker ao lado de cada ponto. Sem isso o scatter com ~39 pontos
// coloridos por setor não diz qual fundo é qual.
const rotulosPlugin = {
  id: "rotulos",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillStyle = "#1c2b3a";
    ctx.textBaseline = "middle";
    // somente != null -> rotula só esses tickers. Usado no gráfico fundo ×
    // setor, onde o eixo Y assume apenas 5 valores (um por setor) e os 39
    // rótulos viram um borrão em cima das faixas.
    const somente = chart.options.plugins?.rotulos?.somente || null;
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      (meta.data || []).forEach((pt, i) => {
        const raw = ds.data[i];
        if (!raw || !raw.ticker) return;
        if (somente && !somente.has(raw.ticker)) return;
        ctx.fillText(raw.ticker, pt.x + 8, pt.y);
      });
    });
    ctx.restore();
  },
};

// Linha tracejada na média de cada eixo (quadrantes).
const mediasPlugin = {
  id: "medias",
  beforeDatasetsDraw(chart) {
    if (chart.options.plugins?.medias?.ativo === false) return;
    const { ctx, chartArea, scales: { x, y } } = chart;
    if (!chartArea) return;
    const pts = chart.data.datasets.flatMap(ds => ds.data || []);
    const xs = pts.map(p => p.x).filter(Number.isFinite);
    const ys = pts.map(p => p.y).filter(Number.isFinite);
    if (xs.length < 2 || ys.length < 2) return;
    const media = a => a.reduce((s, v) => s + v, 0) / a.length;
    const xPx = x.getPixelForValue(media(xs));
    const yPx = y.getPixelForValue(media(ys));

    ctx.save();
    ctx.strokeStyle = "rgba(0, 9, 60, 0.25)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (xPx >= chartArea.left && xPx <= chartArea.right) {
      ctx.moveTo(xPx, chartArea.top); ctx.lineTo(xPx, chartArea.bottom);
    }
    if (yPx >= chartArea.top && yPx <= chartArea.bottom) {
      ctx.moveTo(chartArea.left, yPx); ctx.lineTo(chartArea.right, yPx);
    }
    ctx.stroke();
    ctx.restore();
  },
};

// Diagonal y = x: no gráfico fundo × setor é a linha do "empatou com o setor".
const diagonalPlugin = {
  id: "diagonal",
  beforeDatasetsDraw(chart) {
    if (!chart.options.plugins?.diagonal?.ativo) return;
    const { ctx, chartArea, scales: { x, y } } = chart;
    if (!chartArea) return;
    const lo = Math.max(x.min, y.min);
    const hi = Math.min(x.max, y.max);
    if (!(hi > lo)) return;
    ctx.save();
    ctx.strokeStyle = "rgba(239, 99, 0, 0.55)";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x.getPixelForValue(lo), y.getPixelForValue(lo));
    ctx.lineTo(x.getPixelForValue(hi), y.getPixelForValue(hi));
    ctx.stroke();
    ctx.restore();
  },
};

function desenharTodos() {
  const fundos = fundosVisiveis();

  // Fundo × setor: o eixo Y só tem um valor por setor, então os pontos caem em
  // faixas horizontais. Eixos com a MESMA escala deixam a diagonal a 45° e a
  // distância até ela vira a leitura do excesso. Rotula só os 8 extremos.
  const comSetor = fundos.filter(f => f.retorno != null && f.retorno_setor != null);
  const extremos = new Set(
    comSetor.slice()
      .sort((a, b) => Math.abs(b.excesso ?? 0) - Math.abs(a.excesso ?? 0))
      .slice(0, 8)
      .map(f => f.ticker));

  desenharScatter({
    canvasId: "scatter-fundo-setor",
    pontos: comSetor.map(f => ({ x: f.retorno * 100, y: f.retorno_setor * 100, ticker: f.ticker, setor: f.setor })),
    tituloX: "Retorno do fundo (%)",
    tituloY: "Retorno do setor (%)",
    diagonal: true,
    medias: false,
    eixosIguais: true,
    rotularSomente: extremos,
    rotuloTooltip: p => `${p.ticker}: fundo ${fmtNum(p.x)}%, setor ${fmtNum(p.y)}%`,
  });

  desenharScatter({
    canvasId: "scatter-dy-retorno",
    pontos: fundos.filter(f => f.dy != null && f.retorno != null)
      .map(f => ({ x: f.dy * 100, y: f.retorno * 100, ticker: f.ticker, setor: f.setor })),
    tituloX: "DY atual (% a.a.)",
    tituloY: "Retorno do período (%)",
    rotuloTooltip: p => `${p.ticker}: DY ${fmtNum(p.x)}%, retorno ${fmtNum(p.y)}%`,
  });

  desenharScatter({
    canvasId: "scatter-spread-excesso",
    pontos: fundos.filter(f => f.spread_dy != null && f.excesso != null)
      .map(f => ({ x: f.spread_dy * 100, y: f.excesso * 100, ticker: f.ticker, setor: f.setor })),
    tituloX: "DY do fundo − DY do setor (pp)",
    tituloY: "Retorno do fundo − retorno do setor (pp)",
    rotuloTooltip: p => `${p.ticker}: spread ${fmtNum(p.x)} pp, excesso ${fmtNum(p.y)} pp`,
  });
}

function desenharScatter({ canvasId, pontos, tituloX, tituloY, rotuloTooltip,
                           diagonal = false, medias = true, eixosIguais = false,
                           rotularSomente = null }) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (_charts[canvasId]) _charts[canvasId].destroy();

  const cores = pontos.map(p => cor(p.setor));

  // Mesma escala nos dois eixos: sem isso a diagonal y=x sai quase vertical
  // quando o espalhamento dos fundos é muito maior que o dos setores.
  let limites = {};
  if (eixosIguais && pontos.length) {
    const vals = pontos.flatMap(p => [p.x, p.y]).filter(Number.isFinite);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const folga = (hi - lo || 1) * 0.08;
    limites = { min: lo - folga, max: hi + folga };
  }

  _charts[canvasId] = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [{
        data: pontos,
        backgroundColor: cores,
        borderColor: cores,
        pointRadius: 7,
        pointHoverRadius: 11,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // devicePixelRatio fixo em 2 garante canvas em alta resolução mesmo em
      // telas low-DPI — o PNG copiado fica nítido no PowerPoint.
      devicePixelRatio: 2,
      layout: { padding: { right: 56, top: 8 } },
      plugins: {
        legend: { display: false },     // a legenda de setores é o filtro em HTML
        diagonal: { ativo: diagonal },
        medias: { ativo: medias },
        rotulos: { somente: rotularSomente },
        tooltip: {
          titleFont: { size: 13, weight: "600" },
          bodyFont: { size: 13 },
          padding: 10,
          callbacks: { label: c => rotuloTooltip(c.raw) },
        },
      },
      scales: {
        x: {
          title: { display: true, text: tituloX, font: { size: 14, weight: "700" },
                   color: "#1c2b3a", padding: { top: 8 } },
          ticks: { font: { size: 12 }, color: "#1c2b3a" },
          grid: { color: "rgba(0,0,0,0.05)" },
          ...limites,
        },
        y: {
          title: { display: true, text: tituloY, font: { size: 14, weight: "700" },
                   color: "#1c2b3a", padding: { bottom: 8 } },
          ticks: { font: { size: 12 }, color: "#1c2b3a" },
          grid: { color: "rgba(0,0,0,0.05)" },
          ...limites,
        },
      },
    },
    plugins: [diagonalPlugin, mediasPlugin, rotulosPlugin],
  });
}

// ─── Copiar gráfico / Excel ──────────────────────────────────────────────

async function copiarGrafico(canvasId, btn) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const textoOriginal = btn ? btn.textContent : "";
  const restaurar = msg => {
    if (!btn) return;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = textoOriginal; btn.disabled = false; }, 1800);
  };
  try {
    if (btn) btn.disabled = true;
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error("Este navegador não permite copiar imagem para a área de transferência.");
    }
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("falha ao gerar PNG")), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    restaurar("✓ Copiado!");
  } catch (e) {
    console.error("copiarGrafico:", e);
    restaurar("✕ Falhou");
  }
}

// SheetJS lazy-loaded só na 1a chamada (mesmo padrão do relatorio_mensal).
let _sheetJsCarregando = null;
async function _carregarSheetJs() {
  if (window.XLSX) return;
  if (_sheetJsCarregando) return _sheetJsCarregando;
  _sheetJsCarregando = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Falha ao carregar SheetJS"));
    document.head.appendChild(s);
  });
  return _sheetJsCarregando;
}

async function baixarEstudoExcel(btn) {
  if (!_doc) { alert("Os dados ainda não carregaram."); return; }
  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Preparando..."; }
  try {
    await _carregarSheetJs();
    const r4 = v => (v == null ? null : Math.round(v * 1000000) / 10000);  // decimal -> % com 4 casas

    const aoa = [
      ["Estudo Eleições — fundo × setor"],
      [_vivo
        ? `Janela: ${formatarData(_doc.data_base)} ate o PRECO DE ${_vivo.quando} (fechamento ate ${formatarData(_doc.data_fim)} + preco do dia, fonte ${_vivo.fonte})`
        : `Janela: ${formatarData(_doc.data_base)} a ${formatarData(_doc.data_fim)} (${_doc.dias_uteis} pregões)`],
      [`Exportado em: ${new Date().toLocaleString("pt-BR")}`],
      [_doc.fonte],
      [],
      ["Ticker", "Setor", "Retorno (%)", "Retorno setor (%)", "Excesso (pp)",
       "DY atual (%)", "DY setor (%)", "Spread DY (pp)",
       "Preço base", "Preço fim", "Data do DY"],
      ...fundosVisiveis().map(f => [
        f.ticker, f.setor,
        r4(f.retorno), r4(f.retorno_setor), r4(f.excesso),
        r4(f.dy), r4(f.dy_setor), r4(f.spread_dy),
        f.preco_base == null ? null : Math.round(f.preco_base * 1000000) / 1000000,
        f.preco_fim == null ? null : Math.round(f.preco_fim * 1000000) / 1000000,
        f.dy_data ? formatarData(f.dy_data) : null,
      ]),
      [],
      ["Resumo por setor"],
      ["Setor", "Fundos", "Índice do setor (%)", "Média dos fundos (%)",
       "Acima do setor", "DY do setor (%)"],
      ...(_doc.setores || []).map(s => [
        s.setor, s.n_fundos, r4(s.retorno_setor), r4(s.retorno_medio_fundos),
        `${s.acima_do_setor}/${s.n_fundos}`, r4(s.dy_setor),
      ]),
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 10 }, { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 13 },
                   { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Estudo Eleições");
    XLSX.writeFile(wb, `estudo_eleicoes_${_doc.data_fim}.xlsx`);
  } catch (e) {
    alert("Erro ao gerar Excel: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

// ─── Formatação ──────────────────────────────────────────────────────────

function fmtNum(v) { return (v >= 0 ? "+" : "") + v.toFixed(2); }

function fmtRet(v) {
  if (v == null) return "—";
  const pct = v * 100;
  return `<span class="${pct >= 0 ? "var-pos" : "var-neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
}

function fmtPct(v) {
  if (v == null) return "—";
  return (v * 100).toFixed(2) + "%";
}

function fmtPp(v) {
  if (v == null) return "—";
  const pp = v * 100;
  return `<span class="${pp >= 0 ? "var-pos" : "var-neg"}">${pp >= 0 ? "+" : ""}${pp.toFixed(2)} pp</span>`;
}

function formatarData(iso) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

carregar();
