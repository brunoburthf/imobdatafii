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
const STATUS_BOOKBUILDING = "Em bookbuilding";  // protocolada, coletando ordens, sem preco/qtd ainda

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

  const bookb  = _todasOfertas.filter(o => o.status === STATUS_BOOKBUILDING && filtroComum(o));
  const ativas = _todasOfertas.filter(o => o.status === STATUS_ATIVO && filtroComum(o));
  const resto  = _todasOfertas.filter(o => o.status !== STATUS_ATIVO && o.status !== STATUS_BOOKBUILDING && filtroComum(o));

  const totalBookb  = _todasOfertas.filter(o => o.status === STATUS_BOOKBUILDING).length;
  const totalAtivas = _todasOfertas.filter(o => o.status === STATUS_ATIVO).length;
  const totalResto  = _todasOfertas.filter(o => o.status !== STATUS_ATIVO && o.status !== STATUS_BOOKBUILDING).length;
  document.getElementById("ofertas-count-bookbuilding").textContent =
    `${bookb.length} de ${totalBookb} oferta${totalBookb !== 1 ? "s" : ""}`;
  document.getElementById("ofertas-count-ativas").textContent =
    `${ativas.length} de ${totalAtivas} oferta${totalAtivas !== 1 ? "s" : ""} ativa${totalAtivas !== 1 ? "s" : ""}`;
  document.getElementById("ofertas-count-resto").textContent =
    `${resto.length} de ${totalResto}`;

  _renderTabBookbuilding(bookb);
  _renderTabOfertas("ativas", ativas, /*comStatusCol*/false);
  _renderTabOfertas("resto",  resto,  /*comStatusCol*/true);
  atualizarIconesOf();
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
    tbody.innerHTML = `<tr><td colspan="8" class="sim-vazio-msg">Nenhuma oferta em bookbuilding no momento.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map((o, i) => {
    const idLinha = `of-bb-${o.ticker}-${o.numero_processo || o.numero_registro || i}`.replace(/[^\w-]/g, "_");
    const expand = _expandidas.has(idLinha);
    const subs = Object.keys(o.subscritores || {});
    const podeExpandir = subs.length > 0;  // raro nessa fase mas mantem consistencia
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
        <td class="num">${fmtData(o.data_protocolo)}</td>
        <td><span class="of-bb-comunicado">${o.ultimo_comunicado || "—"}</span>${o.data_comunicado ? ` <small>(${fmtData(o.data_comunicado)})</small>` : ""}</td>
        <td class="num">${fmtConfirmFnet(o)}</td>
      </tr>
      ${expand && podeExpandir ? renderSubscritores(o, 8) : ""}
    `;
  }).join("");
}

function _renderTabOfertas(qual, lista, comStatusCol) {
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
  const colspan = comStatusCol ? 13 : 11;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="sim-vazio-msg">Nenhuma oferta ${qual === "ativas" ? "ativa no momento" : "no histórico"}.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map((o, i) => {
    const idLinha = `of-${qual}-${o.ticker}-${o.numero_processo || o.numero_registro || i}`.replace(/[^\w-]/g, "_");
    const expand = _expandidas.has(idLinha);
    const subs = Object.keys(o.subscritores || {});
    const podeExpandir = subs.length > 0;
    const colStatus = comStatusCol
      ? `<td><span class="of-status ${STATUS_CLASSE[o.status] || ""}">${o.status}</span></td>`
      : "";
    const colEnce = comStatusCol
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
        ${colStatus}
        <td class="num">${o.emissao ?? "—"}${o.serie ? ` <small>(${o.serie})</small>` : ""}</td>
        <td>${o.rito || "—"}</td>
        <td class="of-lider" title="${o.lider || ""}">${truncar(o.lider || "—", 30)}</td>
        ${colVolume}
        ${colPctPf}
        <td class="num">${fmtPreco(o.preco_unitario)}</td>
        <td class="num">${fmtData(o.data_registro)}</td>
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
  // colspanTotal = nº total de colunas da tabela hospedeira (11 ativas, 13 resto).
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
