// Tela de Ofertas Públicas. Le data/ofertas_publicas.json (CVM Dados Abertos
// filtrado pelos nossos 178 fundos) e renderiza tabela ordenavel + filtros.
// Cada linha tem botão de expandir que mostra a quebra de subscritores.

let _todasOfertas = [];
// Ordem independente por tabela
const _ordemPorTab = {
  bookbuilding: { campo: "data_protocolo", direcao: "desc" },
  ativas:       { campo: "data_registro",  direcao: "desc" },
  resto:        { campo: "data_registro",  direcao: "desc" },
};
const _expandidas = new Set();
const STATUS_ATIVO        = "Em distribuição";  // oferta liberada e captando do publico
// "Em preparacao" = qualquer oferta protocolada que ainda nao iniciou distribuicao
const STATUS_PREPARACAO   = new Set(["Em bookbuilding", "Em análise", "Registrada"]);

const STATUS_CLASSE = {
  "Em distribuição":  "of-status-aberta",
  "Em bookbuilding":  "of-status-bookbuilding",
  "Em análise":       "of-status-analise",
  "Registrada":       "of-status-registrada",
  "Encerrada":        "of-status-encerrada",
  "Cancelada":        "of-status-cancelada",
  "Suspensa":         "of-status-suspensa",
};

async function carregarOfertas() {
  try {
    const v = Math.floor(Date.now() / 60000);
    const r = await fetch(`data/ofertas_publicas.json?v=${v}`);
    if (!r.ok) throw new Error("ofertas_publicas.json não encontrado. Rode scripts/coletar_ofertas_cvm.py.");
    const d = await r.json();
    _todasOfertas = d.ofertas || [];
    // Pré-calcula pct_pf (volume PF / volume captado) pra ordenação.
    // Regra: se a oferta tem subscritores publicados (qualquer categoria com valor),
    // PF ausente = 0% (oferta restrita a institucionais). Sem subscritores = null (lacuna).
    for (const o of _todasOfertas) {
      const subscObj = o.subscritores || {};
      const subPf = subscObj["Pessoa Física / Natural"] || subscObj["Pessoa Física"] || {};
      const valPf = subPf.valor_r;
      const temSubsComValor = Object.values(subscObj).some(v => (v.valor_r || 0) > 0);
      if (o.valor_captado && o.valor_captado > 0) {
        o.pct_pf = (valPf || 0) / o.valor_captado;
      } else if (temSubsComValor) {
        o.pct_pf = 0;
      } else {
        o.pct_pf = null;
      }
    }
    document.getElementById("atualizado-em").textContent = d.atualizado_em || "—";
    document.getElementById("janela-meses").textContent = d.janela_meses ?? "—";

    // Popula filtro de setor
    const setores = [...new Set(_todasOfertas.map(o => o.setor).filter(Boolean))].sort();
    const sel = document.getElementById("filtro-setor");
    sel.innerHTML = '<option value="">Todos os setores</option>' +
      setores.map(s => `<option value="${s}">${s}</option>`).join("");

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
    aplicarFiltrosOfertas();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function aplicarFiltrosOfertas() {
  const setor   = document.getElementById("filtro-setor")?.value || "";
  const ticker  = (document.getElementById("filtro-ticker")?.value || "").toUpperCase().trim();

  const filtroComum = o => {
    if (setor && o.setor !== setor) return false;
    if (ticker && !(o.ticker || "").includes(ticker)) return false;
    return true;
  };

  const bookb  = _todasOfertas.filter(o => STATUS_PREPARACAO.has(o.status) && filtroComum(o));
  const ativas = _todasOfertas.filter(o => o.status === STATUS_ATIVO && filtroComum(o));
  const resto  = _todasOfertas.filter(o => o.status !== STATUS_ATIVO && !STATUS_PREPARACAO.has(o.status) && filtroComum(o));

  const totalBookb  = _todasOfertas.filter(o => STATUS_PREPARACAO.has(o.status)).length;
  const totalAtivas = _todasOfertas.filter(o => o.status === STATUS_ATIVO).length;
  const totalResto  = _todasOfertas.filter(o => o.status !== STATUS_ATIVO && !STATUS_PREPARACAO.has(o.status)).length;
  // Guard: cada pagina hospeda so um subset das tabelas. Atualiza counts e renderiza
  // apenas os blocos que existem no DOM da pagina atual.
  const elCBookb  = document.getElementById("ofertas-count-bookbuilding");
  const elCAtivas = document.getElementById("ofertas-count-ativas");
  const elCResto  = document.getElementById("ofertas-count-resto");
  if (elCBookb)  elCBookb.textContent  = `${bookb.length} de ${totalBookb} oferta${totalBookb !== 1 ? "s" : ""}`;
  if (elCAtivas) elCAtivas.textContent = `${ativas.length} de ${totalAtivas} oferta${totalAtivas !== 1 ? "s" : ""} ativa${totalAtivas !== 1 ? "s" : ""}`;
  if (elCResto)  elCResto.textContent  = `${resto.length} de ${totalResto}`;

  if (document.getElementById("tabela-ofertas-body-bookbuilding")) _renderTabBookbuilding(bookb);
  if (document.getElementById("tabela-ofertas-body-ativas"))       _renderTabOfertas("ativas", ativas, /*comEnceCol*/false);
  if (document.getElementById("tabela-ofertas-body-resto"))        _renderTabOfertas("resto",  resto,  /*comEnceCol*/true);
  if (document.getElementById("grafico-vol-ofertas"))              _renderGraficoVolMensal(resto);
  atualizarIconesOf();
}

let _graficoVol = null;
let _granularidadeGraf = "mensal";  // "mensal" | "trimestral" | "semestral" | "anual"

function trocarGranularidade(gr) {
  if (gr === _granularidadeGraf) return;
  _granularidadeGraf = gr;
  document.querySelectorAll(".grafico-vol-gr-btn").forEach(b => {
    b.classList.toggle("ativo", b.dataset.gr === gr);
  });
  aplicarFiltrosOfertas();
}

// Converte data ISO YYYY-MM-DD pra chave do bucket temporal e label legivel
function _bucketDe(dataIso) {
  if (!dataIso) return { key: "", label: "" };
  const [yStr, mStr] = dataIso.split("-");
  const y = +yStr, m = +mStr;
  switch (_granularidadeGraf) {
    case "mensal": {
      const meses = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
      return { key: `${y}-${String(m).padStart(2,"0")}`, label: `${meses[m-1]}/${String(y).slice(2)}` };
    }
    case "trimestral": {
      const t = Math.ceil(m / 3);
      return { key: `${y}-T${t}`, label: `${t}T${String(y).slice(2)}` };
    }
    case "semestral": {
      const s = m <= 6 ? 1 : 2;
      return { key: `${y}-S${s}`, label: `${s}S${String(y).slice(2)}` };
    }
    case "anual":
      return { key: `${y}`, label: `${y}` };
  }
}

// Gera intervalo de chaves do bucket entre 1a e ultima data, preenchendo gaps
function _bucketsDoIntervalo(chavesOrdenadas) {
  if (!chavesOrdenadas.length) return [];
  const ini = chavesOrdenadas[0];
  const fim = chavesOrdenadas[chavesOrdenadas.length - 1];
  const out = [];
  switch (_granularidadeGraf) {
    case "mensal": {
      let [y, m] = ini.split("-").map(Number);
      const [yF, mF] = fim.split("-").map(Number);
      while (y < yF || (y === yF && m <= mF)) {
        out.push(`${y}-${String(m).padStart(2,"0")}`);
        m++; if (m > 12) { m = 1; y++; }
      }
      return out;
    }
    case "trimestral": {
      let [yS, tS] = ini.split("-T"); let y = +yS, t = +tS;
      const [yFS, tFS] = fim.split("-T"); const yF = +yFS, tF = +tFS;
      while (y < yF || (y === yF && t <= tF)) {
        out.push(`${y}-T${t}`);
        t++; if (t > 4) { t = 1; y++; }
      }
      return out;
    }
    case "semestral": {
      let [yS, sS] = ini.split("-S"); let y = +yS, s = +sS;
      const [yFS, sFS] = fim.split("-S"); const yF = +yFS, sF = +sFS;
      while (y < yF || (y === yF && s <= sF)) {
        out.push(`${y}-S${s}`);
        s++; if (s > 2) { s = 1; y++; }
      }
      return out;
    }
    case "anual": {
      const yI = +ini, yF = +fim;
      for (let y = yI; y <= yF; y++) out.push(`${y}`);
      return out;
    }
  }
  return [];
}

function _bucketLabel(key) {
  // Mantido pra compat — usa _bucketDe pra extrair label
  switch (_granularidadeGraf) {
    case "mensal": {
      const meses = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
      const [y, m] = key.split("-").map(Number);
      return `${meses[m-1]}/${String(y).slice(2)}`;
    }
    case "trimestral": {
      const [y, t] = key.split("-T");
      return `${t}T${y.slice(2)}`;
    }
    case "semestral": {
      const [y, s] = key.split("-S");
      return `${s}S${y.slice(2)}`;
    }
    case "anual":
      return key;
  }
  return key;
}

const COR_PF     = "#EF6300";
const COR_OUTROS = "rgba(0,9,60,0.55)";

function _pfDoOferta(o) {
  const subPf = (o.subscritores || {})["Pessoa Física / Natural"]
             || (o.subscritores || {})["Pessoa Física"]
             || {};
  return subPf.valor_r || 0;
}

function _renderGraficoVolMensal(ofertasFiltradas) {
  // Filtra ofertas com data_encerramento e valor_captado
  const ofs = ofertasFiltradas.filter(o => o.data_encerramento && o.valor_captado);
  if (!ofs.length) {
    document.getElementById("grafico-vol-meta").textContent = "Sem ofertas no filtro atual";
    if (_graficoVol) { _graficoVol.destroy(); _graficoVol = null; }
    document.getElementById("grafico-vol-tabela-anual").innerHTML =
      `<tr><td colspan="4" class="sim-vazio-msg">—</td></tr>`;
    document.getElementById("grafico-vol-legenda").innerHTML = "";
    return;
  }
  // Sumario geral (independente de modo)
  const totalGeral = ofs.reduce((s, o) => s + (o.valor_captado || 0), 0);
  const pfGeral    = ofs.reduce((s, o) => s + _pfDoOferta(o), 0);
  const pctPf = totalGeral > 0 ? (pfGeral / totalGeral * 100) : 0;
  document.getElementById("grafico-vol-meta").textContent =
    `${ofs.length} ofertas · ${fmtR(totalGeral)} captado · ${pctPf.toFixed(1)}% PF`;

  _renderModoPf(ofs, totalGeral, pfGeral);
}

function _renderModoPf(ofs, totalGeral, pfGeral) {
  // Agrega por bucket (granularidade do grafico) -> {total, pf}
  const por_bucket = new Map();
  for (const o of ofs) {
    const { key } = _bucketDe(o.data_encerramento);
    const ag = por_bucket.get(key) || { total: 0, pf: 0 };
    ag.total += o.valor_captado;
    ag.pf    += _pfDoOferta(o);
    por_bucket.set(key, ag);
  }
  const chaves = [...por_bucket.keys()].sort();
  const labels = _bucketsDoIntervalo(chaves);
  const dadosPF     = labels.map(k => (por_bucket.get(k) || {pf:0}).pf);
  const dadosOutros = labels.map(k => {
    const ag = por_bucket.get(k) || { total: 0, pf: 0 };
    return Math.max(0, ag.total - ag.pf);
  });
  _desenhaGrafico(labels, [
    { label: "Pessoas Físicas",                       data: dadosPF,     color: COR_PF },
    { label: "Outros (PJ, fundos, estrangeiros)",     data: dadosOutros, color: COR_OUTROS },
  ]);

  // Tabela anual continua sempre por ano (independente da granularidade do grafico)
  _setTabelaHead(["Ano", "Total", "PFs", "% PF"], "Histórico anual");
  const por_ano = new Map();
  for (const o of ofs) {
    const ano = o.data_encerramento.slice(0, 4);
    const acc = por_ano.get(ano) || { total: 0, pf: 0 };
    acc.total += o.valor_captado;
    acc.pf    += _pfDoOferta(o);
    por_ano.set(ano, acc);
  }
  const anos = [...por_ano.keys()].sort().reverse();
  const linhas = anos.map(ano => {
    const v = por_ano.get(ano);
    const pct = v.total > 0 ? (v.pf / v.total * 100) : 0;
    return [ano, fmtR(v.total), fmtR(v.pf), `${pct.toFixed(1)}%`];
  });
  const pctTotal = totalGeral > 0 ? (pfGeral / totalGeral * 100) : 0;
  _setTabelaBody(linhas, ["Total", fmtR(totalGeral), fmtR(pfGeral), `${pctTotal.toFixed(1)}%`]);
}

function _desenhaGrafico(bucketKeys, datasets) {
  const ctx = document.getElementById("grafico-vol-ofertas").getContext("2d");
  if (_graficoVol) _graficoVol.destroy();
  _graficoVol = new Chart(ctx, {
    type: "bar",
    data: {
      labels: bucketKeys.map(_bucketLabel),
      datasets: datasets.map(d => ({
        label: d.label,
        data: d.data.map(v => +(v / 1e6).toFixed(2)),
        backgroundColor: d.color,
        stack: "total",
        borderWidth: 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label: (ctx) => `${ctx.dataset.label}: R$ ${ctx.parsed.y.toLocaleString("pt-BR", {minimumFractionDigits:1, maximumFractionDigits:1})} mi`,
            footer: (items) => {
              const tot = items.reduce((s, it) => s + it.parsed.y, 0);
              return `Total: R$ ${tot.toLocaleString("pt-BR", {minimumFractionDigits:1, maximumFractionDigits:1})} mi`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
        y: { stacked: true, beginAtZero: true,
             title: { display: true, text: "R$ milhões" },
             grid: { color: "rgba(0,0,0,0.05)" } },
      },
    },
  });
  // Legenda customizada
  const legenda = document.getElementById("grafico-vol-legenda");
  legenda.innerHTML = datasets.map(d => `
    <span class="grafico-vol-legenda-item">
      <span class="grafico-vol-legenda-cor" style="background:${d.color}"></span> ${d.label}
    </span>`).join("");
}

function _setTabelaHead(cols, titulo) {
  const tt = document.getElementById("grafico-vol-tabela-titulo");
  if (tt) tt.textContent = titulo;
  const thead = document.getElementById("grafico-vol-tabela-thead");
  if (!thead) return;
  thead.innerHTML = `<tr>
    <th>${cols[0]}</th>
    <th class="num">${cols[1]}</th>
    <th class="num">${cols[2]}</th>
    <th class="num">${cols[3]}</th>
  </tr>`;
}

function _setTabelaBody(linhas, totalRow) {
  const tbody = document.getElementById("grafico-vol-tabela-anual");
  if (!tbody) return;
  if (!linhas.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="sim-vazio-msg">—</td></tr>`;
    return;
  }
  let html = linhas.map(l => `<tr>
    <td>${l[0]}</td>
    <td class="num">${l[1]}</td>
    <td class="num">${l[2]}</td>
    <td class="num">${l[3]}</td>
  </tr>`).join("");
  if (totalRow) {
    html += `<tr class="grafico-vol-tabela-total">
      <td>${totalRow[0]}</td>
      <td class="num">${totalRow[1]}</td>
      <td class="num">${totalRow[2]}</td>
      <td class="num">${totalRow[3]}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}


function _renderTabBookbuilding(lista) {
  const ord = _ordemPorTab.bookbuilding;
  const dir = ord.direcao === "asc" ? 1 : -1;
  lista = [...lista].sort((a, b) => {
    const va = a[ord.campo], vb = b[ord.campo];
    if (va == null || va === "") return 1;
    if (vb == null || vb === "") return -1;
    if (typeof va === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true }) * dir;
  });
  const tbody = document.getElementById("tabela-ofertas-body-bookbuilding");
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="sim-vazio-msg">Nenhuma oferta em preparação no momento.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map((o, i) => {
    const idLinha = `of-bb-${o.ticker}-${o.numero_processo || o.numero_registro || i}`.replace(/[^\w-]/g, "_");
    const expand = _expandidas.has(idLinha);
    const subs = Object.keys(o.subscritores || {});
    const podeExpandir = subs.length > 0;
    return `
      <tr class="of-row${expand ? " of-row-aberta" : ""}">
        <td>
          ${podeExpandir
            ? `<button class="of-toggle" onclick="toggleOferta('${idLinha}')" title="Ver quebra dos subscritores">${expand ? "▼" : "▶"}</button>`
            : ""}
        </td>
        <td><a href="fii.html?ticker=${o.ticker}" class="ticker-link" title="${o.nome_fundo || ""}">${o.ticker}</a></td>
        <td><span class="of-status ${STATUS_CLASSE[o.status] || ""}">${o.status}</span></td>
        <td class="num">${o.emissao ?? "—"}${o.serie ? ` <small>(${o.serie})</small>` : ""}</td>
        <td>${o.rito || "—"}</td>
        <td class="of-lider" title="${o.lider || ""}">${truncar(o.lider || "—", 30)}</td>
        <td class="num">${fmtData(o.data_protocolo)}</td>
        <td class="num">${fmtData(o.data_registro)}</td>
        <td>${o.ultimo_comunicado ? `<span class="of-bb-comunicado">${o.ultimo_comunicado}</span>` : "—"}${o.data_comunicado ? ` <small>(${fmtData(o.data_comunicado)})</small>` : ""}</td>
        <td class="num">${fmtConfirmFnet(o)}</td>
      </tr>
      ${expand && podeExpandir ? renderSubscritores(o, 10) : ""}
    `;
  }).join("");
}

function _renderTabOfertas(qual, lista, comEnceCol) {
  const ord = _ordemPorTab[qual];
  const dir = ord.direcao === "asc" ? 1 : -1;
  lista = [...lista].sort((a, b) => {
    const va = a[ord.campo], vb = b[ord.campo];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "pt-BR", { numeric: true }) * dir;
  });

  const tbody = document.getElementById(`tabela-ofertas-body-${qual}`);
  const colspan = comEnceCol ? 11 : 10;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="sim-vazio-msg">Nenhuma oferta ${qual === "ativas" ? "ativa no momento" : "no histórico"}.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((o, i) => {
    const idLinha = `of-${qual}-${o.ticker}-${o.numero_processo || o.numero_registro || i}`.replace(/[^\w-]/g, "_");
    const expand = _expandidas.has(idLinha);
    const subs = Object.keys(o.subscritores || {});
    const podeExpandir = subs.length > 0;
    const colEnce = comEnceCol
      ? `<td class="num">${fmtData(o.data_encerramento)}</td>`
      : "";
    // Volume: ativas mostram registrado; histórico mostra captado (com tooltip
    // do registrado + % captacao se ambos existirem).
    let colVolume;
    if (qual === "ativas") {
      colVolume = `<td class="num">${fmtR(o.valor_total)}</td>`;
    } else {
      colVolume = `<td class="num">${fmtVolumeHist(o)}</td>`;
    }
    const colPctPf = qual === "resto" ? `<td class="num">${fmtPctPf(o)}</td>` : "";
    return `
      <tr class="of-row${expand ? " of-row-aberta" : ""}">
        <td>
          ${podeExpandir
            ? `<button class="of-toggle" onclick="toggleOferta('${idLinha}')" title="Ver quebra dos subscritores">${expand ? "▼" : "▶"}</button>`
            : ""}
        </td>
        <td><a href="fii.html?ticker=${o.ticker}" class="ticker-link" title="${o.nome_fundo || ""}">${o.ticker}</a></td>
        <td class="num">${o.emissao ?? "—"}${o.serie ? ` <small>(${o.serie})</small>` : ""}</td>
        <td>${o.rito || "—"}</td>
        <td class="of-lider" title="${o.lider || ""}">${truncar(o.lider || "—", 30)}</td>
        ${colVolume}
        ${colPctPf}
        <td class="num">${fmtPreco(o.preco_unitario)}</td>
        <td class="num">${fmtData(o.data_inicio)}</td>
        ${colEnce}
        <td class="num">${fmtConfirmFnet(o)}</td>
      </tr>
      ${expand && podeExpandir ? renderSubscritores(o, colspan) : ""}
    `;
  }).join("");
}

function fmtConfirmFnet(o) {
  const fi = o.fnet_inicio, fe = o.fnet_encerramento;
  const ehAtiva  = ["Em distribuição","Registrada","Em análise"].includes(o.status);
  const ehFinal  = ["Encerrada"].includes(o.status);
  // Decide quais checks importam pra esse status
  const checkInicio = !!fi;
  const checkEnce   = !!fe;
  let icone = "—";
  let titulo = "Sem anúncio fnet correspondente.";
  let classe = "of-fnet-na";
  if (ehAtiva && checkInicio) {
    icone = "✓"; titulo = `Confirmado na fnet em ${fi.data}`; classe = "of-fnet-ok";
  } else if (ehFinal && checkInicio && checkEnce) {
    icone = "✓✓"; titulo = `Início ${fi.data}, Encerramento ${fe.data} confirmados na fnet`; classe = "of-fnet-ok";
  } else if (ehFinal && (checkInicio || checkEnce)) {
    icone = "½"; titulo = `Parcial: ${checkInicio ? "Início "+fi.data : ""}${checkInicio && checkEnce ? " | " : ""}${checkEnce ? "Encerramento "+fe.data : ""}`; classe = "of-fnet-parcial";
  } else if (ehAtiva && !checkInicio) {
    icone = "—"; titulo = "Oferta ativa — anúncio Início ainda não publicado na fnet (ou fora da janela coletada).";
    classe = "of-fnet-pendente";
  }
  // Link pro PDF do início se houver
  const links = [];
  if (fi) links.push(`<a href="${fi.url_fnet}" target="_blank" rel="noopener" class="of-fnet-link" title="Anúncio de Início">I↗</a>`);
  if (fe) links.push(`<a href="${fe.url_fnet}" target="_blank" rel="noopener" class="of-fnet-link" title="Anúncio de Encerramento">E↗</a>`);
  return `<span class="${classe}" title="${titulo}">${icone}</span> ${links.join(" ")}`;
}

function renderSubscritores(o, colspanTotal) {
  // colspanTotal = nº total de colunas da tabela hospedeira (10 ativas, 11 resto).
  // O sub-painel usa: 1 (toggle) + 2 (cat) + 3 (números) + restante (barra de %).
  const colspanBarra = Math.max(1, colspanTotal - 6);
  const subs = o.subscritores || {};
  const totalCotas = Object.values(subs).reduce((s, v) => s + (v.qtd_cotas || 0), 0);
  const totalInv   = Object.values(subs).reduce((s, v) => s + (v.n_investidores || 0), 0);
  const linhas = Object.entries(subs)
    .filter(([, v]) => (v.qtd_cotas || 0) > 0 || (v.n_investidores || 0) > 0)
    .sort((a, b) => (b[1].valor_r || 0) - (a[1].valor_r || 0))
    .map(([cat, v]) => {
      const pctVal = totalCotas > 0 ? (v.qtd_cotas || 0) / totalCotas : 0;
      const barW = (pctVal * 100).toFixed(1);
      return `
        <tr class="of-sub-linha">
          <td></td>
          <td colspan="2" class="of-sub-cat">${cat}</td>
          <td class="num">${(v.n_investidores || 0).toLocaleString("pt-BR")}</td>
          <td class="num">${(v.qtd_cotas || 0).toLocaleString("pt-BR", {maximumFractionDigits:0})}</td>
          <td class="num"><strong>${fmtR(v.valor_r)}</strong></td>
          <td colspan="${colspanBarra}" class="of-sub-bar-wrap">
            <div class="of-sub-bar"><div class="of-sub-bar-fill" style="width:${barW}%"></div></div>
            <span class="of-sub-pct">${barW}%</span>
          </td>
        </tr>`;
    }).join("");
  return `
    <tr class="of-sub-cabec">
      <td></td>
      <td colspan="2"><strong>Quebra dos Subscritores</strong> <small>(${totalInv.toLocaleString("pt-BR")} investidores, ${totalCotas.toLocaleString("pt-BR", {maximumFractionDigits:0})} cotas)</small></td>
      <td class="num"><strong>Investidores</strong></td>
      <td class="num"><strong>Cotas</strong></td>
      <td class="num"><strong>Valor R$</strong></td>
      <td colspan="${colspanBarra}" class="num"><strong>% das cotas</strong></td>
    </tr>
    ${linhas}
  `;
}

function toggleOferta(id) {
  if (_expandidas.has(id)) _expandidas.delete(id);
  else _expandidas.add(id);
  aplicarFiltrosOfertas();
}

function ordenarOfertas(campo, qual) {
  const ord = _ordemPorTab[qual];
  if (ord.campo === campo) {
    ord.direcao = ord.direcao === "asc" ? "desc" : "asc";
  } else {
    ord.campo = campo;
    ord.direcao = (typeof _todasOfertas[0]?.[campo] === "number") ? "desc" : "asc";
  }
  aplicarFiltrosOfertas();
}

function atualizarIconesOf() {
  // Cada tabela tem suas proprias setas, marcadas pelo handler onclick que
  // referencia 'ativas' ou 'resto'. Itera pelas duas <tbody> hospedeiras.
  for (const qual of ["bookbuilding", "ativas", "resto"]) {
    const ord = _ordemPorTab[qual];
    const tbody = document.getElementById(`tabela-ofertas-body-${qual}`);
    const tabela = tbody?.closest("table");
    if (!tabela) continue;
    tabela.querySelectorAll("th[data-sort]").forEach(th => {
      const ic = th.querySelector(".sort-ic");
      if (!ic) return;
      if (th.dataset.sort === ord.campo) ic.textContent = ord.direcao === "asc" ? "↑" : "↓";
      else ic.textContent = "↕";
    });
  }
}

function limparFiltrosOfertas() {
  ["filtro-setor","filtro-ticker"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  aplicarFiltrosOfertas();
}

// Formato de volume na tabela Histórico: mostra captado em destaque + barra
// horizontal com % do registrado (cor por threshold).
function fmtVolumeHist(o) {
  const reg = o.valor_total;
  const cap = o.valor_captado;
  if (cap == null && reg == null) return "—";
  if (cap == null) return `<span title="Valor registrado (sem captação preenchida)">${fmtR(reg)}</span>`;
  if (reg == null || reg <= 0) return `<strong>${fmtR(cap)}</strong>`;
  const pctNum = cap / reg * 100;
  const pct = pctNum.toFixed(0);
  // mesma paleta verde/amarelo/vermelho usada antes
  const classe = pctNum >= 95 ? "of-cap-cheia"
                : pctNum >= 50 ? "of-cap-media"
                : "of-cap-baixa";
  // largura da barra capada em 100% pra evitar overflow se captado>registrado (raro)
  const barW = Math.min(100, Math.max(0, pctNum)).toFixed(1);
  return `<strong>${fmtR(cap)}</strong>` +
    `<div class="of-cap-bar-wrap" title="Registrado: ${fmtR(reg)} | Captado: ${pct}%">
       <div class="of-cap-bar"><div class="of-cap-bar-fill ${classe}" style="width:${barW}%"></div></div>
       <span class="of-cap-bar-pct ${classe}">${pct}%</span>
     </div>`;
}

// % PF (Pessoa Física) na tabela Histórico — barra horizontal navy + valor R$ acima
function fmtPctPf(o) {
  if (o.pct_pf == null) return '<span class="dash-na">—</span>';
  const subPf = (o.subscritores || {})["Pessoa Física / Natural"]
             || (o.subscritores || {})["Pessoa Física"]
             || {};
  const valPf = subPf.valor_r || 0;
  const nPf   = subPf.n_investidores || 0;
  const pctNum = o.pct_pf * 100;
  const barW = Math.min(100, Math.max(0, pctNum)).toFixed(1);
  // Caso 0% (oferta restrita a institucionais): renderiza barra vazia + label explicativo
  if (pctNum === 0) {
    return `<span class="of-pf-zero-label" title="Oferta restrita — sem participação de Pessoas Físicas">Restrita</span>` +
      `<div class="of-cap-bar-wrap" title="Oferta restrita a institucionais (0% PF)">
         <div class="of-cap-bar"><div class="of-pf-bar-fill" style="width:0%"></div></div>
         <span class="of-pf-bar-pct">0%</span>
       </div>`;
  }
  return `<strong>${fmtR(valPf)}</strong>` +
    `<div class="of-cap-bar-wrap" title="Subscrito por PFs: ${fmtR(valPf)} (${pctNum.toFixed(1)}% do captado) — ${nPf.toLocaleString("pt-BR")} PFs">
       <div class="of-cap-bar"><div class="of-pf-bar-fill" style="width:${barW}%"></div></div>
       <span class="of-pf-bar-pct">${pctNum.toFixed(0)}%</span>
     </div>`;
}

function fmtR(v) {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e9) return "R$ " + (v / 1e9).toFixed(2) + " bi";
  if (Math.abs(v) >= 1e6) return "R$ " + (v / 1e6).toFixed(1) + " mi";
  if (Math.abs(v) >= 1e3) return "R$ " + (v / 1e3).toFixed(0) + " mil";
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPreco(v) {
  if (v == null) return "—";
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtData(s) {
  if (!s) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
}
function truncar(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function atualizarOfertas(btn) {
  const status = document.getElementById("atualizar-ofertas-status");
  if (btn) { btn.disabled = true; btn.textContent = "Coletando..."; }
  if (status) { status.textContent = "Pode levar 3-5 min (varre fnet inteira)…"; status.className = "atualizar-status atualizar-status-rodando"; }
  try {
    const r = await fetch("/atualizar-ofertas", { method: "POST" });
    const d = await r.json();
    if (!d.ok) throw new Error(d.erro || "falhou");
    if (status) {
      const c = d.contagem || {};
      status.textContent = `OK em ${d.duracao_s}s — ${c.total || 0} ofertas, ${c.fnet_sem_match || 0} sem match fnet`;
      status.className = "atualizar-status atualizar-status-ok";
    }
    // Recarrega o JSON na tela sem precisar refresh do browser
    await carregarOfertas();
  } catch (e) {
    if (status) {
      status.textContent = "Erro: " + e.message;
      status.className = "atualizar-status atualizar-status-erro";
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Atualizar agora"; }
  }
}

carregarOfertas();
