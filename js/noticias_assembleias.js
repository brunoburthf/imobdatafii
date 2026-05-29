// Tela de Assembleias Extraordinarias (AGE). Le data/assembleias_fnet.json,
// filtra so fundos curados (ticker mapeado), agrupa por (ticker, data_assembleia)
// e separa em 2 tabelas: futuras (assembleia > hoje) e passadas (<= hoje).
//
// Cada AGE pode ter varios docs na fnet (convocacao + edital + ata + alteracao).
// O coletor marca cada doc como classificacao='convocacao' ou 'ata' baseado em
// quando foi publicado em relacao a data_assembleia. Aqui a gente agrupa todos
// e linka:
//   - "Convocação": doc convocacao mais recente (maior data_publicacao)
//   - "Ata":        doc ata mais recente (so pra passadas)
// "Aprovação" fica como "Pendente análise" — parsing do PDF de ata sera Fase 2.

let _todasAGE = [];           // todos os docs (achatado)
let _gruposAGE = [];          // { ticker, nome_fundo, setor, data_assembleia, docs:[], convocacao:doc|null, ata:doc|null, ata_resumo:obj|null }
let _atasResumos = {};        // fnet_id -> resumo parseado (Fase 2)
let _ordemPorTab = {
  futuras:  { campo: "data_assembleia", direcao: "asc"  }, // proxima primeiro
  passadas: { campo: "data_assembleia", direcao: "desc" }, // recente primeiro
};

async function carregarAssembleias() {
  try {
    const v = Math.floor(Date.now() / 60000);
    // Em paralelo: AGEs (obrigatorio) + resumos das atas (opcional, gerados
    // por gerar_resumos_atas.py que pode nao ter rodado ainda).
    const [r, rResumos] = await Promise.all([
      fetch(`data/assembleias_fnet.json?v=${v}`),
      fetch(`data/atas_resumos.json?v=${v}`).catch(() => null),
    ]);
    if (!r.ok) throw new Error("assembleias_fnet.json não encontrado. Rode scripts/coletar_assembleias_fnet.py.");
    const d = await r.json();
    _atasResumos = (rResumos && rResumos.ok) ? await rResumos.json() : {};
    // Filtra so curados (ticker resolvido)
    _todasAGE = (d.assembleias || []).filter(a => !!a.ticker);

    document.getElementById("atualizado-em").textContent = d.atualizado_em || "—";
    document.getElementById("janela-dias").textContent   = d.janela_dias ?? 90;

    _gruposAGE = _agruparPorAssembleia(_todasAGE);

    // Popula filtro de setor (a partir dos grupos)
    const setores = [...new Set(_gruposAGE.map(g => g.setor).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    const sel = document.getElementById("filtro-setor");
    sel.innerHTML = '<option value="">Todos os setores</option>' +
      setores.map(s => `<option value="${s}">${s}</option>`).join("");

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
    aplicarFiltrosAssembleias();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function _agruparPorAssembleia(docs) {
  const mapa = new Map();
  for (const d of docs) {
    const chave = `${d.ticker}__${d.data_assembleia || ""}`;
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        ticker:          d.ticker,
        nome_fundo:      d.nome_fundo,
        setor:           d.setor,
        data_assembleia: d.data_assembleia,
        docs:            [],
      });
    }
    mapa.get(chave).docs.push(d);
  }
  // Pra cada grupo, pega o melhor doc de convocacao e o melhor de ata
  // (criterio: data_publicacao mais alta).
  const grupos = [];
  for (const g of mapa.values()) {
    const convs = g.docs.filter(x => x.classificacao === "convocacao");
    const atas  = g.docs.filter(x => x.classificacao === "ata");
    const pickMaisRecente = arr => arr.length
      ? arr.reduce((best, x) =>
          (!best || (x.data_publicacao || "") > (best.data_publicacao || "")) ? x : best, null)
      : null;
    g.convocacao     = pickMaisRecente(convs);
    g.ata            = pickMaisRecente(atas);
    // Resumo de ata: preferir o que tem mais % preenchidos. Varios docs podem
    // ser "ata" mas so um (termo de apuracao) traz numeros completos.
    g.ata_resumo = _melhorResumoAta(atas);
    // Pra ordenacao "convocada em": pega a data da convocacao mais antiga
    // (primeira convocacao). Faz mais sentido pro usuario do que a mais recente.
    g.data_publicacao = convs.length
      ? convs.reduce((acc, x) => (!acc || (x.data_publicacao || "") < acc) ? x.data_publicacao : acc, null)
      : (g.ata ? g.ata.data_publicacao : null);
    grupos.push(g);
  }
  return grupos;
}

function _melhorResumoAta(atas) {
  // Escolhe o resumo mais "rico" entre as atas do mesmo evento (cada uma tem
  // seu fnet_id, e pode ter resumo separado no atas_resumos.json).
  // Score: +10 se assembleia_realizada, +5 por % de aprovacao preenchido,
  // +3 por quorum, +1 por deliberacao. Empate -> prefere data_publicacao mais recente.
  let melhor = null, scoreMelhor = -1;
  for (const a of atas) {
    const r = _atasResumos[String(a.fnet_id)];
    if (!r) continue;
    let s = 0;
    if (r.assembleia_realizada) s += 10;
    if (r.quorum_instalacao_pct != null) s += 3;
    for (const d of (r.deliberacoes || [])) {
      s += 1;
      if (d.pct_aprovacao != null) s += 5;
    }
    if (s > scoreMelhor || (s === scoreMelhor && (a.data_publicacao || "") > (melhor?._doc?.data_publicacao || ""))) {
      melhor = { ...r, _doc: a };
      scoreMelhor = s;
    }
  }
  return melhor;
}

function aplicarFiltrosAssembleias() {
  const setor  = document.getElementById("filtro-setor")?.value || "";
  const ticker = (document.getElementById("filtro-ticker")?.value || "").toUpperCase().trim();
  const hojeIso = new Date().toISOString().slice(0, 10);

  const filtradas = _gruposAGE.filter(g => {
    if (setor && g.setor !== setor) return false;
    if (ticker && !(g.ticker || "").includes(ticker)) return false;
    return true;
  });

  const futuras  = filtradas.filter(g => (g.data_assembleia || "").slice(0,10) >  hojeIso);
  const passadas = filtradas.filter(g => (g.data_assembleia || "").slice(0,10) <= hojeIso);

  document.getElementById("count-futuras").textContent  = `${futuras.length}  AGE${futuras.length  !== 1 ? "s" : ""}`;
  document.getElementById("count-passadas").textContent = `${passadas.length} AGE${passadas.length !== 1 ? "s" : ""}`;

  _renderTabela("futuras",  _ordenar(futuras,  _ordemPorTab.futuras));
  _renderTabela("passadas", _ordenar(passadas, _ordemPorTab.passadas));
  _atualizarIconesOrdem();
}

function _ordenar(lista, { campo, direcao }) {
  const mult = direcao === "asc" ? 1 : -1;
  return [...lista].sort((a, b) => {
    let va = a[campo], vb = b[campo];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return -1 * mult;
    if (va > vb) return  1 * mult;
    return 0;
  });
}

function ordenarAGE(tab, campo) {
  const o = _ordemPorTab[tab];
  if (o.campo === campo) {
    o.direcao = o.direcao === "asc" ? "desc" : "asc";
  } else {
    o.campo = campo;
    o.direcao = "asc";
  }
  aplicarFiltrosAssembleias();
}

function _atualizarIconesOrdem() {
  for (const tab of ["futuras", "passadas"]) {
    const o = _ordemPorTab[tab];
    document.querySelectorAll(`#tabela-age-${tab} th[data-sort]`).forEach(th => {
      const ic = th.querySelector(".sort-icon");
      if (!ic) return;
      ic.textContent = (th.dataset.sort === o.campo)
        ? (o.direcao === "asc" ? "↑" : "↓")
        : "↕";
    });
  }
}

function _renderTabela(qual, lista) {
  const tbody = document.getElementById(`tabela-age-${qual}-body`);
  const colspan = qual === "futuras" ? 6 : 7;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="sim-vazio-msg">Nenhuma AGE no filtro.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(g => {
    const ticker = `<a href="fii.html?ticker=${g.ticker}" class="ticker-link" title="${(g.nome_fundo||'').replace(/"/g,'&quot;')}">${g.ticker}</a>`;
    const nome   = `<span title="${(g.nome_fundo||'').replace(/"/g,'&quot;')}">${truncarA(g.nome_fundo, 38)}</span>`;
    const linkConv = g.convocacao
      ? `<a href="${g.convocacao.url_fnet}" target="_blank" rel="noopener" class="link-fnet">PDF ↗</a>`
      : `<span class="sem-doc">—</span>`;
    if (qual === "futuras") {
      return `<tr>
        <td>${ticker}</td>
        <td>${nome}</td>
        <td>${g.setor || "—"}</td>
        <td class="num">${fmtDataHora(g.data_assembleia)}</td>
        <td class="num">${fmtDataHora(g.data_publicacao)}</td>
        <td>${linkConv}</td>
      </tr>`;
    }
    // passadas: + colunas Ata + Aprovacao
    const linkAta = g.ata
      ? `<a href="${g.ata.url_fnet}" target="_blank" rel="noopener" class="link-fnet">PDF ↗</a>`
      : `<span class="sem-doc" title="Administrador ainda não publicou ata ou usa outra categoria fnet">—</span>`;
    const aprov = _renderAprovacao(g);
    const rowAttr = g.ata_resumo
      ? ` class="age-row-clickable" onclick="abrirModalAta('${g.ticker}','${g.data_assembleia}')"`
      : "";
    return `<tr${rowAttr}>
      <td>${ticker}</td>
      <td>${nome}</td>
      <td>${g.setor || "—"}</td>
      <td class="num">${fmtDataHora(g.data_assembleia)}</td>
      <td>${linkConv}</td>
      <td>${linkAta}</td>
      <td>${aprov}</td>
    </tr>`;
  }).join("");
}

function _renderAprovacao(g) {
  if (!g.ata_resumo) {
    return g.ata
      ? `<span class="age-aprov-pendente" title="Parsing pendente">Pendente análise</span>`
      : `<span class="sem-doc">—</span>`;
  }
  const r = g.ata_resumo;
  if (!r.assembleia_realizada) {
    return `<span class="age-aprov-pendente" title="Doc da fnet não traz resultado">Não realizada</span>`;
  }
  const delibs = r.deliberacoes || [];
  if (!delibs.length) {
    return `<span class="age-aprov-pendente">—</span>`;
  }
  const cont = { aprovada:0, rejeitada:0, prejudicada:0, adiada:0, nao_apurada:0 };
  for (const d of delibs) cont[d.resultado] = (cont[d.resultado] || 0) + 1;
  // Caso simples: 1 deliberacao
  if (delibs.length === 1) {
    const d = delibs[0];
    const pct = d.pct_aprovacao != null ? ` (${d.pct_aprovacao.toFixed(1).replace('.0','')}%)` : "";
    return `<span class="age-aprov age-aprov-${d.resultado}">${_iconeResultado(d.resultado)}${_labelResultado(d.resultado)}${pct}</span>`;
  }
  // Caso multiplo: sumariza
  const todasAprov = delibs.every(d => d.resultado === "aprovada");
  const todasRej   = delibs.every(d => d.resultado === "rejeitada");
  if (todasAprov) return `<span class="age-aprov age-aprov-aprovada">✓ ${delibs.length} aprovadas</span>`;
  if (todasRej)   return `<span class="age-aprov age-aprov-rejeitada">✗ ${delibs.length} rejeitadas</span>`;
  const partes = [];
  if (cont.aprovada)    partes.push(`${cont.aprovada} aprov`);
  if (cont.rejeitada)   partes.push(`${cont.rejeitada} rej`);
  if (cont.prejudicada) partes.push(`${cont.prejudicada} prej`);
  if (cont.adiada)      partes.push(`${cont.adiada} adiada`);
  if (cont.nao_apurada) partes.push(`${cont.nao_apurada} s/info`);
  return `<span class="age-aprov age-aprov-misto">⚬ ${partes.join(" · ")}</span>`;
}

function _iconeResultado(r) {
  return { aprovada:"✓ ", rejeitada:"✗ ", prejudicada:"⊘ ", adiada:"⏸ ", nao_apurada:"? " }[r] || "";
}
function _labelResultado(r) {
  return { aprovada:"Aprovada", rejeitada:"Rejeitada", prejudicada:"Prejudicada", adiada:"Adiada", nao_apurada:"Sem %" }[r] || r;
}

function abrirModalAta(ticker, dataAssem) {
  const g = _gruposAGE.find(x => x.ticker === ticker && x.data_assembleia === dataAssem);
  if (!g || !g.ata_resumo) return;
  const r = g.ata_resumo;
  const dadosCabec = [
    `<strong>${g.ticker}</strong> · ${g.nome_fundo}`,
    `Assembleia em <strong>${fmtDataHora(g.data_assembleia)}</strong>`,
    r.quorum_instalacao_pct != null
      ? `Quórum de instalação: <strong>${r.quorum_instalacao_pct.toFixed(2).replace('.00','')}%</strong>`
      : "",
  ].filter(Boolean).join(" · ");

  const delibsHtml = (r.deliberacoes || []).map(d => {
    const pct = (label, val) => val != null
      ? `<span class="age-modal-pct">${label}: <strong>${val.toFixed(2).replace('.00','')}%</strong></span>`
      : "";
    return `<div class="age-modal-delib">
      <div class="age-modal-delib-cabec">
        <span class="age-aprov age-aprov-${d.resultado}">${_iconeResultado(d.resultado)}${_labelResultado(d.resultado)}</span>
        <span class="age-modal-delib-ordem">#${d.ordem}</span>
      </div>
      <p class="age-modal-delib-desc">${d.descricao || "—"}</p>
      <div class="age-modal-delib-pcts">
        ${pct("Aprovação", d.pct_aprovacao)}
        ${pct("Rejeição",  d.pct_rejeicao)}
        ${pct("Abstenção", d.pct_abstencao)}
      </div>
    </div>`;
  }).join("");

  const linkAtaModal = g.ata
    ? `<a href="${g.ata.url_fnet}" target="_blank" rel="noopener" class="link-fnet">Ver PDF da ata na fnet ↗</a>`
    : "";

  document.getElementById("modal-ata-conteudo").innerHTML = `
    <h3 class="age-modal-titulo">${dadosCabec}</h3>
    <p class="age-modal-resumo">${r.resumo || ""}</p>
    ${delibsHtml || '<p class="sim-vazio-msg">Sem deliberações apuradas.</p>'}
    <p class="age-modal-rodape">${linkAtaModal} · <span class="age-modal-meta">Tipo doc: ${r.tipo_documento || "—"} · Parseado por ${r.modelo || "Claude"}</span></p>
  `;
  document.getElementById("modal-ata").style.display = "flex";
}

function fecharModalAta(ev) {
  if (ev && ev.target.id !== "modal-ata") return;
  document.getElementById("modal-ata").style.display = "none";
}

function limparFiltrosAssembleias() {
  document.getElementById("filtro-setor").value  = "";
  document.getElementById("filtro-ticker").value = "";
  aplicarFiltrosAssembleias();
}

function fmtDataHora(s) {
  if (!s) return "—";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return s;
  const [, y, mo, d, hh, mm] = m;
  if (hh && (hh !== "00" || mm !== "00")) return `${d}/${mo}/${y} ${hh}:${mm}`;
  return `${d}/${mo}/${y}`;
}

function truncarA(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "");
}

async function atualizarAssembleias(btn) {
  const status = document.getElementById("atualizar-assembleias-status");
  if (btn) { btn.disabled = true; btn.textContent = "Coletando..."; }
  if (status) {
    status.textContent = "Pode levar 2-3 min (varre fnet completa)…";
    status.className = "atualizar-status atualizar-status-rodando";
  }
  try {
    const r = await fetch("/atualizar-assembleias", { method: "POST" });
    const d = await r.json();
    if (!d.ok) throw new Error(d.erro || "falhou");
    if (status) {
      status.textContent = `OK — ${d.total || 0} AGEs (${d.curados || 0} curados)`;
      status.className = "atualizar-status atualizar-status-ok";
    }
    await carregarAssembleias();
  } catch (e) {
    if (status) {
      status.textContent = "Erro: " + e.message;
      status.className = "atualizar-status atualizar-status-erro";
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Atualizar agora"; }
  }
}

carregarAssembleias();
